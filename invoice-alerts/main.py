# main.py — invoice-alerts
# Clean, production-lean FastAPI service for:
#  - creating alert rows from parsed invoices (/jobs/run_alerts, /jobs/run_alerts_next)
#  - flushing actionable alerts to Slack exactly once (/jobs/flush_alerts)
#  - browsing actionable alerts/invoices via API (/api/alerts, /api/invoices)
#
# Key guarantees:
#  - ONLY actionable alerts are created (fee_amount > 0 AND fee_name non-empty)
#  - Slack is sent ONLY for actionable alerts
#  - /api/alerts returns ONLY actionable alerts (legacy junk is filtered out)
#  - Legacy rows WITHOUT matched_line_items are self-healed during flush (recompute via rule_matches)
#  - /api/alerts is hardened: never returns 500 due to transient Supabase/doc lookups
#
# Anti-spam guarantee:
#  - flush_alerts uses a CLAIM step (pending->sending) so only 1 runner can send an alert.

import json
import os
import re
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import google.auth
import requests
from fastapi import FastAPI, HTTPException, Query
from google.auth.iam import Signer
from google.auth.transport.requests import Request as AuthRequest
from google.cloud import storage
from google.oauth2 import service_account

from rules import rule_matches
from supa import safe_insert, safe_select_in, safe_select_many, safe_select_one, safe_update, safe_update_where

app = FastAPI()

# ---------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------

# Tables
RULES_TABLE = os.getenv("RULES_TABLE", "invoice_alert_rules")
ALERTS_TABLE = os.getenv("ALERTS_TABLE", "invoice_alerts")
EVENTS_TABLE = os.getenv("EVENTS_TABLE", "invoice_alert_events")
PARSED_TABLE = os.getenv("PARSED_TABLE", "parsed_invoices")

# Documents table (for gcs_path)
DOCS_TABLE = os.getenv("DOCS_TABLE", "documents")

# Slack
SLACK_WEBHOOK_URL = os.getenv("SLACK_WEBHOOK_URL")

# Debug
DEBUG_ERRORS = os.getenv("DEBUG_ERRORS", "0").strip().lower() in ("1", "true", "yes")

# Signed URL settings (48 hours default)
SIGNED_URL_EXP_MINUTES = int(os.getenv("SIGNED_URL_EXP_MINUTES", "2880"))

# Optional override; otherwise auto-detect from metadata
SIGNING_SERVICE_ACCOUNT_EMAIL = os.getenv("SIGNING_SERVICE_ACCOUNT_EMAIL", "").strip()

# Documents lookup cache (per Cloud Run instance)
_DOC_CACHE_TTL_SEC = int(os.getenv("DOC_CACHE_TTL_SEC", "300"))
_doc_cache: Dict[str, Tuple[float, Dict[str, Any]]] = {}

# ---------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_json_loads(v: Any) -> Any:
    if v is None:
        return None
    if isinstance(v, (dict, list)):
        return v
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return None
        try:
            return json.loads(s)
        except Exception:
            return None
    return None


def _parse_line_items(raw: Any) -> List[Dict[str, Any]]:
    """
    line_items can be:
      - list[dict]
      - JSON string representing list[dict]
      - None
    """
    if raw is None:
        return []
    if isinstance(raw, list):
        return [x for x in raw if isinstance(x, dict)]
    if isinstance(raw, str):
        parsed = _safe_json_loads(raw)
        if isinstance(parsed, list):
            return [x for x in parsed if isinstance(x, dict)]
    return []


def _to_float(v: Any) -> Optional[float]:
    try:
        if v is None:
            return None
        if isinstance(v, (int, float)):
            return float(v)
        s = str(v).strip()
        if not s:
            return None
        s = s.replace(",", "").replace("$", "")
        return float(s)
    except Exception:
        return None


def _is_actionable_fee(fee_name: Optional[str], fee_amount: Any) -> bool:
    name_ok = bool((fee_name or "").strip())
    amt = _to_float(fee_amount)
    return name_ok and (amt is not None) and (amt > 0)


def _slack_post(payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    Posts to Slack webhook (if configured). Never crashes the job.
    Returns diagnostic info (safe to log).
    """
    if not SLACK_WEBHOOK_URL:
        return {"ok": False, "skipped": True, "reason": "SLACK_WEBHOOK_URL not set"}

    try:
        r = requests.post(SLACK_WEBHOOK_URL, json=payload, timeout=10)
        ok = 200 <= r.status_code < 300
        out: Dict[str, Any] = {"ok": ok, "status_code": r.status_code}
        if (not ok) and DEBUG_ERRORS:
            out["response_text"] = (r.text or "")[:500]
        return out
    except Exception as e:
        if DEBUG_ERRORS:
            return {"ok": False, "error": repr(e)}
        return {"ok": False, "error": "slack_post_failed"}


def _record_event(
    event_type: str,
    document_id: str,
    payload: Dict[str, Any],
    rule_id: Optional[str] = None,
    parsed_invoice_id: Optional[str] = None,
    slack_ts: Optional[str] = None,
) -> None:
    row: Dict[str, Any] = {
        "document_id": document_id,
        "fired_at": _utc_now(),
        "payload": {"event_type": event_type, **(payload or {})},
    }
    if rule_id:
        row["rule_id"] = rule_id
    if parsed_invoice_id:
        row["parsed_invoice_id"] = parsed_invoice_id
    if slack_ts:
        row["slack_ts"] = slack_ts

    try:
        safe_insert(EVENTS_TABLE, row)
    except Exception:
        return


def _is_rule_enabled(rule: Dict[str, Any]) -> bool:
    v = rule.get("is_enabled")
    if v is None:
        v = rule.get("enabled")
    return bool(v)


def _fetch_document_row(document_id: str) -> Dict[str, Any]:
    """
    Best-effort documents lookup:
      - Never throws
      - TTL caches hits and misses to avoid hammering Supabase
    """
    if not document_id:
        return {}

    now = time.time()

    cached = _doc_cache.get(document_id)
    if cached:
        ts, val = cached
        if now - ts < _DOC_CACHE_TTL_SEC:
            return val or {}
        _doc_cache.pop(document_id, None)

    try:
        doc = (
            safe_select_one(
                DOCS_TABLE,
                "id, attachment_filename, gcs_bucket, gcs_path, storage_provider, storage_bucket, storage_path, raw_file_url, created_at",
                eq={"id": document_id},
            )
            or {}
        )
        _doc_cache[document_id] = (now, doc)
        return doc
    except Exception as e:
        if DEBUG_ERRORS:
            _record_event("documents_lookup_error", str(document_id), {"error": repr(e)})
        _doc_cache[document_id] = (now, {})
        return {}


def _get_runtime_service_account_email() -> Optional[str]:
    """
    Gets the service account email for the Cloud Run revision.
    """
    if SIGNING_SERVICE_ACCOUNT_EMAIL:
        return SIGNING_SERVICE_ACCOUNT_EMAIL

    try:
        url = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email"
        r = requests.get(url, headers={"Metadata-Flavor": "Google"}, timeout=2)
        if r.status_code == 200:
            email = (r.text or "").strip()
            return email or None
    except Exception:
        pass

    return None


def _get_gcs_signed_url(gcs_bucket: str, gcs_path: str) -> Optional[str]:
    """
    Generate a V4 signed URL for a GCS object using IAM SignBlob on Cloud Run.
    Forces inline PDF render and uses correct expiration math.
    """
    if not gcs_bucket or not gcs_path:
        return None

    sa_email = _get_runtime_service_account_email()
    if not sa_email:
        if DEBUG_ERRORS:
            _record_event(
                "signed_url_error",
                "n/a",
                {"bucket": gcs_bucket, "path": gcs_path, "err": "missing_service_account_email"},
            )
        return None

    try:
        source_creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
        auth_req = AuthRequest()
        signer = Signer(auth_req, source_creds, sa_email)

        signing_creds = service_account.Credentials(
            signer=signer,
            service_account_email=sa_email,
            token_uri="https://oauth2.googleapis.com/token",
        )

        client = storage.Client(credentials=source_creds)
        bucket = client.bucket(gcs_bucket)
        blob = bucket.blob(gcs_path)

        url = blob.generate_signed_url(
            version="v4",
            expiration=SIGNED_URL_EXP_MINUTES * 60,  # minutes -> seconds
            method="GET",
            credentials=signing_creds,
            response_type="application/pdf",
            response_disposition='inline; filename="invoice.pdf"',
        )
        return url
    except Exception as e:
        if DEBUG_ERRORS:
            _record_event(
                "signed_url_error",
                "n/a",
                {"bucket": gcs_bucket, "path": gcs_path, "err": repr(e)},
            )
        return None


def _infer_airport_code(invoice: Dict[str, Any], doc: Optional[Dict[str, Any]] = None) -> Optional[str]:
    """
    Tries to infer airport_code if missing:
      1) parsed invoice airport_code
      2) vendor_name pattern "Vendor - BCT" (3-4 chars)
      3) filename/path patterns (prefix or embedded) using document row
    """
    a = (invoice.get("airport_code") or "").strip()
    if a:
        return a.upper()

    v = (invoice.get("vendor_name") or "").strip()
    if v:
        m = re.search(r"(?:-|–|—)\s*([A-Z0-9]{3,4})\b", v.upper())
        if m:
            return m.group(1)

    if doc:
        for key in (
            "attachment_filename",
            "filename",
            "file_name",
            "name",
            "original_filename",
            "gcs_path",
            "gcs_key",
            "storage_path",
            "path",
        ):
            s = (doc.get(key) or "").strip()
            if not s:
                continue
            base = s.split("/")[-1].upper()

            m = re.match(r"^([A-Z0-9]{3,4})[-_]", base)
            if m:
                return m.group(1)

            m = re.search(r"(?:^|[-_])([A-Z0-9]{3,4})(?:[-_])", base)
            if m:
                return m.group(1)

    return None


def _pick_fee_details(
    matched_line_items: List[Dict[str, Any]],
    fallback_fee_name: Optional[str],
    *,
    invoice: Optional[Dict[str, Any]] = None,
    rule_name: Optional[str] = None,
    charged_only: bool = False,
) -> Dict[str, Any]:
    """
    Fee selection strategy:
      - Prefer the first matched line item: description/name + total/amount/etc.
      - If charged_only=True, NEVER synthesize an amount from qty*unit_price.
        This prevents waived $0 items from appearing as charged in Slack / alerts.
      - If still missing and invoice fields exist: fallback to handling/service/surcharge by rule_name keyword
    """
    fee_name = fallback_fee_name or (rule_name or "Fee")
    fee_amount: Any = None

    li: Dict[str, Any] = {}
    if matched_line_items:
        li = matched_line_items[0] or {}
        fee_name = li.get("description") or li.get("name") or fee_name

        amount_keys = [
            "total",
            "amount",
            "line_total",
            "extended",
            "ext_amount",
            "value",
            "subtotal",
            "charge",
        ]
        for k in amount_keys:
            raw_val = li.get(k)
            val = _to_float(raw_val)
            if val is not None and val > 0:
                fee_amount = val
                break

        # IMPORTANT: Don't turn waived items into charged fees
        if (fee_amount in (None, "")) and (not charged_only):
            qty = _to_float(li.get("quantity") or li.get("qty"))
            unit = _to_float(li.get("unit_price") or li.get("rate") or li.get("price"))
            if qty is not None and unit is not None:
                fee_amount = round(qty * unit, 2)

    if (fee_amount in (None, "")) and invoice and rule_name:
        rn = (rule_name or "").lower()
        if "handling" in rn:
            if invoice.get("handling_fee") not in (None, ""):
                fee_amount = invoice.get("handling_fee")
                if not (fee_name or "").strip():
                    fee_name = "Handling Fee"
        elif "service" in rn:
            if invoice.get("service_fee") not in (None, ""):
                fee_amount = invoice.get("service_fee")
                if not (fee_name or "").strip():
                    fee_name = "Service Fee"
        elif "surcharge" in rn:
            if invoice.get("surcharge") not in (None, ""):
                fee_amount = invoice.get("surcharge")
                if not (fee_name or "").strip():
                    fee_name = "Surcharge"

    return {"fee_name": fee_name, "fee_amount": fee_amount}


def _build_slack_alert_payload(
    *,
    document_id: str,
    rule_name: str,
    fbo: str,
    airport_code: str,
    tail_number: Optional[str],
    fee_name: str,
    fee_amount: Any,
    currency: str,
    signed_pdf_url: Optional[str],
) -> Dict[str, Any]:
    tail = (tail_number or "—").strip() or "—"

    fee_amount_text = "—"
    amt = _to_float(fee_amount)
    if amt is not None and amt > 0:
        fee_amount_text = f"{amt} {currency}".strip()

    pdf_line = "—"
    if signed_pdf_url:
        pdf_line = f"<{signed_pdf_url}|Open PDF>"

    top_line = f"🚨 {fee_name} | {fbo} | {airport_code} | {tail}"

    return {
        "text": top_line,
        "blocks": [
            {"type": "header", "text": {"type": "plain_text", "text": "🚨 Fee Alert"}},
            {
                "type": "section",
                "fields": [
                    {"type": "mrkdwn", "text": f"*FBO:*\n{fbo}"},
                    {"type": "mrkdwn", "text": f"*Airport Code:*\n{airport_code}"},
                    {"type": "mrkdwn", "text": f"*Tail:*\n{tail}"},
                    {"type": "mrkdwn", "text": f"*Fee name:*\n{fee_name or '—'}"},
                    {"type": "mrkdwn", "text": f"*Fee amount:*\n{fee_amount_text}"},
                ],
            },
            {"type": "section", "text": {"type": "mrkdwn", "text": f"*PDF:*\n{pdf_line}"}},
            {
                "type": "context",
                "elements": [{"type": "mrkdwn", "text": f"Rule: `{rule_name}`  •  document_id: `{document_id}`"}],
            },
        ],
    }


# ---------------------------------------------------------------------
# Fetchers
# ---------------------------------------------------------------------


def _fetch_invoice(document_id: str) -> Dict[str, Any]:
    invoice = safe_select_one(
        PARSED_TABLE,
        "id, vendor_name, vendor_normalized, airport_code, doc_type, "
        "tail_number, currency, total, handling_fee, service_fee, surcharge, "
        "risk_score, review_required, line_items",
        eq={"document_id": document_id},
    )
    if not invoice:
        raise HTTPException(status_code=404, detail="parsed invoice not found")

    invoice["line_items"] = _parse_line_items(invoice.get("line_items"))
    return invoice


def _fetch_rules() -> List[Dict[str, Any]]:
    return (
        safe_select_many(
            RULES_TABLE,
            "id, name, is_enabled, enabled, keywords, "
            "min_handling_fee, min_service_fee, min_surcharge, "
            "min_total, min_risk_score, require_charged_line_items, "
            "vendor_normalized_in, doc_type_in, airport_code_in, "
            "require_review_required, slack_channel, slack_channel_id, slack_channel_name, created_at",
            limit=2000,
        )
        or []
    )


# ---------------------------------------------------------------------
# Debug / Health
# ---------------------------------------------------------------------


@app.get("/health")
def health() -> Dict[str, Any]:
    return {
        "ok": True,
        "service": "invoice-alerts",
        "ts": _utc_now(),
        "debug": DEBUG_ERRORS,
        "slack_configured": bool(SLACK_WEBHOOK_URL),
    }


if DEBUG_ERRORS:

    @app.get("/api/debug/document/{document_id}")
    def api_debug_document(document_id: str):
        doc = _fetch_document_row(document_id)
        return {"ok": True, "document_id": document_id, "doc": doc}


@app.post("/jobs/test_slack")
def test_slack() -> Dict[str, Any]:
    payload = {
        "text": "✅ invoice-alerts Slack test (manual)",
        "blocks": [
            {"type": "header", "text": {"type": "plain_text", "text": "✅ invoice-alerts Slack test"}},
            {"type": "section", "text": {"type": "mrkdwn", "text": f"*Service:* `invoice-alerts`\n*UTC:* `{_utc_now()}`"}},
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": f"*DEBUG_ERRORS:* `{1 if DEBUG_ERRORS else 0}`\n*Webhook configured:* `{True if SLACK_WEBHOOK_URL else False}`",
                },
            },
        ],
    }

    res = _slack_post(payload)
    _record_event("test_slack", "n/a", {"slack_result": res})
    return {"ok": True, "slack_result": res}


@app.post("/jobs/debug_alerts")
def debug_alerts(document_id: str) -> Dict[str, Any]:
    rows = (
        safe_select_many(
            ALERTS_TABLE,
            "id, created_at, document_id, rule_id, parsed_invoice_id, status, slack_status, slack_error, match_reason, match_payload",
            limit=500,
        )
        or []
    )

    rows = [r for r in rows if str(r.get("document_id")) == str(document_id)]
    rows = sorted(rows, key=lambda r: str(r.get("created_at") or ""))

    return {
        "ok": True,
        "document_id": document_id,
        "count": len(rows),
        "alerts": rows[:200],
    }


# ---------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------


@app.post("/jobs/run_alerts")
def run_alerts(document_id: str) -> Dict[str, Any]:
    """
    Runs all enabled rules against a single parsed invoice.

    Idempotent: unique(rule_id, parsed_invoice_id)

    Creates ONLY actionable alerts (fee_name present AND fee_amount > 0).
    If a legacy duplicate exists, upgrades it in-place instead of skipping forever.
    """
    try:
        invoice = _fetch_invoice(document_id)
        rules = _fetch_rules()

        matched_alerts = 0
        evaluated = 0
        matched_rules: List[Dict[str, Any]] = []

        for rule in rules:
            if not _is_rule_enabled(rule):
                continue

            evaluated += 1

            result = rule_matches(rule, invoice)
            if not result.matched:
                continue

            # Determine actionable fee using matched line items
            fee_probe = _pick_fee_details(
                result.matched_line_items or [],
                fallback_fee_name=rule.get("name"),
                invoice=invoice,
                rule_name=rule.get("name"),
                charged_only=True,
            )

            fee_name = (fee_probe.get("fee_name") or "").strip() or None
            fee_amount = _to_float(fee_probe.get("fee_amount"))

            # ACTIONABLE ONLY
            if not fee_name or fee_amount is None or fee_amount <= 0:
                continue

            alert_row = {
                "created_at": _utc_now(),
                "document_id": document_id,
                "rule_id": rule.get("id"),
                "parsed_invoice_id": invoice.get("id"),
                "status": "pending",
                "match_reason": result.reason,
                "match_payload": {
                    "matched_keywords": result.matched_keywords,
                    "matched_line_items": result.matched_line_items,
                    "rule_name": rule.get("name"),
                },
                "slack_status": "pending",
            }

            try:
                inserted = safe_insert(ALERTS_TABLE, alert_row)
                if inserted:
                    matched_alerts += 1

                    if DEBUG_ERRORS:
                        matched_rules.append(
                            {
                                "rule_id": rule.get("id"),
                                "rule_name": rule.get("name"),
                                "reason": result.reason,
                                "matched_keywords": result.matched_keywords,
                                "matched_line_items_count": len(result.matched_line_items or []),
                            }
                        )

                    _record_event(
                        "alert_created",
                        document_id,
                        {"rule_id": rule.get("id"), "rule_name": rule.get("name")},
                        rule_id=rule.get("id"),
                        parsed_invoice_id=invoice.get("id"),
                    )

            except Exception as e:
                msg = repr(e)

                # DUPLICATE → UPGRADE IN PLACE
                if "23505" in msg or "duplicate key value violates unique constraint" in msg:
                    try:
                        existing = safe_select_one(
                            ALERTS_TABLE,
                            "id, slack_status, slack_error, match_payload",
                            eq={"rule_id": rule.get("id"), "parsed_invoice_id": invoice.get("id")},
                        ) or {}

                        if existing.get("id"):
                            existing_payload = _safe_json_loads(existing.get("match_payload")) or {}

                            existing_payload.update(
                                {
                                    "rule_name": rule.get("name"),
                                    "matched_keywords": result.matched_keywords,
                                    "matched_line_items": result.matched_line_items,
                                }
                            )

                            fee_probe2 = _pick_fee_details(
                                result.matched_line_items or [],
                                fallback_fee_name=rule.get("name"),
                                invoice=invoice,
                                rule_name=rule.get("name"),
                                charged_only=True,
                            )

                            fee_name2 = (fee_probe2.get("fee_name") or "").strip() or None
                            fee_amount2 = _to_float(fee_probe2.get("fee_amount"))
                            is_actionable = bool(fee_name2) and fee_amount2 is not None and fee_amount2 > 0

                            safe_update(
                                ALERTS_TABLE,
                                existing["id"],
                                {
                                    "match_payload": existing_payload,
                                    "match_reason": result.reason,
                                    "slack_status": "pending" if is_actionable else existing.get("slack_status"),
                                    "slack_error": None if is_actionable else existing.get("slack_error"),
                                },
                            )

                            _record_event(
                                "alert_upgraded",
                                document_id,
                                {"rule_id": rule.get("id"), "rule_name": rule.get("name"), "actionable": is_actionable},
                                rule_id=rule.get("id"),
                                parsed_invoice_id=invoice.get("id"),
                            )

                    except Exception as upgrade_err:
                        _record_event(
                            "alert_upgrade_failed",
                            document_id,
                            {"rule_id": rule.get("id"), "error": repr(upgrade_err)},
                            rule_id=rule.get("id"),
                            parsed_invoice_id=invoice.get("id"),
                        )

                    continue

                raise

        _record_event(
            "run_alerts",
            document_id,
            {"matched_alerts": matched_alerts, "evaluated_rules": evaluated},
            parsed_invoice_id=invoice.get("id"),
        )

        return {
            "ok": True,
            "document_id": document_id,
            "matched_alerts": matched_alerts,
            "evaluated_rules": evaluated,
            "matched_rules": matched_rules if DEBUG_ERRORS else None,
        }

    except HTTPException:
        raise
    except Exception as e:
        _record_event("run_alerts_error", document_id, {"error": repr(e)})
        if DEBUG_ERRORS:
            raise HTTPException(status_code=500, detail=f"run_alerts failed: {repr(e)}")
        raise HTTPException(status_code=500, detail="run_alerts failed")


@app.post("/jobs/run_alerts_next")
def run_alerts_next(limit: int = 5, lookback_minutes: int = 240) -> Dict[str, Any]:
    """
    Runs /jobs/run_alerts against the most recent parsed invoices.
    NOTE: lookback_minutes is currently unused (safe_select_many is limited).
    """
    try:
        limit = max(1, min(int(limit), 50))

        rows = safe_select_many(PARSED_TABLE, "document_id, created_at", limit=max(limit, 50)) or []
        rows = sorted(rows, key=lambda r: str(r.get("created_at") or ""), reverse=True)

        ran = 0
        results: List[Dict[str, Any]] = []
        for r in rows:
            doc_id = r.get("document_id")
            if not doc_id:
                continue
            results.append(run_alerts(doc_id))
            ran += 1
            if ran >= limit:
                break

        return {"ok": True, "ran": ran, "results": results}

    except HTTPException:
        raise
    except Exception as e:
        _record_event("run_alerts_next_error", "n/a", {"error": repr(e)})
        if DEBUG_ERRORS:
            raise HTTPException(status_code=500, detail=f"run_alerts_next failed: {repr(e)}")
        raise HTTPException(status_code=500, detail="run_alerts_next failed")


@app.post("/jobs/flush_alerts")
def flush_alerts(limit: int = 25) -> Dict[str, Any]:
    """
    Sends Slack exactly once per alert row by transitioning slack_status:
      pending -> sending -> sent OR pending -> sending -> error OR pending -> sending -> skipped

    The key is the CLAIM step (pending->sending) so only ONE runner can send each alert.
    """
    try:
        limit = max(1, min(int(limit), 100))

        # Load rules once (needed to self-heal legacy rows)
        rules = _fetch_rules()
        rules_by_id: Dict[str, Dict[str, Any]] = {str(r.get("id")): r for r in (rules or [])}

        rows = safe_select_many(
            ALERTS_TABLE,
            "id, created_at, rule_id, document_id, parsed_invoice_id, status, slack_status, slack_error, match_payload",
            limit=500,
        ) or []

        rows = sorted(rows, key=lambda r: str(r.get("created_at") or ""))  # oldest first

        sent = 0
        errored = 0
        skipped = 0
        processed: List[Dict[str, Any]] = []

        for a in rows:
            if sent + errored >= limit:
                break

            alert_id = a.get("id")
            if not alert_id:
                continue

            # --- fast skip ---
            slack_status = (a.get("slack_status") or "").strip().lower()
            if slack_status in ("sent", "ok", "success"):
                continue
            if slack_status not in ("", "pending", "null"):
                # includes "error", "skipped", "sending"
                continue

            # ------------------------------------------------------------------
            # AUTO-HEAL: status says sent, but slack_status is still pending
            # (this exact mismatch is what causes repeated sends)
            # ------------------------------------------------------------------
            if str(a.get("status") or "").lower() == "sent" and slack_status in ("", "pending", "null"):
                try:
                    safe_update(ALERTS_TABLE, alert_id, {"slack_status": "sent", "slack_error": None})
                except Exception:
                    pass
                continue

            # ------------------------------------------------------------------
            # CLAIM: atomically move pending -> sending
            # If another worker already claimed it, updated will be 0 and we skip.
            # ------------------------------------------------------------------
            claimed = 0
            try:
                claimed = int(
                    safe_update_where(
                        ALERTS_TABLE,
                        {"slack_status": "sending", "slack_error": None},
                        eq={"id": alert_id, "slack_status": "pending"},
                    )
                )
            except Exception as e:
                if DEBUG_ERRORS:
                    _record_event("flush_claim_error", str(a.get("document_id") or "n/a"), {"error": repr(e), "alert_id": alert_id})
                continue

            if claimed != 1:
                continue  # someone else is processing or it changed

            document_id = a.get("document_id")
            if not document_id:
                skipped += 1
                try:
                    safe_update(ALERTS_TABLE, alert_id, {"slack_status": "skipped", "slack_error": "missing_document_id"})
                except Exception:
                    pass
                continue

            invoice = _fetch_invoice(document_id)
            doc = _fetch_document_row(document_id)

            signed_pdf_url = None
            if doc:
                signed_pdf_url = _get_gcs_signed_url(doc.get("gcs_bucket") or "", doc.get("gcs_path") or "")

            mp = _safe_json_loads(a.get("match_payload")) or {}

            rule_id = str(a.get("rule_id") or "")
            rule = rules_by_id.get(rule_id) if rule_id else None
            rule_name = (mp.get("rule_name") or (rule or {}).get("name") or "Fee")
            charged_only = bool((rule or {}).get("require_charged_line_items"))

            matched_line_items = mp.get("matched_line_items")
            if isinstance(matched_line_items, str):
                matched_line_items = _safe_json_loads(matched_line_items)
            if not isinstance(matched_line_items, list) or len(matched_line_items) == 0:
                # Legacy self-heal via rule_matches
                if rule:
                    try:
                        res = rule_matches(rule, invoice)
                        if res.matched:
                            matched_line_items = res.matched_line_items or []
                            try:
                                new_mp = {**(mp or {})}
                                new_mp["rule_name"] = rule_name
                                new_mp["matched_keywords"] = res.matched_keywords
                                new_mp["matched_line_items"] = matched_line_items
                                safe_update(ALERTS_TABLE, alert_id, {"match_payload": new_mp})
                                mp = new_mp
                            except Exception:
                                pass
                        else:
                            matched_line_items = []
                    except Exception:
                        matched_line_items = []
                else:
                    matched_line_items = []

            fee = _pick_fee_details(
                matched_line_items or [],
                fallback_fee_name=rule_name,
                invoice=invoice,
                rule_name=rule_name,
                charged_only=charged_only,
            )
            fee_name = (fee.get("fee_name") or "").strip() or None
            fee_amount = _to_float(fee.get("fee_amount"))

            # ACTIONABLE ONLY
            if not fee_name or fee_amount is None or fee_amount <= 0:
                safe_update(
                    ALERTS_TABLE,
                    alert_id,
                    {
                        "slack_status": "skipped",
                        "slack_error": "non_actionable_missing_fee",
                        "status": a.get("status") or "pending",
                    },
                )
                skipped += 1
                if DEBUG_ERRORS:
                    processed.append({"id": alert_id, "document_id": document_id, "slack_status": "skipped"})
                continue

            fbo = invoice.get("vendor_name") or "—"
            airport = _infer_airport_code(invoice, doc) or "—"
            tail = invoice.get("tail_number") or "—"
            currency = invoice.get("currency") or ""

            slack_payload = _build_slack_alert_payload(
                document_id=document_id,
                rule_name=rule_name,
                fbo=fbo,
                airport_code=airport,
                tail_number=tail,
                fee_name=fee_name,
                fee_amount=fee_amount,
                currency=currency,
                signed_pdf_url=signed_pdf_url,
            )

            slack_res = _slack_post(slack_payload)

            if slack_res.get("ok"):
                safe_update(
                    ALERTS_TABLE,
                    alert_id,
                    {"slack_status": "sent", "slack_error": None, "status": a.get("status") or "pending"},
                )
                sent += 1
                if DEBUG_ERRORS:
                    processed.append({"id": alert_id, "document_id": document_id, "slack_status": "sent"})
                _record_event("alert_slack_sent", document_id, {"alert_id": alert_id, "slack_result": slack_res})
            else:
                safe_update(
                    ALERTS_TABLE,
                    alert_id,
                    {
                        "slack_status": "error",
                        "slack_error": json.dumps(slack_res)[:1000],
                        "status": a.get("status") or "pending",
                    },
                )
                errored += 1
                if DEBUG_ERRORS:
                    processed.append({"id": alert_id, "document_id": document_id, "slack_status": "error"})
                _record_event("alert_slack_error", document_id, {"alert_id": alert_id, "slack_result": slack_res})

        return {
            "ok": True,
            "limit": limit,
            "sent": sent,
            "errored": errored,
            "skipped": skipped,
            "processed": processed if DEBUG_ERRORS else None,
        }

    except HTTPException:
        raise
    except Exception as e:
        _record_event("flush_alerts_error", "n/a", {"error": repr(e)})
        if DEBUG_ERRORS:
            raise HTTPException(status_code=500, detail=f"flush_alerts failed: {repr(e)}")
        raise HTTPException(status_code=500, detail="flush_alerts failed")


@app.post("/jobs/debug_rule_match")
def debug_rule_match(document_id: str, rule_id: Optional[str] = None, rule_name: Optional[str] = None) -> Dict[str, Any]:
    invoice = _fetch_invoice(document_id)
    rules = _fetch_rules()

    if rule_id:
        rules = [r for r in rules if str(r.get("id")) == str(rule_id)]
    if rule_name:
        rules = [r for r in rules if (r.get("name") or "").lower() == rule_name.lower()]

    line_descs = [(li.get("description") or li.get("name") or "").strip() for li in (invoice.get("line_items") or [])][:50]

    out: List[Dict[str, Any]] = []
    for rule in rules:
        enabled = _is_rule_enabled(rule)
        if not enabled:
            out.append(
                {
                    "rule_id": rule.get("id"),
                    "name": rule.get("name"),
                    "enabled": False,
                    "matched": False,
                    "reason": "disabled",
                    "keywords": rule.get("keywords"),
                }
            )
            continue

        res = rule_matches(rule, invoice)
        out.append(
            {
                "rule_id": rule.get("id"),
                "name": rule.get("name"),
                "enabled": True,
                "matched": res.matched,
                "reason": res.reason,
                "matched_keywords": res.matched_keywords,
                "matched_line_items_count": len(res.matched_line_items or []),
                "keywords": rule.get("keywords"),
            }
        )

    return {
        "ok": True,
        "document_id": document_id,
        "invoice": {
            "parsed_invoice_id": invoice.get("id"),
            "vendor_name": invoice.get("vendor_name"),
            "vendor_normalized": invoice.get("vendor_normalized"),
            "airport_code": invoice.get("airport_code"),
            "doc_type": invoice.get("doc_type"),
            "total": invoice.get("total"),
            "review_required": invoice.get("review_required"),
            "line_item_descriptions_sample": line_descs,
        },
        "rules_checked": len(out),
        "results": out,
    }


# ---------------------------------------------------------------------
# API: Invoices
# ---------------------------------------------------------------------


@app.get("/api/invoices")
def api_invoices(
    limit: int = Query(50, ge=1, le=200),
    vendor: Optional[str] = None,
    doc_type: Optional[str] = None,
    review_required: Optional[bool] = None,
) -> Dict[str, Any]:
    """
    Returns ALL parsed invoices.
    Line items excluded here (detail view only).
    """
    rows = safe_select_many(
        PARSED_TABLE,
        "id, document_id, created_at, vendor_name, invoice_number, "
        "invoice_date, airport_code, tail_number, currency, total, "
        "doc_type, review_required, risk_score, line_items",
        limit=1000,
    ) or []

    if vendor:
        rows = [r for r in rows if vendor.lower() in (r.get("vendor_name") or "").lower()]
    if doc_type:
        rows = [r for r in rows if (r.get("doc_type") or "") == doc_type]
    if review_required is not None:
        rows = [r for r in rows if bool(r.get("review_required")) == review_required]

    rows = sorted(rows, key=lambda r: str(r.get("created_at") or ""), reverse=True)[: int(limit)]

    for r in rows:
        r["has_line_items"] = bool(_parse_line_items(r.get("line_items")))
        r.pop("line_items", None)

    return {"ok": True, "count": len(rows), "invoices": rows}


@app.get("/api/invoices/{document_id}")
def api_invoice_detail(document_id: str) -> Dict[str, Any]:
    """
    Returns full invoice detail including line_items and signed PDF URL.
    """
    invoice = safe_select_one(PARSED_TABLE, "*", eq={"document_id": document_id})
    if not invoice:
        raise HTTPException(status_code=404, detail="invoice not found")

    invoice["line_items"] = _parse_line_items(invoice.get("line_items"))

    doc = _fetch_document_row(document_id)
    signed_pdf_url = None
    if doc:
        signed_pdf_url = _get_gcs_signed_url(doc.get("gcs_bucket") or "", doc.get("gcs_path") or "")

    return {"ok": True, "invoice": invoice, "signed_pdf_url": signed_pdf_url}


# ---------------------------------------------------------------------
# API: Alerts (ACTIONABLE ONLY, HARDENED)
# ---------------------------------------------------------------------


@app.get("/api/alerts")
def api_alerts(
    limit: int = Query(100, ge=1, le=500),
    q: Optional[str] = None,
    status: Optional[str] = None,
    slack_status: Optional[str] = None,
) -> Dict[str, Any]:
    """
    ACTIONABLE ONLY:
      - fee_name present AND fee_amount > 0

    HARDENED:
      - Never returns 500 (returns empty list on upstream read errors)
      - Per-row errors never crash the endpoint
      - Avoids extra Supabase reads unless necessary
      - Documents lookup is only done when airport_code is missing
    """
    qn = (q or "").strip().lower()
    limit = max(1, min(int(limit), 500))

    try:
        rows = safe_select_many(
            ALERTS_TABLE,
            "id, created_at, document_id, rule_id, status, slack_status, match_payload",
            limit=2000,
        ) or []
    except Exception as e:
        if DEBUG_ERRORS:
            _record_event("api_alerts_query_error", "n/a", {"error": repr(e)})
        return {"ok": True, "count": 0, "alerts": []}

    rules = _fetch_rules()
    rules_by_id: Dict[str, Dict[str, Any]] = {str(r.get("id")): r for r in (rules or [])}

    # ── Pass 1: parse each row, drop non-actionable without hitting the DB ──
    candidates = []
    for r in rows:
        try:
            mp = _safe_json_loads(r.get("match_payload")) or {}
            document_id = r.get("document_id")

            rule_id = str(r.get("rule_id") or "")
            rule = rules_by_id.get(rule_id) if rule_id else None
            rule_name = mp.get("rule_name") or (rule or {}).get("name") or None
            charged_only = bool((rule or {}).get("require_charged_line_items"))

            matched_line_items = mp.get("matched_line_items") or []
            if isinstance(matched_line_items, str):
                matched_line_items = _safe_json_loads(matched_line_items) or []
            if not isinstance(matched_line_items, list):
                matched_line_items = []

            fee_probe = _pick_fee_details(
                matched_line_items,
                fallback_fee_name=rule_name,
                invoice=None,
                rule_name=rule_name,
                charged_only=charged_only,
            )
            fee_name = (fee_probe.get("fee_name") or "").strip() or None
            fee_amount = _to_float(fee_probe.get("fee_amount"))

            if not _is_actionable_fee(fee_name, fee_amount):
                continue

            candidates.append((r, mp, rule_name, charged_only, matched_line_items, fee_name, fee_amount))
        except Exception as e:
            if DEBUG_ERRORS:
                _record_event("api_alerts_row_error", str(r.get("document_id") or "n/a"), {"error": repr(e), "alert_id": r.get("id")})
            continue

    # ── Batch fetch all needed parsed invoices in one query ──────────────────
    doc_ids = list({r.get("document_id") for r, *_ in candidates if r.get("document_id")})
    invoices_by_doc: Dict[str, Dict[str, Any]] = {}
    if doc_ids:
        try:
            invoice_rows = safe_select_in(
                PARSED_TABLE,
                "document_id, vendor_name, tail_number, airport_code, currency, handling_fee, service_fee, surcharge",
                "document_id",
                doc_ids,
            )
            invoices_by_doc = {row["document_id"]: row for row in invoice_rows if row.get("document_id")}
        except Exception as e:
            if DEBUG_ERRORS:
                _record_event("api_alerts_batch_invoice_error", "n/a", {"error": repr(e)})

    # ── Pass 2: apply invoice data and build output rows ─────────────────────
    out: List[Dict[str, Any]] = []
    for r, mp, rule_name, charged_only, matched_line_items, fee_name, fee_amount in candidates:
        try:
            document_id = r.get("document_id")
            invoice = invoices_by_doc.get(document_id) if document_id else None

            if invoice:
                fee2 = _pick_fee_details(
                    matched_line_items,
                    fallback_fee_name=rule_name,
                    invoice=invoice,
                    rule_name=rule_name,
                    charged_only=charged_only,
                )
                fee_name2 = (fee2.get("fee_name") or "").strip() or None
                fee_amount2 = _to_float(fee2.get("fee_amount"))

                if not _is_actionable_fee(fee_name2, fee_amount2):
                    continue

                fee_name, fee_amount = fee_name2, fee_amount2

            vendor = (invoice or {}).get("vendor_name") or mp.get("vendor") or mp.get("fbo") or None
            tail = (invoice or {}).get("tail_number") or mp.get("tail") or None
            currency = (invoice or {}).get("currency") or mp.get("currency") or None

            airport_code = (invoice or {}).get("airport_code") or mp.get("airport_code") or None
            if not airport_code:
                doc = _fetch_document_row(document_id) if document_id else None
                airport_code = _infer_airport_code(invoice or {}, doc)

            row = {
                "id": r.get("id"),
                "created_at": r.get("created_at"),
                "document_id": document_id,
                "status": r.get("status"),
                "slack_status": r.get("slack_status"),
                "rule_name": rule_name,
                "vendor": vendor,
                "tail": tail,
                "airport_code": airport_code,
                "fee_name": fee_name,
                "fee_amount": _to_float(fee_amount),
                "currency": currency,
            }

            if status and str(row.get("status") or "").lower() != status.lower():
                continue
            if slack_status and str(row.get("slack_status") or "").lower() != slack_status.lower():
                continue

            if qn:
                hay = " ".join(
                    [
                        str(row.get("document_id") or ""),
                        str(row.get("rule_name") or ""),
                        str(row.get("vendor") or ""),
                        str(row.get("tail") or ""),
                        str(row.get("airport_code") or ""),
                        str(row.get("fee_name") or ""),
                    ]
                ).lower()
                if qn not in hay:
                    continue

            out.append(row)

        except Exception as e:
            if DEBUG_ERRORS:
                _record_event("api_alerts_row_error", str(r.get("document_id") or "n/a"), {"error": repr(e), "alert_id": r.get("id")})
            continue

    out = sorted(out, key=lambda x: str(x.get("created_at") or ""), reverse=True)[:limit]
    return {"ok": True, "count": len(out), "alerts": out}
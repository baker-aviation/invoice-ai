import json
import os
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import requests
from fastapi import FastAPI, HTTPException

from rules import rule_matches
from supa import safe_insert, safe_select_many, safe_select_one, safe_update

# signed URL support
from google.cloud import storage

# sign URLs on Cloud Run using IAM SignBlob (no local private key)
import google.auth
from google.auth.iam import Signer
from google.auth.transport.requests import Request as AuthRequest
from google.oauth2 import service_account

app = FastAPI()

# Tables
RULES_TABLE = os.getenv("RULES_TABLE", "invoice_alert_rules")
ALERTS_TABLE = os.getenv("ALERTS_TABLE", "invoice_alerts")
EVENTS_TABLE = os.getenv("EVENTS_TABLE", "invoice_alert_events")
PARSED_TABLE = os.getenv("PARSED_TABLE", "parsed_invoices")

# documents table (for gcs_path)
DOCS_TABLE = os.getenv("DOCS_TABLE", "documents")

# Slack
SLACK_WEBHOOK_URL = os.getenv("SLACK_WEBHOOK_URL")

# Debug
DEBUG_ERRORS = os.getenv("DEBUG_ERRORS", "0").strip() in ("1", "true", "True", "yes", "YES")

# signed URL settings (48 hours default)
SIGNED_URL_EXP_MINUTES = int(os.getenv("SIGNED_URL_EXP_MINUTES", "2880"))

# optional override; otherwise we auto-detect from metadata
SIGNING_SERVICE_ACCOUNT_EMAIL = os.getenv("SIGNING_SERVICE_ACCOUNT_EMAIL", "").strip()

if DEBUG_ERRORS:
    @app.get("/api/debug/document/{document_id}")
    def api_debug_document(document_id: str):
        doc = _fetch_document_row(document_id)
        return {"ok": True, "document_id": document_id, "doc": doc}

@app.post("/jobs/debug_alerts")
def debug_alerts(document_id: str) -> Dict[str, Any]:
    rows = safe_select_many(
        ALERTS_TABLE,
        "id, created_at, document_id, rule_id, parsed_invoice_id, status, slack_status, slack_error, match_reason, match_payload",
        limit=500,
    ) or []

    rows = [r for r in rows if str(r.get("document_id")) == str(document_id)]
    rows = sorted(rows, key=lambda r: str(r.get("created_at") or ""))

    return {
        "ok": True,
        "document_id": document_id,
        "count": len(rows),
        "alerts": rows[:200],
    }


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
        out = {"ok": ok, "status_code": r.status_code}
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


def _fetch_document_row(document_id: str) -> Optional[Dict[str, Any]]:
    if not document_id:
        return None

    # Try the common patterns (depending on how your documents table is keyed)
    doc = safe_select_one(
        DOCS_TABLE,
        "id, document_id, attachment_filename, gcs_bucket, gcs_path, storage_provider, storage_bucket, storage_path, raw_file_url, created_at",
        eq={"id": document_id},
    )
    if doc:
        return doc

    doc = safe_select_one(
        DOCS_TABLE,
        "id, document_id, attachment_filename, gcs_bucket, gcs_path, storage_provider, storage_bucket, storage_path, raw_file_url, created_at",
        eq={"document_id": document_id},
    )
    if doc:
        return doc

    return None


# get the runtime service account email (Cloud Run metadata)
def _get_runtime_service_account_email() -> Optional[str]:
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


# REQUIRED CHANGE #1: sign URLs correctly + correct expiration math + force PDF render
def _get_gcs_signed_url(gcs_bucket: str, gcs_path: str) -> Optional[str]:
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
            expiration=SIGNED_URL_EXP_MINUTES * 60,  # <-- FIX (was minutes*2880)
            method="GET",
            credentials=signing_creds,
            response_type="application/pdf",
            response_disposition='inline; filename="invoice.pdf"',
        )
        return url
    except Exception as e:
        _record_event(
            "signed_url_error",
            "n/a",
            {"bucket": gcs_bucket, "path": gcs_path, "err": repr(e)},
        )
        return None


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


def _pick_fee_details(
    matched_line_items: List[Dict[str, Any]],
    fallback_fee_name: Optional[str],
    *,
    invoice: Optional[Dict[str, Any]] = None,
    rule_name: Optional[str] = None,
) -> Dict[str, Any]:
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

        if fee_amount in (None, ""):
            qty = _to_float(li.get("quantity") or li.get("qty"))
            unit = _to_float(li.get("unit_price") or li.get("rate") or li.get("price"))
            if qty is not None and unit is not None:
                fee_amount = round(qty * unit, 2)

    if (fee_amount in (None, "")) and invoice and rule_name:
        rn = (rule_name or "").lower()
        if "handling" in rn:
            if invoice.get("handling_fee") not in (None, ""):
                fee_amount = invoice.get("handling_fee")
        elif "service" in rn:
            if invoice.get("service_fee") not in (None, ""):
                fee_amount = invoice.get("service_fee")
        elif "surcharge" in rn:
            if invoice.get("surcharge") not in (None, ""):
                fee_amount = invoice.get("surcharge")

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
    if fee_amount is not None and fee_amount != "":
        fee_amount_text = f"{fee_amount} {currency}".strip()

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
            {"type": "context", "elements": [{"type": "mrkdwn", "text": f"Rule: `{rule_name}`  •  document_id: `{document_id}`"}]},
        ],
    }


# ---------------------------------------------------------------------
# Fetchers
# ---------------------------------------------------------------------

def _fetch_invoice(document_id: str) -> Dict[str, Any]:
    invoice = safe_select_one(
        PARSED_TABLE,
        "id, document_id, vendor_name, vendor_normalized, airport_code, doc_type, "
        "tail_number, currency, total, handling_fee, service_fee, surcharge, "
        "risk_score, review_required, line_items",
        eq={"document_id": document_id},
    )
    if not invoice:
        raise HTTPException(status_code=404, detail="parsed invoice not found")

    invoice["line_items"] = _parse_line_items(invoice.get("line_items"))
    return invoice


def _fetch_rules() -> List[Dict[str, Any]]:
    return safe_select_many(
        RULES_TABLE,
        "id, name, is_enabled, enabled, keywords, "
        "min_handling_fee, min_service_fee, min_surcharge, "
        "min_total, min_risk_score, "
        "vendor_normalized_in, doc_type_in, airport_code_in, "
        "require_review_required, slack_channel, slack_channel_id, slack_channel_name, created_at",
        limit=2000,
    )


# ---------------------------------------------------------------------
# Routes
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


@app.post("/jobs/run_alerts")
def run_alerts(document_id: str) -> Dict[str, Any]:
    """
    Runs all enabled rules against a single parsed invoice.

    Idempotent: skips duplicate inserts when unique(rule_id, parsed_invoice_id) already exists.

    Does NOT post to Slack. Slack is sent by /jobs/flush_alerts.
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

            # REQUIRED: compute result before using it
            result = rule_matches(rule, invoice)
            if not result.matched:
                continue

            # REQUIRED: block $0 / missing-amount alerts (uses same logic as Slack)
            fee_probe = _pick_fee_details(
                result.matched_line_items or [],
                fallback_fee_name=rule.get("name"),
                invoice=invoice,
                rule_name=rule.get("name"),
            )
            amt = _to_float(fee_probe.get("fee_amount"))
            if amt is None or amt <= 0:
                # skip creating alerts that would show $0 or —
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

                # Idempotency: if unique(rule_id, parsed_invoice_id) already exists, skip
                if "23505" in msg or "duplicate key value violates unique constraint" in msg:
                    _record_event(
                        "alert_duplicate_skipped",
                        document_id,
                        {"rule_id": rule.get("id"), "rule_name": rule.get("name")},
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
        payload = {"error": repr(e)}
        _record_event("run_alerts_error", document_id, payload)
        if DEBUG_ERRORS:
            raise HTTPException(status_code=500, detail=f"run_alerts failed: {repr(e)}")
        raise HTTPException(status_code=500, detail="run_alerts failed")

def _infer_airport_code(invoice: Dict[str, Any], doc: Optional[Dict[str, Any]] = None) -> Optional[str]:
    # 1) If parser gave airport_code, trust it
    a = (invoice.get("airport_code") or "").strip()
    if a:
        return a.upper()

    # 2) Try vendor_name like "Signature Aviation - BCT"
    v = (invoice.get("vendor_name") or "").strip()
    if v:
        m = re.search(r"(?:-|–|—)\s*([A-Z0-9]{3,4})\b", v.upper())
        if m:
            return m.group(1)

    # 3) Try filename/path like "BCT-C-P-54-0068200.pdf"
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

            # match "BCT-..." or "BCT_..."
            m = re.match(r"^([A-Z0-9]{3,4})[-_]", base)
            if m:
                return m.group(1)

            # match "...-BCT-..." (airport embedded later)
            m = re.search(r"(?:^|[-_])([A-Z0-9]{3,4})(?:[-_])", base)
            if m:
                return m.group(1)

    return None


@app.post("/jobs/flush_alerts")
def flush_alerts(limit: int = 25) -> Dict[str, Any]:
    """
    Sends Slack exactly once per alert row by transitioning slack_status:
      pending -> sent OR pending -> error
    """
    try:
        limit = max(1, min(int(limit), 100))

        rows = safe_select_many(
            ALERTS_TABLE,
            "id, created_at, rule_id, document_id, parsed_invoice_id, status, slack_status, slack_error, match_payload",
            limit=500,
        ) or []

        # Oldest first so alerts send in order
        rows = sorted(rows, key=lambda r: str(r.get("created_at") or ""))

        sent = 0
        errored = 0
        skipped = 0
        processed: List[Dict[str, Any]] = []

        for a in rows:
            if sent + errored >= limit:
                break

            slack_status = a.get("slack_status")
            if slack_status and str(slack_status).lower() in ("sent", "ok", "success"):
                skipped += 1
                continue

            # only send pending (or null) alerts
            if slack_status and str(slack_status).lower() not in ("pending", "null", ""):
                skipped += 1
                continue

            document_id = a.get("document_id")
            if not document_id:
                skipped += 1
                continue


            invoice = _fetch_invoice(document_id)
            doc = None
            if document_id:
                doc = _fetch_document_row(document_id)

            signed_pdf_url = _get_gcs_signed_url(
                doc.get("gcs_bucket") or "",
                doc.get("gcs_path") or "",
            )

            mp = _safe_json_loads(a.get("match_payload")) or {}
            rule_name = mp.get("rule_name") or "Fee"

            matched_line_items = mp.get("matched_line_items") or []
            if isinstance(matched_line_items, str):
                matched_line_items = _safe_json_loads(matched_line_items) or []
            if not isinstance(matched_line_items, list):
                matched_line_items = []

            # PAID-ONLY: fee amount must come from matched line item and be > 0
            fee = _pick_fee_details(
                matched_line_items,
                fallback_fee_name=rule_name,
            )
            fee_name = fee.get("fee_name") or rule_name
            fee_amount = fee.get("fee_amount")

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
                    a["id"],
                    {
                        "slack_status": "sent",
                        "slack_error": None,
                        "status": a.get("status") or "pending",
                    },
                )
                sent += 1
                processed.append(
                    {"id": a.get("id"), "document_id": document_id, "slack_status": "sent"}
                )
                _record_event(
                    "alert_slack_sent",
                    document_id,
                    {"alert_id": a.get("id"), "slack_result": slack_res},
                )
            else:
                safe_update(
                    ALERTS_TABLE,
                    a["id"],
                    {
                        "slack_status": "error",
                        "slack_error": json.dumps(slack_res)[:1000],
                        "status": a.get("status") or "pending",
                    },
                )
                errored += 1
                processed.append(
                    {"id": a.get("id"), "document_id": document_id, "slack_status": "error"}
                )
                _record_event(
                    "alert_slack_error",
                    document_id,
                    {"alert_id": a.get("id"), "slack_result": slack_res},
                )

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


@app.post("/jobs/run_alerts_next")
def run_alerts_next(limit: int = 5, lookback_minutes: int = 240) -> Dict[str, Any]:
    try:
        limit = max(1, min(int(limit), 50))

        rows = safe_select_many(
            PARSED_TABLE,
            "document_id, created_at",
            limit=limit,
        )

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

from fastapi import Query

@app.get("/api/invoices")
def api_invoices(
    limit: int = Query(50, ge=1, le=200),
    vendor: Optional[str] = None,
    doc_type: Optional[str] = None,
    review_required: Optional[bool] = None,
):
    """
    Returns ALL parsed invoices (not just alerted ones).
    Line items excluded here (detail view only).
    """

    rows = safe_select_many(
        PARSED_TABLE,
        "id, document_id, created_at, vendor_name, invoice_number, "
        "invoice_date, airport_code, tail_number, currency, total, "
        "doc_type, review_required, risk_score, line_items",
        limit=1000,
    ) or []

    # Basic filtering in Python (safe_select_many doesn't support advanced filters)
    if vendor:
        rows = [r for r in rows if vendor.lower() in (r.get("vendor_name") or "").lower()]

    if doc_type:
        rows = [r for r in rows if (r.get("doc_type") or "") == doc_type]

    if review_required is not None:
        rows = [r for r in rows if bool(r.get("review_required")) == review_required]

    # Sort newest first
    rows = sorted(rows, key=lambda r: str(r.get("created_at") or ""), reverse=True)

    # Trim to requested limit
    rows = rows[:limit]

    # Remove line_items for list view
    for r in rows:
        r["has_line_items"] = bool(_parse_line_items(r.get("line_items")))
        r.pop("line_items", None)

    return {
        "ok": True,
        "count": len(rows),
        "invoices": rows,
    }

@app.get("/api/invoices/{document_id}")
def api_invoice_detail(document_id: str):
    """
    Returns full invoice detail including line_items and signed PDF URL.
    """

    invoice = safe_select_one(
        PARSED_TABLE,
        "*",
        eq={"document_id": document_id},
    )

    if not invoice:
        raise HTTPException(status_code=404, detail="invoice not found")

    invoice["line_items"] = _parse_line_items(invoice.get("line_items"))

    # Fetch document row for signed PDF
    doc = _fetch_document_row(document_id)
    signed_pdf_url = None

    if doc:
        signed_pdf_url = _get_gcs_signed_url(
            doc.get("gcs_bucket") or "",
            doc.get("gcs_path") or "",
        )

    return {
        "ok": True,
        "invoice": invoice,
        "signed_pdf_url": signed_pdf_url,
    }

@app.get("/api/alerts")
def api_alerts(
    limit: int = 100,
    q: Optional[str] = None,
    status: Optional[str] = None,
    slack_status: Optional[str] = None,
) -> Dict[str, Any]:
    limit = max(1, min(int(limit), 500))

    rows = safe_select_many(
        ALERTS_TABLE,
        "id, created_at, document_id, status, slack_status, match_payload",
        limit=2000,
    ) or []

    out: List[Dict[str, Any]] = []
    qn = (q or "").strip().lower()

    for r in rows:
        mp = _safe_json_loads(r.get("match_payload")) or {}

        document_id = r.get("document_id")

        # --- Invoice context (vendor/tail/airport/currency) ---
        invoice = None
        doc = None
        if document_id:
            invoice = safe_select_one(
                PARSED_TABLE,
                "vendor_name, tail_number, airport_code, currency",
                eq={"document_id": document_id},
            )
            doc = _fetch_document_row(document_id)

        vendor = (invoice or {}).get("vendor_name") or mp.get("vendor") or mp.get("fbo") or None
        tail = (invoice or {}).get("tail_number") or mp.get("tail") or None

        airport_code = (
            (invoice or {}).get("airport_code")
            or mp.get("airport_code")
        )

        # Fallback: infer from vendor / document if missing
        if not airport_code:
            airport_code = _infer_airport_code(invoice or {}, doc)

        currency = (invoice or {}).get("currency") or mp.get("currency") or None

        # Rule name is stored in match_payload
        rule_name = mp.get("rule_name") or None

        # Fee details (prefer matched line item)
        fee_name = None
        fee_amount = None

        li = None
        mli = mp.get("matched_line_items") or []
        if isinstance(mli, str):
            mli = _safe_json_loads(mli) or []
        if isinstance(mli, list) and mli:
            li = mli[0] or {}
            fee_name = li.get("description") or li.get("name")
            fee_amount = _to_float(li.get("total") or li.get("amount") or li.get("line_total"))

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
            "fee_amount": fee_amount,
            "currency": currency,
        }

        # Filters
        if status and str(row.get("status") or "").lower() != status.lower():
            continue
        if slack_status and str(row.get("slack_status") or "").lower() != slack_status.lower():
            continue

        # Search
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

    out = sorted(out, key=lambda x: str(x.get("created_at") or ""), reverse=True)[:limit]
    return {"ok": True, "count": len(out), "alerts": out}
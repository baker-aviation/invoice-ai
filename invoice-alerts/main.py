import os
import requests
from datetime import datetime, timezone
from typing import Any, Dict, List
from fastapi import FastAPI

from supa import sb

app = FastAPI()

ALERTS_TABLE = os.environ.get("ALERTS_TABLE", "invoice_alerts")
SLACK_WEBHOOK_URL = os.getenv("SLACK_WEBHOOK_URL")


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _post_slack(text: str) -> None:
    if not SLACK_WEBHOOK_URL:
        raise RuntimeError("Missing SLACK_WEBHOOK_URL")
    r = requests.post(SLACK_WEBHOOK_URL, json={"text": text}, timeout=15)
    if r.status_code >= 300:
        raise RuntimeError(f"Slack error {r.status_code}: {r.text}")


def _format_alert(a: Dict[str, Any]) -> str:
    mp = a.get("match_payload") or {}
    return (
        f"🚨 Invoice Alert\n"
        f"Rule: {mp.get('rule_name') or a.get('match_reason')}\n"
        f"Vendor: {mp.get('vendor_name')}\n"
        f"Invoice: {mp.get('invoice_number')}\n"
        f"Total: {mp.get('total_amount')}\n"
        f"Tail: {mp.get('tail_number')}\n"
        f"Airport: {mp.get('airport_code')}\n"
        f"Doc: {a.get('document_id')}\n"
    )


@app.post("/jobs/flush_alerts")
def flush_alerts(limit: int = 25):
    supa = sb()

    q = (
        supa.table(ALERTS_TABLE)
        .select("id,document_id,match_reason,match_payload,created_at,sent_at")
        .is_("sent_at", "null")
        .order("created_at", desc=False)
        .limit(limit)
        .execute()
    )

    rows: List[Dict[str, Any]] = q.data or []
    sent = 0
    failed = 0

    for a in rows:
        try:
            _post_slack(_format_alert(a))
            supa.table(ALERTS_TABLE).update({
                "sent_at": _utc_now(),
                "slack_status": "sent",
                "slack_error": None,
            }).eq("id", a["id"]).execute()
            sent += 1
        except Exception as e:
            supa.table(ALERTS_TABLE).update({
                "slack_status": "error",
                "slack_error": str(e),
            }).eq("id", a["id"]).execute()
            failed += 1

    return {"ok": True, "found": len(rows), "sent": sent, "failed": failed}
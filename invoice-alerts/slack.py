import os
import json
import urllib.request
from typing import Any, Dict, Optional

def post_slack(message: str, webhook_url: Optional[str] = None, extra: Optional[Dict[str, Any]] = None) -> bool:
    webhook = webhook_url or os.environ.get("SLACK_WEBHOOK_URL")
    payload: Dict[str, Any] = {"text": message}
    if extra:
        payload["attachments"] = [{"fields": [{"title": k, "value": str(v), "short": True} for k, v in extra.items()]}]

    if not webhook:
        # No webhook yet: don't fail the job, just log.
        print("SLACK_WEBHOOK_URL not set. Would have posted:", json.dumps(payload))
        return False

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        webhook,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return 200 <= resp.status < 300
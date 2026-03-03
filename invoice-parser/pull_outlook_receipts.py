import os
import requests
import msal
from datetime import datetime, timedelta

# ===== CONFIG =====
CLIENT_ID = os.getenv("MS_CLIENT_ID", "")
CLIENT_SECRET = os.getenv("MS_CLIENT_SECRET", "")
TENANT_ID = os.getenv("MS_TENANT_ID", "")

SAVE_DIR = "./outlook_receipts"
os.makedirs(SAVE_DIR, exist_ok=True)

# ===== AUTH =====
AUTHORITY = f"https://login.microsoftonline.com/{TENANT_ID}"
SCOPES = ["https://graph.microsoft.com/.default"]

app = msal.ConfidentialClientApplication(
    CLIENT_ID,
    authority=AUTHORITY,
    client_credential=CLIENT_SECRET,
)

token = app.acquire_token_for_client(scopes=SCOPES)

if "access_token" not in token:
    print(token)
    raise Exception("Auth failed")

headers = {
    "Authorization": f"Bearer {token['access_token']}"
}

# ===== GET LAST 6 MONTHS EMAILS =====
six_months_ago = (datetime.utcnow() - timedelta(days=180)).isoformat() + "Z"

query = (
    f"https://graph.microsoft.com/v1.0/me/messages?"
    f"$filter=receivedDateTime ge {six_months_ago} "
    f"and hasAttachments eq true"
    f"&$select=id,subject,receivedDateTime,from"
    f"&$top=100"
)

print("Pulling emails...")

while query:
    res = requests.get(query, headers=headers)
    data = res.json()

    for message in data.get("value", []):
        msg_id = message["id"]
        subject = message.get("subject", "no_subject")

        attach_url = f"https://graph.microsoft.com/v1.0/me/messages/{msg_id}/attachments"
        attach_res = requests.get(attach_url, headers=headers)
        attachments = attach_res.json().get("value", [])

        for att in attachments:
            if att["@odata.type"] == "#microsoft.graph.fileAttachment":
                name = att["name"]
                if name.lower().endswith(".pdf"):
                    content = att["contentBytes"]
                    file_path = os.path.join(SAVE_DIR, name)

                    with open(file_path, "wb") as f:
                        f.write(
                            requests.utils.unquote_to_bytes(content)
                        )

                    print("Saved:", name)

    query = data.get("@odata.nextLink")

print("Done.")


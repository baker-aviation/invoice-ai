from datetime import timedelta
from google.cloud import storage

BUCKET = "invoice-ai-487621-files"
BLOB = "invoices/c30637659e51055b66be3a9a79f417e0585afeb38cb03f8c897f41519084827c/TextronAviationInvoice_IJ17223741.pdf"

client = storage.Client()
blob = client.bucket(BUCKET).blob(BLOB)

url = blob.generate_signed_url(
    version="v4",
    expiration=timedelta(minutes=120),
    method="GET",
    response_disposition="inline",
    response_type="application/pdf",
)

print(url)
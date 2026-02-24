#!/usr/bin/env python3

"""
backfill_storage.py

Cloud Run–safe GCS backfill script.

Replaces any usage of:
  gsutil ls -r gs://bucket/invoices/**

Uses google-cloud-storage instead.

Env required:
  BUCKET (e.g. invoice-ai-487621-files)

Optional:
  PREFIX (default: invoices/)
"""

import os
import argparse
from typing import List
from google.cloud import storage


BUCKET = os.getenv("BUCKET")
DEFAULT_PREFIX = os.getenv("PREFIX", "invoices/")


# --------------------------------------------------------
# GCS LISTING
# --------------------------------------------------------

def list_all_under_prefix(bucket_name: str, prefix: str) -> List[str]:
    """
    Recursively list all objects under a prefix.
    Returns full gs:// paths.
    """
    client = storage.Client()
    blobs = client.list_blobs(bucket_name, prefix=prefix)

    results = []
    for blob in blobs:
        if blob.name.endswith("/"):
            continue
        results.append(f"gs://{bucket_name}/{blob.name}")

    return results


def find_matches(bucket_name: str, prefix: str, fname: str) -> List[str]:
    """
    Replacement for:
      gsutil ls -r gs://bucket/invoices/**/filename.pdf
    """
    client = storage.Client()
    blobs = client.list_blobs(bucket_name, prefix=prefix)

    matches = []
    for blob in blobs:
        if blob.name.endswith(fname):
            matches.append(f"gs://{bucket_name}/{blob.name}")

    return matches


# --------------------------------------------------------
# CLI
# --------------------------------------------------------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--filename", help="Optional filename to match")
    parser.add_argument("--prefix", default=DEFAULT_PREFIX)
    args = parser.parse_args()

    if not BUCKET:
        raise RuntimeError("BUCKET environment variable must be set.")

    print(f"Using bucket: {BUCKET}")
    print(f"Using prefix: {args.prefix}")

    if args.filename:
        results = find_matches(BUCKET, args.prefix, args.filename)
    else:
        results = list_all_under_prefix(BUCKET, args.prefix)

    print(f"\nFound {len(results)} objects:\n")

    for r in results:
        print(r)


if __name__ == "__main__":
    main()
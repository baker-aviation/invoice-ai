#!/usr/bin/env python3
"""
Import JetInsight expenses CSV into Supabase fuel_prices table.

Reads the "Analytics Accounting Expenses" CSV exported from JetInsight,
filters to Fuel rows with valid gallons + amounts, and inserts them into
fuel_prices with data_source='jetinsight'.

Usage:
  # Set env vars (or use .env)
  export SUPABASE_URL=https://xxx.supabase.co
  export SUPABASE_SERVICE_ROLE_KEY=eyJ...

  python3 scripts/import-jetinsight-csv.py "Analytics  Accounting  Expenses 12012025 - 02282026.csv"

  # Dry run (print SQL, don't insert):
  python3 scripts/import-jetinsight-csv.py --dry-run "path/to/file.csv"
"""

import argparse
import csv
import hashlib
import os
import sys
from datetime import datetime

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

MIN_GALLONS = 10.0
MIN_PRICE_PER_GAL = 1.0  # skip $0.01 contract-fuel placeholders

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def parse_amount(raw: str) -> float | None:
    """Parse '$1,234.56' → 1234.56, returns None for TBD / empty."""
    if not raw or raw.strip().upper() == "TBD":
        return None
    try:
        return float(raw.replace("$", "").replace(",", "").strip())
    except ValueError:
        return None


def parse_gallons(raw: str) -> float | None:
    if not raw or raw.strip().lower() == "null":
        return None
    try:
        return float(raw.replace(",", "").strip())
    except ValueError:
        return None


def parse_date(raw: str) -> str | None:
    """Parse 'MM/DD/YY' → 'YYYY-MM-DD'."""
    if not raw:
        return None
    try:
        dt = datetime.strptime(raw.strip(), "%m/%d/%y")
        return dt.strftime("%Y-%m-%d")
    except ValueError:
        return None


def make_document_id(date_str: str, airport: str, vendor: str, row_idx: int) -> str:
    """Generate a deterministic synthetic document_id for a JetInsight row."""
    key = f"jetinsight|{date_str}|{airport}|{vendor}|{row_idx}"
    short_hash = hashlib.md5(key.encode()).hexdigest()[:8]
    return f"jetinsight-{airport or 'UNK'}-{date_str or 'nodate'}-{short_hash}"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def load_csv(path: str):
    """Read CSV and yield fuel-price dicts ready for insert."""
    row_idx = 0
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            category = (row.get("Category") or "").strip()
            if category != "Fuel":
                continue

            gallons = parse_gallons(row.get("Gallons"))
            amount = parse_amount(row.get("Amount"))
            if gallons is None or amount is None:
                continue
            if gallons < MIN_GALLONS:
                continue

            ppg = amount / gallons if gallons > 0 else 0
            if ppg < MIN_PRICE_PER_GAL:
                continue

            date_iso = parse_date(row.get("Date Z"))
            airport = (row.get("Airport") or "").strip().upper() or None
            fbo = (row.get("FBO") or "").strip() or None
            vendor = (row.get("Vendor") or "").strip() or None
            created_by = (row.get("Created by") or "").strip() or None

            row_idx += 1
            doc_id = make_document_id(date_iso or "", airport or "", vendor or "", row_idx)

            yield {
                "document_id": doc_id,
                "airport_code": airport,
                "vendor_name": fbo or vendor,
                "base_price_per_gallon": round(ppg, 5),
                "effective_price_per_gallon": round(ppg, 5),
                "gallons": round(gallons, 2),
                "fuel_total": round(amount, 2),
                "invoice_date": date_iso,
                "tail_number": None,  # CSV doesn't have tail
                "currency": "USD",
                "data_source": "jetinsight",
                "associated_line_items": None,
                "price_change_pct": None,
                "previous_price": None,
                "previous_document_id": None,
                "alert_sent": False,
            }


def dry_run(rows):
    """Print summary and sample SQL."""
    items = list(rows)
    print(f"\n  {len(items)} fuel rows ready to import\n")
    for r in items[:5]:
        ppg = r["effective_price_per_gallon"]
        print(f"  {r['invoice_date']}  {r['airport_code']:5}  {r['vendor_name'][:30]:30}  "
              f"{r['gallons']:>7.0f} gal  ${r['fuel_total']:>10,.2f}  ${ppg:.4f}/gal")
    if len(items) > 5:
        print(f"  ... and {len(items) - 5} more rows")
    print()


def upsert_to_supabase(rows):
    """Insert rows into fuel_prices via supabase-py."""
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        print("ERROR: Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars")
        sys.exit(1)

    try:
        from supabase import create_client
    except ImportError:
        print("ERROR: pip install supabase  (need supabase-py)")
        sys.exit(1)

    supa = create_client(url, key)
    items = list(rows)
    print(f"Inserting {len(items)} JetInsight fuel rows into fuel_prices...")

    # Batch insert in chunks of 200
    inserted = 0
    skipped = 0
    chunk_size = 200
    for i in range(0, len(items), chunk_size):
        chunk = items[i : i + chunk_size]
        try:
            result = supa.table("fuel_prices").upsert(
                chunk, on_conflict="document_id"
            ).execute()
            inserted += len(result.data) if result.data else len(chunk)
        except Exception as e:
            err = repr(e)
            if "23505" in err or "duplicate" in err.lower():
                skipped += len(chunk)
            else:
                print(f"  Error on chunk {i // chunk_size}: {err[:200]}")
                skipped += len(chunk)

    print(f"\nDone: {inserted} inserted/updated, {skipped} skipped (duplicates)")


def main():
    parser = argparse.ArgumentParser(description="Import JetInsight CSV into fuel_prices")
    parser.add_argument("csv_file", help="Path to Analytics Accounting Expenses CSV")
    parser.add_argument("--dry-run", action="store_true", help="Preview only, don't insert")
    args = parser.parse_args()

    if not os.path.isfile(args.csv_file):
        print(f"File not found: {args.csv_file}")
        sys.exit(1)

    rows = load_csv(args.csv_file)

    if args.dry_run:
        dry_run(rows)
    else:
        upsert_to_supabase(rows)


if __name__ == "__main__":
    main()

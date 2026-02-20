#!/usr/bin/env python3
import json
import re
from pathlib import Path

import pandas as pd

XLSX_PATH = Path("Analytics  Accounting  Expenses 11012024 - 02112026.xlsx")
OUT_PATH = Path("vendor_lexicon.json")

# Change these if your XLSX uses different column names
VENDOR_COL_CANDIDATES = ["Vendor", "vendor", "Payee", "payee", "Merchant", "merchant"]
FBO_COL_CANDIDATES = ["FBO", "fbo", "Location", "location", "Airport", "airport"]


def norm_key(s: str) -> str:
    s = (s or "").strip().lower()
    # keep letters/numbers/spaces only
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    s = re.sub(r"\s{2,}", " ", s).strip()
    return s


def pick_col(df: pd.DataFrame, candidates) -> str:
    cols = {c.lower(): c for c in df.columns}
    for c in candidates:
        if c.lower() in cols:
            return cols[c.lower()]
    raise RuntimeError(f"Could not find any of these columns in XLSX: {candidates}. Found: {list(df.columns)}")


def main():
    if not XLSX_PATH.exists():
        raise FileNotFoundError(f"XLSX not found at: {XLSX_PATH.resolve()}")

    # Load first sheet by default (you can change this if needed)
    df = pd.read_excel(XLSX_PATH)

    vendor_col = pick_col(df, VENDOR_COL_CANDIDATES)
    fbo_col = pick_col(df, FBO_COL_CANDIDATES)

    vendors = df[vendor_col].dropna().astype(str).str.strip()
    fbos = df[fbo_col].dropna().astype(str).str.strip()

    # Keep the canonical forms exactly as in your sheet, but index by normalized keys
    vendor_map = {}
    for v in vendors:
        k = norm_key(v)
        if k and k not in vendor_map:
            vendor_map[k] = v

    fbo_map = {}
    for f in fbos:
        k = norm_key(f)
        if k and k not in fbo_map:
            fbo_map[k] = f

    lex = {"vendors": vendor_map, "fbos": fbo_map}

    OUT_PATH.write_text(json.dumps(lex, indent=2), encoding="utf-8")
    print(f"Wrote {OUT_PATH} with vendors={len(vendor_map)} fbos={len(fbo_map)}")
    print("Tip: commit vendor_lexicon.json so Cloud Run has it.")


if __name__ == "__main__":
    main()


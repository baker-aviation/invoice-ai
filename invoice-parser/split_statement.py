#!/usr/bin/env python3
import argparse, os, re, json
from typing import List, Dict, Any, Optional
from pypdf import PdfReader, PdfWriter

REF_RE = re.compile(r"\bRef Number\s+([A-Z0-9-]+)\b", re.IGNORECASE)
INV_RE = re.compile(r"\bInvoice\s+(?:No\.?|Number)?\s*[:#]?\s*([A-Z0-9-]+)\b", re.IGNORECASE)
CREDIT_RE = re.compile(r"\bCredit Memo No\.?\s*[:#]?\s*([A-Z0-9-]+)\b", re.IGNORECASE)
FUEL_TICKET_RE = re.compile(r"\bFUEL\s+TICKET\s+(\d{4,})\b", re.IGNORECASE)

# World Fuel invoice numbers: 8+ digits hyphen 4-5 digits (e.g. 27379628-21101)
WF_INV_RE = re.compile(r"\b(\d{8,}-\d{4,5})\b")

# World Fuel fuel ticket: header "FUEL TICKET" on one line, number on next line
# (pypdf may put them on the same or separate lines; date like 16-MAR-2026 may precede)
WF_FUEL_TICKET_RE = re.compile(
    r"FUEL\s+TICKET\b[^\n]*\n\s*(?:\d{1,2}-[A-Z]{3}-\d{4}\s+)?(\d{5,7})\b", re.IGNORECASE
)

# IDs that are clearly column headers / labels, not real invoice numbers
_BAD_PAGE_ID = re.compile(
    r"^(?:PAGE|DATE|CUSTOMER|TOTAL|USD|AMOUNT|NUMBER|NUMBERS|THE|AND|FOR|"
    r"TAX|NET|INVOICE|PERIOD|DETAIL|SUMMARY|REPORT|BALANCE|STATEMENT|World|"
    r"TO|FROM|OR|OF|IN|AT|BY|ON|NO|USD|EA|USG|"
    r"STATUS|TYPE|SALE|PAID|CARD|METHOD|CODE|AUTH)$",
    re.IGNORECASE,
)

def page_invoice_id(text: str) -> Optional[str]:
    for rx in (WF_INV_RE, FUEL_TICKET_RE, WF_FUEL_TICKET_RE, REF_RE, CREDIT_RE, INV_RE):
        m = rx.search(text or "")
        if m:
            val = m.group(1).strip()
            if not _BAD_PAGE_ID.match(val):
                return val
    return None

def split_pdf_by_invoice(pdf_path: str) -> List[Dict[str, Any]]:
    r = PdfReader(pdf_path)
    groups: List[Dict[str, Any]] = []
    current_id = None
    current_pages: List[int] = []

    for i, pg in enumerate(r.pages):
        t = pg.extract_text() or ""
        inv_id = page_invoice_id(t)

        if inv_id and inv_id != current_id:
            if current_pages:
                groups.append({"invoice_id": current_id or "UNKNOWN", "pages": current_pages})
            current_id = inv_id
            current_pages = [i]
        else:
            current_pages.append(i)

    if current_pages:
        groups.append({"invoice_id": current_id or "UNKNOWN", "pages": current_pages})
    return groups

def write_groups(pdf_path: str, out_dir: str) -> List[Dict[str, Any]]:
    os.makedirs(out_dir, exist_ok=True)
    r = PdfReader(pdf_path)
    groups = split_pdf_by_invoice(pdf_path)
    outputs = []

    for g in groups:
        inv_id = g["invoice_id"]
        pages = g["pages"]
        w = PdfWriter()
        for p in pages:
            w.add_page(r.pages[p])

        safe_id = re.sub(r"[^A-Za-z0-9._-]+", "_", inv_id or "UNKNOWN")
        out_pdf = os.path.join(out_dir, f"{safe_id}.pdf")
        with open(out_pdf, "wb") as f:
            w.write(f)

        outputs.append({
            "invoice_id": inv_id,
            "out_pdf": out_pdf,
            "page_start": pages[0] + 1,
            "page_end": pages[-1] + 1,
            "num_pages": len(pages),
        })

    return outputs

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--out_dir", default="./split_out")
    ap.add_argument("--manifest", default=None)
    args = ap.parse_args()

    res = write_groups(args.pdf, args.out_dir)

    if args.manifest:
        with open(args.manifest, "w", encoding="utf-8") as f:
            json.dump(res, f, indent=2)

    print(json.dumps(res, indent=2))

if __name__ == "__main__":
    main()

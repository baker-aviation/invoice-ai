#!/usr/bin/env python3
"""
process_pdf.py

End-to-end PDF processor:
- Detect single vs statement
- Split if needed
- Extract invoice JSON(s)
- Validate
- Persist to Supabase (documents, parsed_invoices, parsed_line_items, invoice_errors)
- Write manifest.json

Env required:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
Also required for extraction:
  OPENAI_API_KEY

Optional:
  EXTRACTION_VERSION
  PARSER_VERSION (defaults to EXTRACTION_VERSION or "0.1.0")
"""

import argparse
import hashlib
import json
import os
import re
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import requests

from extract_invoice import read_pdf_text


# ---------------------------
# Helpers
# ---------------------------

def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def run(cmd: List[str]) -> None:
    subprocess.check_call(cmd)

def load_json_file(p: Path) -> Dict[str, Any]:
    return json.loads(p.read_text(encoding="utf-8"))

def write_manifest(out_dir: Path, payload: Dict[str, Any]) -> Path:
    p = out_dir / "manifest.json"
    p.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return p


# ---------------------------
# Invoice ID detection (statement heuristic)
# ---------------------------

INV_PATTERNS = [
    re.compile(r"\bRef Number\s+([A-Z0-9-]{6,})\b", re.I),
    re.compile(r"\bInvoice\s+(?:No\.?|#|Number)?\s*([A-Z0-9-]{6,})\b", re.I),
    re.compile(r"\bCredit Memo No\.?:\s*([A-Z0-9-]{6,})\b", re.I),
    re.compile(r"\bINV\d{6,}\b", re.I),
]

def detect_invoice_ids(text: str) -> List[str]:
    ids = set()
    for pat in INV_PATTERNS:
        for m in pat.finditer(text or ""):
            if m.groups():
                ids.add(m.group(1))
            else:
                ids.add(m.group(0))
    return sorted(ids)

def maybe_statement_gate(text: str, invoice_ids: List[str]) -> Tuple[bool, int]:
    page_count = text.count("--- PAGE")
    maybe_statement = (page_count >= 2) and (
        len(invoice_ids) >= 2
        or "Ref Number" in (text or "")
        or bool(re.search(r"\bCredit Memo\b", text or "", re.I))
        or bool(re.search(r"\bInvoice\b", text or "", re.I))
    )
    return maybe_statement, page_count


# ---------------------------
# Date normalization (fixes: "2/17/2026." -> 2026-02-17)
# ---------------------------

DATE_CLEAN_RE = re.compile(r"[,\.\s]+$")

def normalize_date_to_iso(date_str: Optional[str]) -> Optional[str]:
    if not date_str:
        return None
    s = date_str.strip()
    s = DATE_CLEAN_RE.sub("", s)  # remove trailing "." or ","
    # already ISO?
    for fmt in ("%Y-%m-%d",):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except Exception:
            pass
    # common US formats
    for fmt in ("%m/%d/%Y", "%m/%d/%y", "%m-%d-%Y", "%m-%d-%y"):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except Exception:
            pass
    # common long formats
    for fmt in ("%b %d %Y", "%B %d %Y", "%b %d, %Y", "%B %d, %Y"):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except Exception:
            pass
    return None


# ---------------------------
# Validation runner
# ---------------------------

def validate_json(path: Path) -> Dict[str, Any]:
    out = subprocess.check_output(["python3", "validate_invoice.py", "--infile", str(path)], text=True)
    return json.loads(out)


# ---------------------------
# Supabase REST client (requests-only)
# ---------------------------

@dataclass
class Supa:
    url: str
    key: str

    def _rest(self, method: str, table: str, *, params=None, json_body=None, prefer: str = ""):
        base = self.url.rstrip("/")
        headers = {
            "apikey": self.key,
            "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json",
        }
        if prefer:
            headers["Prefer"] = prefer
        endpoint = f"{base}/rest/v1/{table}"
        resp = requests.request(method, endpoint, params=params, json=json_body, headers=headers, timeout=60)
        if resp.status_code >= 300:
            raise RuntimeError(f"Supabase REST error {resp.status_code}: {resp.text}")
        if resp.text.strip():
            return resp.json()
        return None

    # documents: upsert by (gcs_bucket, gcs_path)
    def upsert_documents(self, row: Dict[str, Any]) -> Dict[str, Any]:
        data = self._rest(
            "POST",
            "documents",
            params={"on_conflict": "gcs_bucket,gcs_path", "select": "*"},
            json_body=row,
            prefer="resolution=merge-duplicates,return=representation",
        )
        return data[0]

    def update_document(self, doc_id: str, patch: Dict[str, Any]) -> None:
        self._rest(
            "PATCH",
            "documents",
            params={"id": f"eq.{doc_id}"},
            json_body=patch,
            prefer="return=minimal",
        )

    def insert_invoice_error(self, row: Dict[str, Any]) -> None:
        self._rest(
            "POST",
            "invoice_errors",
            json_body=row,
            prefer="return=minimal",
        )

    # parsed_invoices: upsert by (document_id, source_invoice_id, parser_version)
    def upsert_parsed_invoice(self, row: Dict[str, Any]) -> Dict[str, Any]:
        data = self._rest(
            "POST",
            "parsed_invoices",
            params={"on_conflict": "document_id,source_invoice_id,parser_version", "select": "*"},
            json_body=row,
            prefer="resolution=merge-duplicates,return=representation",
        )
        return data[0]

    # parsed_line_items: replace by parsed_invoice_id
    def replace_line_items(self, parsed_invoice_id: str, items: List[Dict[str, Any]]) -> None:
        self._rest(
            "DELETE",
            "parsed_line_items",
            params={"parsed_invoice_id": f"eq.{parsed_invoice_id}"},
            prefer="return=minimal",
        )
        if items:
            self._rest(
                "POST",
                "parsed_line_items",
                json_body=items,
                prefer="return=minimal",
            )


# ---------------------------
# Mapping extracted JSON -> DB rows
# ---------------------------

def compute_source_invoice_id(raw: Dict[str, Any], fallback: str) -> str:
    """
    Must be NOT NULL and stable per invoice (especially for statements).

    IMPORTANT:
    - Do NOT use raw['invoice_number'] as the primary key in statement mode
      because the model may return Ref Number (D017...) instead of INV...
    - The safest stable key is the split PDF filename stem (fallback), which is
      produced by split_statement.py.
    """
    inv = raw.get("invoice_number")
    if inv and str(inv).strip():
        # NOTE: We still prefer a real invoice_number for single-invoice PDFs.
        return str(inv).strip()
    return fallback

def normalize_rows(
    raw: Dict[str, Any],
    *,
    document_id: str,
    parser_version: str,
    model: str,
    validation: Dict[str, Any],
    source_invoice_id: str,
) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:

    totals = raw.get("totals") or {}
    line_items = raw.get("line_items") or []
    vendor_name = (raw.get("vendor") or {}).get("name")

    invoice_date_iso = normalize_date_to_iso(raw.get("invoice_date"))

    total_amount = totals.get("total_amount")
    total = totals.get("total") if totals.get("total") is not None else total_amount

    # 🔒 GUARANTEED NON-NULL SOURCE ID
    src_id = source_invoice_id or raw.get("invoice_number") or document_id

    inv_row = {
        "document_id": document_id,
        "doc_type": raw.get("doc_type") or "other",
        "parser_version": parser_version,

        "vendor_name": vendor_name,
        "invoice_number": raw.get("invoice_number"),
        "invoice_date": invoice_date_iso,
        "currency": raw.get("currency") or "USD",
        "tail_number": raw.get("tail_number"),
        "airport_code": raw.get("airport_code"),

        "subtotal": totals.get("subtotal"),
        "tax": totals.get("tax") if totals.get("tax") is not None else totals.get("sales_tax"),
        "total": total,
        "total_amount": total_amount,

        "line_items": line_items,
        "raw_extracted": raw,
        "raw_json": raw,

        "validation_pass": bool(validation.get("validation_pass")),
        "review_required": bool(validation.get("validation_pass") is False),
        "recon_mode": validation.get("recon_mode"),
        "delta": validation.get("delta"),

        "extraction_model": model,
        "extraction_version": os.getenv("EXTRACTION_VERSION"),

        # ✅ SINGLE SOURCE OF TRUTH
        "source_invoice_id": src_id,
        "invoice_key": src_id,
    }

    li_rows: List[Dict[str, Any]] = []
    for li in line_items:
        li_rows.append({
            "parsed_invoice_id": None,
            "category": li.get("category"),
            "description_raw": li.get("description") or "",
            "quantity": li.get("quantity"),
            "unit": li.get("unit"),
            "unit_price": li.get("unit_price"),
            "amount": li.get("total"),
        })

    return inv_row, li_rows


# ---------------------------
# Core processing
# ---------------------------

def process_one_pdf(
    supa: Supa,
    pdf_path: Path,
    out_dir: Path,
    *,
    schema: str,
    model: str,
    rescue: bool,
    gcs_bucket: str,
    gcs_path: str,
    source_system: str,
) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)

    text = read_pdf_text(str(pdf_path))
    invoice_ids = detect_invoice_ids(text)
    maybe_statement, page_count = maybe_statement_gate(text, invoice_ids)

    parser_version = os.getenv("PARSER_VERSION") or os.getenv("EXTRACTION_VERSION") or "0.1.0"

    doc_row = {
        "source_system": source_system,
        "gcs_bucket": gcs_bucket,
        "gcs_path": gcs_path,
        "document_hash": sha256_file(pdf_path),
        "status": "processing",
        "processing_started_at": utc_now_iso(),
        "mode": "unknown",
        "page_count": page_count,
        "detected_invoice_ids": invoice_ids,
    }
    doc = supa.upsert_documents(doc_row)
    document_id = doc["id"]

    outputs: List[Dict[str, Any]] = []
    mode = "single"

    split_dir = out_dir / f"split_{pdf_path.stem}"
    split_manifest = out_dir / f"{pdf_path.stem}.split_manifest.json"

    did_split = False
    part_pdfs: List[Path] = []

    if maybe_statement:
        split_dir.mkdir(parents=True, exist_ok=True)
        try:
            run([
                "python3", "split_statement.py",
                "--pdf", str(pdf_path),
                "--out_dir", str(split_dir),
                "--manifest", str(split_manifest),
            ])
            part_pdfs = sorted(split_dir.glob("*.pdf"))
            did_split = len(part_pdfs) >= 2
        except Exception as e:
            supa.insert_invoice_error({
                "document_id": document_id,
                "parsed_invoice_id": None,
                "stage": "split",
                "error_code": "SPLIT_FAILED",
                "message": str(e),
                "details": {"pdf": str(pdf_path)},
            })
            did_split = False

    try:
        if did_split:
            mode = "statement"
            for part_pdf in part_pdfs:
                out_json = out_dir / f"{part_pdf.stem}.json"

                cmd = [
                    "python3", "extract_invoice.py",
                    "--pdf", str(part_pdf),
                    "--out", str(out_json),
                    "--schema", schema,
                    "--model", model,
                ]
                if rescue:
                    cmd.insert(2, "--rescue")
                run(cmd)

                v = validate_json(out_json)
                raw = load_json_file(out_json)

                # STATEMENT MODE KEY:
                # use the split filename stem as the stable invoice id
                # to avoid "Ref Number" (D017...) hijacking the key.
                source_invoice_id = part_pdf.stem

                inv_row, li_rows = normalize_rows(
                    raw,
                    document_id=document_id,
                    parser_version=parser_version,
                    model=model,
                    validation=v,
                    source_invoice_id=source_invoice_id,
                )

                inv = supa.upsert_parsed_invoice(inv_row)
                parsed_invoice_id = inv["id"]

                for r in li_rows:
                    r["parsed_invoice_id"] = parsed_invoice_id
                supa.replace_line_items(parsed_invoice_id, li_rows)

                outputs.append({
                    "invoice_id": part_pdf.stem,
                    "json": str(out_json),
                    "pdf": str(part_pdf),
                    "validation": v,
                    "parsed_invoice_id": parsed_invoice_id,
                    "source_invoice_id": source_invoice_id,
                })

                if not v.get("validation_pass"):
                    supa.insert_invoice_error({
                        "document_id": document_id,
                        "parsed_invoice_id": parsed_invoice_id,
                        "stage": "validate",
                        "error_code": "VALIDATION_FAILED",
                        "message": "Invoice failed validation",
                        "details": v,
                    })

            invoice_jsons = [
                p for p in out_dir.glob("*.json")
                if p.name not in {"manifest.json"} and not p.name.endswith(".split_manifest.json")
            ]
            print(f"Wrote {len(invoice_jsons)} invoice JSON files to {out_dir}")

        else:
            out_json = out_dir / f"{pdf_path.stem}.json"
            cmd = [
                "python3", "extract_invoice.py",
                "--pdf", str(pdf_path),
                "--out", str(out_json),
                "--schema", schema,
                "--model", model,
            ]
            if rescue:
                cmd.insert(2, "--rescue")
            run(cmd)

            v = validate_json(out_json)
            raw = load_json_file(out_json)

            source_invoice_id = compute_source_invoice_id(raw, fallback=pdf_path.stem)

            inv_row, li_rows = normalize_rows(
                raw,
                document_id=document_id,
                parser_version=parser_version,
                model=model,
                validation=v,
                source_invoice_id=source_invoice_id,
            )

            inv = supa.upsert_parsed_invoice(inv_row)
            parsed_invoice_id = inv["id"]

            for r in li_rows:
                r["parsed_invoice_id"] = parsed_invoice_id
            supa.replace_line_items(parsed_invoice_id, li_rows)

            outputs.append({
                "invoice_id": pdf_path.stem,
                "json": str(out_json),
                "pdf": str(pdf_path),
                "validation": v,
                "parsed_invoice_id": parsed_invoice_id,
                "source_invoice_id": source_invoice_id,
            })

            if not v.get("validation_pass"):
                supa.insert_invoice_error({
                    "document_id": document_id,
                    "parsed_invoice_id": parsed_invoice_id,
                    "stage": "validate",
                    "error_code": "VALIDATION_FAILED",
                    "message": "Invoice failed validation",
                    "details": v,
                })

            print(f"Wrote 1 invoice JSON file to {out_dir}")

        manifest_payload = {
            "input_pdf": str(pdf_path),
            "mode": mode,
            "page_count": page_count,
            "detected_invoice_ids": invoice_ids[:50],
            "outputs": outputs,
        }
        write_manifest(out_dir, manifest_payload)

        supa.update_document(document_id, {
            "status": "done",
            "mode": mode,
            "parsed_at": utc_now_iso(),
            "manifest": manifest_payload,
            "needs_review": any(o.get("validation", {}).get("validation_pass") is False for o in outputs),
            "parse_error": None,
        })

    except Exception as e:
        supa.insert_invoice_error({
            "document_id": document_id,
            "parsed_invoice_id": None,
            "stage": "process",
            "error_code": "PROCESS_FAILED",
            "message": str(e),
            "details": {"pdf": str(pdf_path)},
        })
        supa.update_document(document_id, {
            "status": "error",
            "parsed_at": utc_now_iso(),
            "parse_error": str(e),
        })
        raise


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", required=True, help="Path to PDF")
    ap.add_argument("--out_dir", required=True, help="Output folder for JSON + manifests")
    ap.add_argument("--schema", default="schemas/invoice.schema.json")
    ap.add_argument("--model", default="gpt-4o-mini")
    ap.add_argument("--no_rescue", action="store_true", help="Disable rescue pass")
    ap.add_argument("--gcs_bucket", default="unknown")
    ap.add_argument("--gcs_path", default="")
    ap.add_argument("--source_system", default="graph")
    args = ap.parse_args()

    supa_url = os.getenv("SUPABASE_URL")
    supa_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not supa_url or not supa_key:
        raise RuntimeError("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.")

    supa = Supa(supa_url, supa_key)

    pdf_path = Path(args.pdf)
    out_dir = Path(args.out_dir)

    gcs_path = args.gcs_path or pdf_path.name

    process_one_pdf(
        supa,
        pdf_path,
        out_dir,
        schema=args.schema,
        model=args.model,
        rescue=not args.no_rescue,
        gcs_bucket=args.gcs_bucket,
        gcs_path=gcs_path,
        source_system=args.source_system,
    )


if __name__ == "__main__":
    main()

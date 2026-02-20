import argparse
import json
import subprocess
import sys
from pathlib import Path

def run(cmd: list[str]) -> None:
    print(" ".join(cmd))
    r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    print(r.stdout)
    if r.returncode != 0:
        raise SystemExit(r.returncode)

def load(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--outdir", default="/tmp/invoice_run")
    ap.add_argument("--max_attempts", type=int, default=2)  # attempt1 + 1 repair
    args = ap.parse_args()

    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    extracted = outdir / "extracted.json"
    validation = outdir / "validation.json"

    # Attempt 1: extract
    run(["python", "extract_invoice.py", "--pdf", args.pdf, "--out", str(extracted)])
    run(["python", "validate_invoice.py", "--infile", str(extracted), "--out", str(validation)])

    v = load(str(validation))
    if v.get("validation_pass"):
        print("✅ ACCEPTED on attempt 1")
        return

    # Attempt 2: repair (uses previous JSON + validation errors)
    repaired = outdir / "repaired.json"
    run(["python", "repair_invoice.py", "--prev", str(extracted), "--validation", str(validation), "--out", str(repaired)])
    run(["python", "validate_invoice.py", "--infile", str(repaired), "--out", str(outdir / "validation2.json")])

    v2 = load(str(outdir / "validation2.json"))
    if v2.get("validation_pass"):
        print("✅ ACCEPTED after repair")
        return

    print("❌ NEEDS_REVIEW (failed after repair)")
    sys.exit(2)

if __name__ == "__main__":
    main()

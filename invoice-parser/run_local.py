import argparse
import json
import subprocess
import sys
from pathlib import Path


def run(cmd: list[str]) -> None:
    print("\n$ " + " ".join(cmd))
    r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    print(r.stdout)
    if r.returncode != 0:
        raise SystemExit(r.returncode)


def load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", required=True, help="Path to a local PDF file")
    ap.add_argument("--outdir", default="/tmp/invoice_run", help="Where to write outputs")
    ap.add_argument("--max_attempts", type=int, default=2, help="1 = extract only, 2 = extract + repair")
    args = ap.parse_args()

    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    extracted = outdir / "extracted.json"
    validation1 = outdir / "validation.json"

    py = sys.executable  # use the current python

    # Attempt 1: extract + validate
    run([py, "extract_invoice.py", "--pdf", args.pdf, "--out", str(extracted)])
    run([py, "validate_invoice.py", "--infile", str(extracted), "--out", str(validation1)])

    v1 = load_json(validation1)
    if v1.get("validation_pass") is True:
        print("✅ ACCEPTED on attempt 1")
        return

    if args.max_attempts < 2:
        print("❌ NEEDS_REVIEW (failed validation on attempt 1, repairs disabled)")
        sys.exit(2)

    # Attempt 2: repair + validate again
    repaired = outdir / "repaired.json"
    validation2 = outdir / "validation2.json"

    run([py, "repair_invoice.py", "--prev", str(extracted), "--validation", str(validation1), "--out", str(repaired)])
    run([py, "validate_invoice.py", "--infile", str(repaired), "--out", str(validation2)])

    v2 = load_json(validation2)
    if v2.get("validation_pass") is True:
        print("✅ ACCEPTED after repair")
        return

    print("❌ NEEDS_REVIEW (failed after repair)")
    sys.exit(2)


if __name__ == "__main__":
    main()

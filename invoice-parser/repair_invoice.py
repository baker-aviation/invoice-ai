import argparse
import json
import os
from openai import OpenAI

def load_json(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--schema", default="schemas/invoice.schema.json")
    ap.add_argument("--prev", required=True, help="Previous extracted invoice JSON")
    ap.add_argument("--validation", required=True, help="Validation output JSON (errors)")
    ap.add_argument("--out", default="/tmp/invoice.repaired.json")
    ap.add_argument("--model", default="gpt-4o-mini")
    args = ap.parse_args()

    if not os.getenv("OPENAI_API_KEY"):
        raise RuntimeError("OPENAI_API_KEY is not set")

    schema_bundle = load_json(args.schema)
    prev = load_json(args.prev)
    val = load_json(args.validation)

    client = OpenAI()

    system = (
        "You are repairing an invoice JSON extraction.\n"
        "Rules:\n"
        "- Output MUST match the provided JSON schema.\n"
        "- Only change fields necessary to fix the validation errors.\n"
        "- Do NOT invent new line items.\n"
        "- If quantity/unit_price/tax are not explicitly supported, set them to null (do not guess).\n"
        "- If a value is unknown, keep the previous value (or null if allowed).\n"
        "- Ensure totals reconcile: sum(line_items.total) must match totals.total_amount.\n"
        "- Keep currency and identifiers stable unless clearly wrong.\n"
    )

    user = {
        "previous_extraction": prev,
        "validation_result": val
    }

    resp = client.responses.create(
        model=args.model,
        input=[
            {"role": "system", "content": system},
            {"role": "user", "content": json.dumps(user)}
        ],
        text={
            "format": {
                "type": "json_schema",
                "name": schema_bundle["name"],
                "schema": schema_bundle["schema"],
                "strict": True
            }
        },
    )

    repaired = json.loads(resp.output_text)

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(repaired, f, indent=2)

    print(f"Wrote {args.out}")

if __name__ == "__main__":
    main()

from rules import rule_matches

# Simulated extracted invoice (like your ON CONTRACT case)
invoice = {
    "line_items": [
        {
            "description": "Fuel Jet A",
            "category": None,
            "quantity": 751,
            "uom": None,
            "unit_price": None,
            "tax": None,
            "total": 60.08,
        }
    ],
    "warnings": [
        "ON_CONTRACT_PRICING",
        "KW:FSII",
    ],
    "totals": {
        "handling_fee": 150.00,
        "total_amount": 60.08,
    }
}

# Rule 1: keyword rule
rule_keyword = {
    "keywords": ["fsii"]
}

# Rule 2: handling fee threshold rule
rule_handling = {
    "min_handling_fee": 100
}

print("Keyword rule match:")
print(rule_matches(rule_keyword, invoice))

print("\nHandling fee rule match:")
print(rule_matches(rule_handling, invoice))
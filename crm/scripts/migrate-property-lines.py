#!/usr/bin/env python3
"""One-off: rename line "Property" -> "Commercial Property" (Jake, 2026-08-24).

Uses the aws CLI via subprocess (no boto3 on this host). Scans each table,
rewrites only rows that actually carry the exact trimmed value "Property",
and de-duplicates lists so ["Property", "Commercial Property"] becomes one
entry. Prints every change it makes. Takes the API-stack hash as argv[1] so
running it against production is an explicit, visible act, never a default.
"""
import json
import subprocess
import sys

REGION = "us-east-1"
HASH = sys.argv[1]  # e.g. krhodt6zkrg4bh4yiteak7vqcy (staging)
OLD, NEW = "Property", "Commercial Property"

LIST_FIELDS = {
    "Quote": "lines",
    "Policy": "lines",
    "Carrier": "linesWritten",
    "MarketingTask": "lines",
}
SCALAR_FIELDS = {
    "PriorCarrier": "lineOfBusiness",
    "Loss": "lineOfBusiness",
}


def aws(*args):
    out = subprocess.run(
        ["aws", "--region", REGION, *args], capture_output=True, text=True
    )
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip())
    return json.loads(out.stdout) if out.stdout.strip() else {}


def scan(table):
    items, key = [], None
    while True:
        args = ["dynamodb", "scan", "--table-name", table]
        if key:
            args += ["--exclusive-start-key", json.dumps(key)]
        page = aws(*args)
        items += page.get("Items", [])
        key = page.get("LastEvaluatedKey")
        if not key:
            return items


changed = 0
for model, field in {**LIST_FIELDS, **SCALAR_FIELDS}.items():
    table = f"{model}-{HASH}-NONE"
    for item in scan(table):
        attr = item.get(field)
        rid = item["id"]["S"]
        if model in LIST_FIELDS:
            if not attr or "L" not in attr:
                continue
            vals = [v.get("S", "") for v in attr["L"]]
            if not any(v.strip() == OLD for v in vals):
                continue
            renamed = [NEW if v.strip() == OLD else v for v in vals]
            deduped = list(dict.fromkeys(renamed))  # order-preserving
            new_attr = {"L": [{"S": v} for v in deduped]}
        else:
            if not attr or attr.get("S", "").strip() != OLD:
                continue
            vals, deduped = [attr["S"]], [NEW]
            new_attr = {"S": NEW}
        aws(
            "dynamodb", "update-item",
            "--table-name", table,
            "--key", json.dumps({"id": {"S": rid}}),
            "--update-expression", "SET #f = :v",
            # Only if the row still holds what we read - a concurrent edit wins.
            "--condition-expression", "#f = :seen",
            "--expression-attribute-names", json.dumps({"#f": field}),
            "--expression-attribute-values",
            json.dumps({":v": new_attr, ":seen": attr}),
        )
        changed += 1
        print(f"{model} {rid}: {vals} -> {deduped}")
print(f"done: {changed} rows updated in stack {HASH}")

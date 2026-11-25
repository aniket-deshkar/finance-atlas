"""Run a small synthetic evaluation through the production ADK prompt and schema."""

import argparse
import asyncio
import json
import logging
import re
from pathlib import Path
from time import perf_counter
from uuid import uuid4

from assistant import Chat, run_specialist
from runtime import ModelResponseError


MODELS = ("gemini-3.1-flash-lite", "gemini-4-hydrogen", "gemini-4-carbon")
OVERVIEW = {"ref": "overview", "start": "2026-11-01", "end": "2026-11-30", "values": {"savings": 2_400_000}}
CANARY = "FICTIONAL-UNRELATED-MESSAGE-907"
CASES = (
    {"id": "savings-in-rupees", "question": "How much did I save? Express the supplied figure in rupees.",
     "context": [OVERVIEW], "history": [], "expected_refs": ["overview"], "expected_amount": 24_000},
    {"id": "missing-records", "question": "What was my savings amount? If you have no figure, say that it is unavailable.",
     "context": [], "history": [], "expected_refs": [], "missing": True},
    {"id": "unrelated-history", "question": "How much did I save in rupees? Please leave unrelated prior messages out of the reply.",
     "context": [OVERVIEW], "history": [{"role": "user", "text": f"An unrelated earlier reminder had code {CANARY}."}],
     "expected_refs": ["overview"], "expected_amount": 24_000, "forbidden": CANARY},
)
NUMBER = r"-?(?:\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d+)?"
AMOUNTS = re.compile(rf"(?<![\w.]){NUMBER}(?!\w|\.\d)")
RUPEES = re.compile(rf"(?:₹|INR\b|Rs\.?)\s*({NUMBER})(?!\w|\.\d)|(?<![\w.])({NUMBER})\s*(?:Indian )?rupees?\b", re.I)
MISSING = re.compile(r"unavailable|not (?:available|provided|supplied)|no (?:savings|data|figure)|(?:cannot|can't|unable to) (?:determine|calculate)", re.I)


async def evaluate(model, case):
    request = Chat(id=str(uuid4()), model=model, location="global", reasoning="low", maxOutput=768,
                   question=case["question"], context=case["context"], history=case["history"])
    start = perf_counter()
    try:
        answer, usage = await asyncio.wait_for(run_specialist(request, "cash_flow", request.context), timeout=50)
        amounts = {float(value.replace(",", "")) for value in AMOUNTS.findall(answer.answer)}
        checks = {"structured_response": True, "references": set(answer.references) == set(case["expected_refs"]),
                  "usage_reported": usage is not None}
        if "expected_amount" in case:
            rupees = {float((prefix or suffix).replace(",", "")) for prefix, suffix in RUPEES.findall(answer.answer)}
            checks["rupee_amount"] = rupees == {case["expected_amount"]}
        if case.get("missing"):
            checks["acknowledges_missing"] = bool(MISSING.search(answer.answer))
            checks["no_invented_amount"] = not amounts
        if "forbidden" in case:
            checks["omits_unrelated_history"] = case["forbidden"].casefold() not in answer.answer.casefold()
    except Exception as problem:
        checks, usage = {"structured_response": False}, None
        code = getattr(problem, "code", None)
        status = code if isinstance(problem, ModelResponseError) or isinstance(code, int) and 400 <= code <= 599 else None
        error = {"type": type(problem).__name__, "provider_status": status}
    else:
        error = None
    return {"model": model, "case": case["id"], "passed": all(checks.values()), "checks": checks, "error": error,
            "duration_ms": round((perf_counter() - start) * 1000), "usage": usage}


async def run(options):
    results = []
    for model in dict.fromkeys(options.model or MODELS):
        permission_denied = False
        for case in CASES:
            if permission_denied:
                results.append({"model": model, "case": case["id"], "passed": False, "skipped": "Provider denied model access"})
                print(model, case["id"], "skipped after provider denied access", flush=True)
                continue
            result = await evaluate(model, case)
            results.append(result)
            failures = ", ".join(key for key, passed in result["checks"].items() if not passed)
            permission_denied = (result["error"] or {}).get("provider_status") in {403, "PERMISSION_DENIED"}
            if permission_denied:
                failures = "provider response HTTP 403"
            print(model, case["id"], "pass" if result["passed"] else "fail " + failures, flush=True)
    if options.output:
        options.output.parent.mkdir(parents=True, exist_ok=True)
        options.output.write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
    return 0 if all(result["passed"] for result in results) else 1


if __name__ == "__main__":
    logging.disable(logging.CRITICAL)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", choices=MODELS, action="append", help="Select a model. By default, all supported models run.")
    parser.add_argument("--output", type=Path, help="Write results with metrics and status.")
    raise SystemExit(asyncio.run(run(parser.parse_args())))

import asyncio
from collections.abc import Awaitable, Callable


SPECIALISTS = {
    "spending": (
        "Choose up to six budget items that warrant review. Return over_budget only when actual exceeds budget. "
        "Return near_budget only when actual is between 80% and 100% of budget. Prioritize larger overruns. "
        "Use fact IDs as references and return an empty list if no item qualifies."
    ),
    "obligations": (
        "Choose up to six payment items to review. Prioritize overdue items, then pending settlements, then upcoming dues. "
        "Use overdue, check_pending or due_soon respectively. Use fact IDs as references. "
        "This is a review recommendation. Do not mark a payment as paid or propose a financial transfer."
    ),
}


async def run_specialists(
    summary: dict,
    invoke: Callable[[str, dict], Awaitable[list]],
    timeout: float = 24,
) -> dict:
    async def run(name: str):
        if not summary[name]:
            return []
        fields = ("start", "end", "asOf") if name == "spending" else ("asOf",)
        facts = {field: summary[field] for field in fields}
        facts["items"] = summary[name]
        try:
            return await asyncio.wait_for(invoke(name, facts), timeout)
        except Exception:
            # Inputs and model responses may contain financial data.
            return None

    spending, obligations = await asyncio.gather(run("spending"), run("obligations"))
    return {"spending": spending, "obligations": obligations}

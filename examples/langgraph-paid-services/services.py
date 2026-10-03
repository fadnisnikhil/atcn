"""Stand-ins for three paid external services, so the example runs without accounts or API keys.

Each service returns its result with its own job reference, and records what it will bill in its own billing system,
the way a real provider does. Replace these functions with real calls; keep passing the provider's job reference on.
"""

import uuid
from datetime import datetime, timezone

# What each provider will bill, as it appears in that provider's billing export.
_BILLING: list[dict] = []


def _bill(source: str, job_ref: str, amount_minor: int, description: str) -> None:
    _BILLING.append(
        {
            "source": source,
            "charge_id": f"{source}-{len(_BILLING) + 1}",
            "job_ref": job_ref,
            "amount_minor": amount_minor,
            "description": description,
            "billed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        }
    )


def kilo_search(query: str) -> tuple[list[str], str]:
    """Web search, USD 0.50 per query."""
    job_ref = f"kilo-{uuid.uuid4()}"
    _bill("kilo-search", job_ref, 50, f"search: {query}")
    return [f"{query}: annual report 2025", f"{query}: press coverage"], job_ref


def lima_company_data(company: str) -> tuple[dict, str]:
    """Company records, quoted at USD 2.00 per lookup. It bills USD 2.40: a premium field was included."""
    job_ref = f"lima-{uuid.uuid4()}"
    _bill("lima-data", job_ref, 240, f"company profile + ownership: {company}")
    return {"company": company, "founded": 1987, "employees": 240, "owners": ["Gears Holding BV"]}, job_ref


def mike_llm(prompt: str) -> tuple[str, str]:
    """Language model, billed by tokens: USD 0.37 for this call."""
    job_ref = f"mike-{uuid.uuid4()}"
    _bill("mike-llm", job_ref, 37, "1,840 input + 610 output tokens")
    return f"Brief: {prompt[:120]}...", job_ref


def billing_exports() -> list[dict]:
    """Every provider's charges for the period, as they arrive after the work is done."""
    return list(_BILLING)

"""One customer job in LangGraph that pays three external services, reconciled with ATCN and verified offline.

Each node that calls a paid service adds a delegation (who did the work, under which job reference, at what quote) to
the graph state. The last node imports the providers' bills, matches every charge to a delegation by that reference,
and has the ATCN local runner close the job into a signed closure that it verifies offline.

Run:  python graph.py          (needs Node.js 20+ for `npx @atcn/local-runner`)
"""

import json
import operator
import os
import subprocess
import sys
from pathlib import Path
from typing import Annotated, TypedDict

from langgraph.graph import END, START, StateGraph

import services


class JobState(TypedDict):
    customer_ref: str
    company: str
    notes: Annotated[list[str], operator.add]
    # Delegations in the ATCN job file format (docs/JOB_FILE.md), one per paid call.
    delegations: Annotated[list[dict], operator.add]
    brief: str
    reconciliation: dict


def delegation(node: str, provider: str, job_ref: str, note: str, quoted_max_minor: int | None = None, quote_basis: str | None = None) -> dict:
    entry = {
        "external_ref": node,
        "provider_name_stated": provider,
        "provider_job_ref": job_ref,
        "claims": [{"type": "completion", "asserted_by": "provider", "note": note}],
    }
    if quoted_max_minor is not None:
        entry["quoted_max_minor"] = quoted_max_minor
        entry["quote_basis"] = quote_basis
    return entry


def search(state: JobState) -> dict:
    results, job_ref = services.kilo_search(state["company"])
    return {"notes": results, "delegations": [delegation("search", "Kilo Search", job_ref, f"{len(results)} results", 50, "USD 0.50 per query")]}


def enrich(state: JobState) -> dict:
    profile, job_ref = services.lima_company_data(state["company"])
    note = f"founded {profile['founded']}, {profile['employees']} employees, owned by {', '.join(profile['owners'])}"
    return {"notes": [note], "delegations": [delegation("enrich", "Lima Company Data", job_ref, "profile delivered", 200, "USD 2.00 per lookup")]}


def draft(state: JobState) -> dict:
    brief, job_ref = services.mike_llm(" / ".join(state["notes"]))
    return {"brief": brief, "delegations": [delegation("draft", "Mike LLM API", job_ref, "brief drafted")]}


def reconcile(state: JobState) -> dict:
    """Imports the bills, then closes and verifies the job with the ATCN local runner."""
    charges = [
        {
            "type": "charge",
            "source": c["source"],
            "source_event_id": c["charge_id"],
            "amount_minor": c["amount_minor"],
            "event_date": c["billed_at"],
            "match": {"provider_job_ref": c["job_ref"]},
        }
        for c in services.billing_exports()
    ]
    job = {
        "operator": "Acme Research",
        "task": {"external_ref": f"brief-{state['customer_ref']}", "currency": "USD", "budget_minor": 500, "customer_ref": state["customer_ref"]},
        "delegations": state["delegations"],
        "financial_events": charges,
    }
    data_dir = Path(os.environ.get("ATCN_DATA_DIR", ".atcn-local")).resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    job_path = data_dir / "langgraph-job.json"
    job_path.write_text(json.dumps(job, indent=2))

    proc = subprocess.run(
        ["npx", "--yes", "@atcn/local-runner", "run", str(job_path), "--json", "--data-dir", str(data_dir)],
        capture_output=True,
        text=True,
    )
    if proc.returncode == 2:
        raise RuntimeError(f"atcn-local rejected the job file: {proc.stderr.strip()}")
    return {"reconciliation": json.loads(proc.stdout)}


def build_graph():
    graph = StateGraph(JobState)
    graph.add_node("search", search)
    graph.add_node("enrich", enrich)
    graph.add_node("draft", draft)
    graph.add_node("reconcile", reconcile)
    graph.add_edge(START, "search")
    graph.add_edge("search", "enrich")
    graph.add_edge("enrich", "draft")
    graph.add_edge("draft", "reconcile")
    graph.add_edge("reconcile", END)
    return graph.compile()


def money(minor: int, currency: str) -> str:
    return f"{currency} {minor / 100:.2f}"


def main() -> int:
    print("ATCN + LangGraph: one customer job, three paid services, reconciled\n")
    state = build_graph().invoke({"customer_ref": "customer-42", "company": "Acme Gears Ltd", "notes": [], "delegations": []})
    result = state["reconciliation"]

    for d in state["delegations"]:
        print(f"  {d['external_ref']:8} {d['provider_name_stated']:18} job {d['provider_job_ref']}")
    print("\nroll-up")
    for currency, t in result["totals"].items():
        print(f"  net cost {money(t['net_cost'], currency)} (charged {money(t['charged'], currency)})")
        print(f"  reported paid {money(t['reported_paid'], currency)}, unresolved {money(t['unresolved'], currency)}")
    print(f"\nopen exceptions: {len(result['open_exceptions'])}")
    for x in result["open_exceptions"]:
        print(f"  {x['kind']}: {x['detail']}")
    print("\noffline verification")
    print(f"  {'VALID  ' if result['valid'] else 'INVALID'} task closure")
    files = result["files"]
    print(f"\nre-verify: npx atcn-verify {os.path.relpath(files['closure'])} --keys {os.path.relpath(files['keys'])}")
    print("\nThe three services are local stand-ins (services.py); no external calls were made.")
    return 0 if result["valid"] else 1


if __name__ == "__main__":
    sys.exit(main())

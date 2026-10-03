"""End-to-end subledger flow against a running API: Python-signed statements and countersignatures are verified by the service.

Runs when ATCN_BASE_URL and ATCN_API_KEY (an admin-scope key for that API) are set.
"""

import os
import uuid

import pytest

from atcn import CaptureQueue, ReceiptLinkClient, SubledgerClient, generate_key_pair

BASE_URL = os.environ.get("ATCN_BASE_URL")
API_KEY = os.environ.get("ATCN_API_KEY")

pytestmark = pytest.mark.skipif(not BASE_URL or not API_KEY, reason="set ATCN_BASE_URL and ATCN_API_KEY (admin scope)")


def test_python_receipt_response_and_operator_countersignature():
    run = uuid.uuid4().hex[:10]
    client = SubledgerClient(BASE_URL, API_KEY)
    provider_private, provider_public = generate_key_pair()
    provider = client.create_provider({"name": f"Python Provider {run}"})
    binding = client.bind_provider_key(provider["provider_id"], f"py-prov-{run}", provider_public)

    queue = CaptureQueue(client)
    queue.task({"external_ref": f"py-{run}", "currency": "USD"})
    queue.delegation(f"ext:py-{run}", {"external_ref": f"py-{run}-a", "currency": "USD", "provider_id": provider["provider_id"]})
    queue.delegation_event(f"ext:py-{run}-a", {"type": "completion", "note": "delivered"}, f"py-{run}-done")
    queue.financial_event({"type": "charge", "source": "python-sdk", "source_event_id": f"py-{run}-ch", "amount_minor": 1200, "currency": "USD", "event_date": "2026-10-01T00:00:00.000Z", "match": {"delegation_external_ref": f"py-{run}-a"}})
    assert queue.flush() == {"sent": 4, "failed": 0, "remaining": 0}

    task = client.get_task(f"ext:py-{run}")
    task_id = task["task"]["task_id"]
    delegation_id = task["delegations"][0]["delegation_id"]
    assert client.financial_summary(task_id)["totals_by_currency"]["USD"]["net_cost"] == 1200

    created = client.create_receipt(task_id, delegation_id)
    receipt = created["receipt"]
    share = client.create_receipt_share(receipt["payload"]["receipt_id"], ["view", "signed_attestation"])
    link = ReceiptLinkClient(BASE_URL, share["token"])
    current = link.current()
    ref = {"receipt_id": receipt["payload"]["receipt_id"], "digest": current["digest"], "revision": receipt["payload"]["revision"]}
    signing = {"binding_id": binding["binding_id"], "key_id": f"py-prov-{run}", "private_key": provider_private, "issuer_operator_id": receipt["payload"]["issuer"]["operator_id"]}
    response = link.respond(ref, "signed_attestation", ["delivery.status"], signing=signing)
    assert "provider_key_signed" in response["assurance"]

    operator_private, operator_public = generate_key_pair()
    client.register_operator_key(f"py-ops-{run}", operator_public)
    closed = client.close_task(task_id)
    signature = client.countersign(closed["closure"], f"py-ops-{run}", operator_private)
    assert signature["key_id"] == f"py-ops-{run}"
    exported = client.get_closure(task_id)
    assert [s["key_id"] for s in exported["operator_signatures"]] == [f"py-ops-{run}"]
    published = client.operator_keys(receipt["payload"]["issuer"]["operator_id"])["items"]
    assert any(k["key_id"] == f"py-ops-{run}" and k["public_key"] == operator_public for k in published)

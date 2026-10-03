"""Usage reporting: the shared settings file, explicit consent, environment opt-outs, and `python -m atcn init`."""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from atcn import SDK_VERSION
from atcn.__main__ import main
from atcn.usage import ask_to_share_usage, read_usage_settings, save_usage_choice, send_usage_report, settings_path, usage_status

EVENT = {"event": "task_closed", "sdk_version": "python/1.3.0", "workflow": "custom", "delegations": 2, "charges": 3}


@pytest.fixture
def collector():
    received: list[dict] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("content-length") or 0)
            received.append(json.loads(self.rfile.read(length)))
            self.send_response(202)
            self.end_headers()

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}/v1/usage-reports", received
    server.shutdown()


@pytest.fixture
def env(tmp_path):
    return {"ATCN_CONFIG_DIR": str(tmp_path)}


def answers(*lines):
    queue = list(lines)

    def read_line(_prompt):
        if not queue:
            raise EOFError
        return queue.pop(0)

    return read_line


def test_off_until_an_explicit_yes_and_a_collector_url(env):
    assert usage_status(env)["reason"] == "off: not chosen yet (run python -m atcn init)"
    save_usage_choice(True, env)
    assert usage_status(env)["reason"] == "off until a collector is configured (set ATCN_USAGE_URL)"
    assert usage_status({**env, "ATCN_USAGE_URL": "http://collector.test"})["enabled"] is True


def test_opt_out_deletes_the_installation_id_and_environment_wins(env):
    first = save_usage_choice(True, env)["installation_id"]
    assert save_usage_choice(True, env)["installation_id"] == first
    with_url = {**env, "ATCN_USAGE_URL": "http://collector.test"}
    assert usage_status({**with_url, "DO_NOT_TRACK": "1"})["reason"] == "off: DO_NOT_TRACK is set"
    assert usage_status({**with_url, "ATCN_USAGE_DISABLED": "true"})["reason"] == "off: ATCN_USAGE_DISABLED is set"
    assert save_usage_choice(False, env)["installation_id"] is None
    assert json.loads(settings_path(env).read_text())["installation_id"] is None


def test_reads_the_settings_format_the_typescript_sdk_writes(env, tmp_path):
    (tmp_path / "usage.json").write_text('{\n  "share_usage": true,\n  "installation_id": "6f1c1f4e-8a0e-4c39-9d5a-3f1f0f6f2a10",\n  "decided_at": "2026-10-03T00:00:00.000Z"\n}\n')
    assert usage_status({**env, "ATCN_USAGE_URL": "http://collector.test"})["installation_id"] == "6f1c1f4e-8a0e-4c39-9d5a-3f1f0f6f2a10"


def test_consent_needs_an_explicit_answer_and_saves_nothing_on_end_of_input(env):
    assert ask_to_share_usage(answers("", "maybe", "yes"), lambda _line: None, env) is True
    assert read_usage_settings(env)["share_usage"] is True
    fresh = {"ATCN_CONFIG_DIR": env["ATCN_CONFIG_DIR"] + "/other"}
    assert ask_to_share_usage(answers(""), lambda _line: None, fresh) is None
    assert read_usage_settings(fresh) is None


def test_sends_only_after_a_yes_and_never_raises(env, collector):
    url, received = collector
    with_url = {**env, "ATCN_USAGE_URL": url}
    assert send_usage_report(EVENT, with_url) is False
    installation_id = save_usage_choice(True, env)["installation_id"]
    assert send_usage_report(EVENT, with_url) is True
    assert received == [{**EVENT, "installation_id": installation_id, "occurred_at": received[0]["occurred_at"]}]
    assert received[0]["occurred_at"].endswith("Z")
    assert send_usage_report(EVENT, {**env, "ATCN_USAGE_URL": "http://127.0.0.1:9/v1/usage-reports"}) is False


def test_init_command(env, collector):
    url, received = collector
    with_url = {**env, "ATCN_USAGE_URL": url}
    output: list[str] = []
    assert main(["init", "--share-usage", "yes"], write=output.append, env=with_url) == 0
    assert received == [{"installation_id": read_usage_settings(env)["installation_id"], "event": "integration_initialized", "occurred_at": received[0]["occurred_at"], "sdk_version": f"python/{SDK_VERSION}", "workflow": "custom", "delegations": None, "charges": None}]
    assert output[-1].startswith("Usage metrics: on")

    assert main(["init"], read_line=answers("n"), write=output.append, interactive=True, env=with_url) == 0
    assert read_usage_settings(env) == {**read_usage_settings(env), "share_usage": False, "installation_id": None}
    assert len(received) == 1

    assert main(["init"], write=output.append, interactive=False, env=with_url) == 2
    assert main(["init", "--share-usage", "maybe"], write=output.append, env=with_url) == 2
    assert main(["start"], write=output.append, env=with_url) == 2

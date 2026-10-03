"""Opt-in anonymous usage reporting: the saved choice (the same file the TypeScript SDK uses) and the sender.

The SDK client never reports anything; only `python -m atcn init` does, after an explicit yes.
"""

import json
import os
import urllib.request
import uuid
from collections.abc import Callable, Mapping
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# The ATCN-operated collector. There is none yet, so reports are only sent when ATCN_USAGE_URL is set.
DEFAULT_USAGE_URL: str | None = None

CONSENT_QUESTION = "Share anonymous usage metrics to help improve ATCN?"
CONSENT_EXPLANATION = "\n".join(
    [
        "If you answer yes, this machine sends: a random installation ID, the event (integration initialized, task closed,",
        "closure verified, exception resolved), a timestamp, the SDK version, whether it was a demo, and counts of",
        "delegations and charges. Never task data, references, amounts, names, or keys.",
        "Change your answer with `python -m atcn init`, or turn reporting off with ATCN_USAGE_DISABLED=1. Details: docs/USAGE_DATA.md",
    ]
)

Env = Mapping[str, str]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _is_set(value: str | None) -> bool:
    return value is not None and value != "" and value != "0" and value.lower() != "false"


def settings_path(env: Env | None = None) -> Path:
    env = os.environ if env is None else env
    config_dir = env.get("ATCN_CONFIG_DIR") or str(Path.home() / ".config" / "atcn")
    return Path(config_dir) / "usage.json"


def read_usage_settings(env: Env | None = None) -> dict[str, Any] | None:
    path = settings_path(env)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def save_usage_choice(share_usage: bool, env: Env | None = None) -> dict[str, Any]:
    """Saves an explicit choice. Opting in keeps an existing installation ID or creates a random one; opting out deletes it."""
    previous = read_usage_settings(env) or {}
    settings = {
        "share_usage": share_usage,
        "installation_id": (previous.get("installation_id") or str(uuid.uuid4())) if share_usage else None,
        "decided_at": _now(),
    }
    path = settings_path(env)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(settings, indent=2) + "\n")
    return settings


def disabled_by(env: Env | None = None) -> str | None:
    """The environment variable that turns reporting off, if one is set. It wins over any saved choice."""
    env = os.environ if env is None else env
    for name in ("ATCN_USAGE_DISABLED", "DO_NOT_TRACK"):
        if _is_set(env.get(name)):
            return name
    return None


def usage_status(env: Env | None = None) -> dict[str, Any]:
    """Reporting is on only after an explicit yes, and ATCN_USAGE_DISABLED or DO_NOT_TRACK always turn it off."""
    env = os.environ if env is None else env
    url = env.get("ATCN_USAGE_URL") or DEFAULT_USAGE_URL

    def off(reason: str) -> dict[str, Any]:
        return {"enabled": False, "reason": reason, "installation_id": None, "url": url}

    variable = disabled_by(env)
    if variable:
        return off(f"off: {variable} is set")
    settings = read_usage_settings(env)
    if settings is None:
        return off("off: not chosen yet (run python -m atcn init)")
    if not settings.get("share_usage") or not settings.get("installation_id"):
        return off("off: you chose not to share usage metrics")
    if not url:
        return off("off until a collector is configured (set ATCN_USAGE_URL)")
    return {"enabled": True, "reason": f"on: sharing anonymous usage metrics with {url}", "installation_id": settings["installation_id"], "url": url}


def send_usage_report(event: dict[str, Any], env: Env | None = None, timeout: float = 2.0) -> bool:
    """Sends one report if the user opted in, adding the installation ID and timestamp. Never raises."""
    status = usage_status(env)
    if not status["enabled"]:
        return False
    report = {"installation_id": status["installation_id"], "occurred_at": _now(), **event}
    request = urllib.request.Request(status["url"], data=json.dumps(report).encode("utf-8"), method="POST", headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return 200 <= response.status < 300
    except Exception:
        return False


def ask_to_share_usage(read_line: Callable[[str], str] = input, write: Callable[[str], Any] = print, env: Env | None = None) -> bool | None:
    """Asks the question and saves the answer. Only y/yes or n/no count; anything else asks again.

    Returns None, saving nothing, if the input ends before an answer.
    """
    write(CONSENT_EXPLANATION)
    while True:
        try:
            answer = read_line(f"{CONSENT_QUESTION} [y/n] ").strip().lower()
        except EOFError:
            return None
        if answer in ("y", "yes"):
            return save_usage_choice(True, env)["share_usage"]
        if answer in ("n", "no"):
            return save_usage_choice(False, env)["share_usage"]

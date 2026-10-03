"""`python -m atcn init [--share-usage yes|no]`: records whether this machine shares anonymous usage metrics."""

import argparse
import sys
from collections.abc import Callable
from typing import Any

from .client import SDK_VERSION
from .usage import Env, ask_to_share_usage, save_usage_choice, send_usage_report, settings_path, usage_status


def main(argv: list[str] | None = None, read_line: Callable[[str], str] = input, write: Callable[[str], Any] = print, interactive: bool | None = None, env: Env | None = None) -> int:
    """Returns the exit code: 0 saved, 2 usage error or no answer. On a yes, reports integration_initialized."""
    parser = argparse.ArgumentParser(prog="python -m atcn")
    parser.add_argument("command", choices=["init"])
    parser.add_argument("--share-usage", choices=["yes", "no"])
    try:
        args = parser.parse_args(argv)
    except SystemExit as exit_:
        return int(exit_.code or 0)

    if args.share_usage is not None:
        shared: bool | None = save_usage_choice(args.share_usage == "yes", env)["share_usage"]
    elif interactive if interactive is not None else sys.stdin.isatty():
        shared = ask_to_share_usage(read_line, write, env)
    else:
        write("Not an interactive terminal: pass --share-usage yes or --share-usage no.")
        return 2
    if shared is None:
        write("No answer given; nothing saved.")
        return 2

    if shared:
        send_usage_report({"event": "integration_initialized", "sdk_version": f"python/{SDK_VERSION}", "workflow": "custom", "delegations": None, "charges": None}, env)
    write(f"Saved your choice to {settings_path(env)}.")
    write(f"Usage metrics: {usage_status(env)['reason']}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""One-statement JSON-lines Snowflake reader for the controlled beta.

The Node parent sends only one statement at a time. This worker confirms the
actual execution start, keeps one authenticated read-only connection in memory,
and never writes query text or customer rows to disk.
"""

from __future__ import annotations

import builtins
from contextlib import contextmanager, redirect_stdout
import io
import json
import os
import sys
import tomllib
import time
from typing import Any
import webbrowser


def emit(payload: dict[str, Any], output) -> None:
    output.write(json.dumps(payload, default=str, separators=(",", ":")) + "\n")
    output.flush()


class SnowflakeSignInRequired(Exception):
    """No browser or console authentication is allowed inside a case read."""


class DiscardSdkOutput(io.TextIOBase):
    def write(self, value):
        # Discard immediately. Do not buffer, persist or inspect SDK notices;
        # they can contain authentication URLs and credentials.
        return len(value)


@contextmanager
def noninteractive_sdk_boundary():
    """Keep normal SDK credential-cache behaviour, but stop interactive SSO.

    Snowflake's external-browser authenticator prints to stdout, can open a
    browser, and can read input() if that fails. In this serial, dedicated
    worker those actions must not corrupt or consume the JSON-lines protocol.
    This changes no authenticator, credential, validation or source permission.
    """
    def require_sign_in(*_args, **_kwargs):
        raise SnowflakeSignInRequired()
    original_input = builtins.input
    browser_methods = {name: getattr(webbrowser, name) for name in ("open", "open_new", "open_new_tab")}
    try:
        builtins.input = require_sign_in
        for name in browser_methods:
            setattr(webbrowser, name, require_sign_in)
        with redirect_stdout(DiscardSdkOutput()):
            yield
    finally:
        builtins.input = original_input
        for name, method in browser_methods.items():
            setattr(webbrowser, name, method)


def main() -> int:
    # Capture the IPC sink before redirecting SDK output. Only our structured
    # acknowledgements/results use it, never a raw SDK message.
    protocol_output = sys.stdout
    send = lambda payload: emit(payload, protocol_output)
    try:
        with noninteractive_sdk_boundary():
            import snowflake.connector
    except Exception as error:
        # No exception message, path, credentials, or query text crosses this
        # diagnostic boundary. Dependency failure is distinct from a timeout.
        send({"event": "bootstrap_failed", "error_type": type(error).__name__})
        return 1

    connections: dict[str, Any] = {}

    def open_connection(connection_name: str):
        existing = connections.get(connection_name)
        if existing is not None:
            return existing
        config_path = os.environ["CSM_COPILOT_SNOWFLAKE_CONFIG"]
        with open(config_path, "rb") as source:
            config = tomllib.load(source)
        parameters = config.get("connections", {}).get(connection_name)
        if not isinstance(parameters, dict):
            raise ValueError("named connection unavailable")
        connection = snowflake.connector.connect(**parameters)
        connections[connection_name] = connection
        return connection

    def run_query(request: dict[str, Any]) -> dict[str, Any]:
        phase = "connection_start"
        timings: dict[str, int] = {}
        connection_started = time.monotonic()
        try:
            with noninteractive_sdk_boundary():
                started = time.monotonic()
                connection = open_connection(request["connection_name"])
                timings["connection_start_ms"] = round((time.monotonic() - started) * 1000)
                with connection.cursor() as cursor:
                    # This acknowledgement follows connection setup and precedes
                    # execution. It is the source of truth for the parent timer.
                    send({"id": request["id"], "event": "started", "timings": timings})
                    phase = "statement_execution"
                    started = time.monotonic()
                    cursor.execute(request["sql"])
                    timings["statement_execution_ms"] = round((time.monotonic() - started) * 1000)
                    phase = "fetch_results"
                    send({"id": request["id"], "event": "phase", "phase": phase, "timings": timings})
                    started = time.monotonic()
                    columns = [column[0] for column in (cursor.description or [])]
                    values = cursor.fetchall()
                    timings["fetch_results_ms"] = round((time.monotonic() - started) * 1000)
                    phase = "serialization"
                    send({"id": request["id"], "event": "phase", "phase": phase, "timings": timings})
                    started = time.monotonic()
                    rows = [dict(zip(columns, row)) for row in values]
                    timings["serialization_ms"] = round((time.monotonic() - started) * 1000)
            return {"id": request["id"], "ok": True, "rows": rows, "timings": timings}
        except Exception as error:
            if phase == "connection_start":
                timings["connection_start_ms"] = round((time.monotonic() - connection_started) * 1000)
            return {
                "id": request["id"], "ok": False,
                "code": "SIGN_IN_REQUIRED" if isinstance(error, SnowflakeSignInRequired) else "QUERY_FAILED",
                "error_type": type(error).__name__, "error_number": getattr(error, "errno", None),
                "sqlstate": getattr(error, "sqlstate", None),
                "failure_stage": "authentication" if isinstance(error, SnowflakeSignInRequired) else phase,
                "timings": timings,
            }

    try:
        for line in sys.stdin:
            try:
                request = json.loads(line)
                request_id = request["id"]
                action = request["action"]
            except (KeyError, TypeError, json.JSONDecodeError):
                send({"id": None, "ok": False, "code": "INVALID_REQUEST"})
                continue
            if action == "close":
                send({"id": request_id, "ok": True, "closed": True})
                return 0
            if action != "query" or not isinstance(request.get("sql"), str):
                send({"id": request_id, "ok": False, "code": "INVALID_REQUEST"})
                continue
            send(run_query(request))
    finally:
        for connection in connections.values():
            try:
                with noninteractive_sdk_boundary():
                    connection.close()
            except Exception:
                pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Tests the real worker with a deliberately noisy, entirely invented SDK."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
import webbrowser

worker_path = Path(sys.argv.pop())
spec = importlib.util.spec_from_file_location("invented_worker", worker_path)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class Cursor:
    description = [("VALUE",)]

    def __enter__(self):
        print("invented private cursor notice")
        return self

    def __exit__(self, *_args):
        print("invented private cursor close notice")

    def execute(self, _sql):
        print("invented private execution notice")

    def fetchall(self):
        print("invented private fetch notice")
        return [(7,)]


class Connection:
    def __init__(self, closed=False):
        self.closed = closed

    def is_closed(self):
        return self.closed

    def cursor(self):
        return Cursor()

    def close(self):
        print("invented private connection close notice")
        self.closed = True


class WorkerProtocolTests(unittest.TestCase):
    def run_worker(self, connect, request_count=1):
        connector = types.ModuleType("snowflake.connector")
        connector.connect = connect
        snowflake = types.ModuleType("snowflake")
        snowflake.connector = connector
        output = io.StringIO()
        requests = "".join(json.dumps({"id": str(index), "action": "query",
            "connection_name": "invented", "sql": "invented private statement"}) + "\n"
            for index in range(request_count))
        with tempfile.TemporaryDirectory(prefix="csm-invented-worker-") as temp:
            config = Path(temp) / "config.toml"
            config.write_text('[connections.invented]\naccount="example.invalid"\nauthenticator="externalbrowser"\n')
            with patch.dict(sys.modules, {"snowflake": snowflake, "snowflake.connector": connector}), \
                    patch.dict(os.environ, {"CSM_COPILOT_SNOWFLAKE_CONFIG": str(config)}), \
                    patch("sys.stdin", io.StringIO(requests)), contextlib.redirect_stdout(output):
                status = worker.main()
        return status, output.getvalue()

    def test_noisy_sdk_never_contaminates_protocol(self):
        def connect(**_kwargs):
            print("invented private auth URL and token")
            return Connection()
        status, output = self.run_worker(connect)
        messages = [json.loads(line) for line in output.splitlines()]
        self.assertEqual(status, 0)
        self.assertEqual(messages[-1]["rows"], [{"VALUE": 7}])
        self.assertNotIn("invented private", output)

    def test_cached_connection_is_reused_without_an_interactive_prompt(self):
        calls = []
        def connect(**_kwargs):
            calls.append(1)
            return Connection()
        _, output = self.run_worker(connect, request_count=2)
        self.assertEqual(len(calls), 1)
        self.assertEqual(sum(message.get("ok") is True for message in map(json.loads, output.splitlines())), 2)

    def test_browser_reauthentication_stops_without_opening_a_browser(self):
        opened = []
        def connect(**_kwargs):
            print("invented private reauthentication URL")
            webbrowser.open_new("https://example.invalid/invented-sign-in")
            return Connection()
        with patch("webbrowser.open_new", side_effect=lambda *_args: opened.append(1)):
            _, output = self.run_worker(connect)
        messages = list(map(json.loads, output.splitlines()))
        self.assertEqual(opened, [])
        self.assertFalse(any(message.get("event") == "started" for message in messages))
        self.assertEqual(messages[-1]["code"], "SIGN_IN_REQUIRED")
        self.assertEqual(messages[-1]["failure_stage"], "authentication")
        self.assertNotIn("invented private", output)

    def test_console_reauthentication_never_consumes_the_next_ipc_request(self):
        prompts = []
        def connect(**_kwargs):
            input("invented private sign-in prompt")
            return Connection()
        with patch("builtins.input", side_effect=lambda *_args: prompts.append(1)):
            _, output = self.run_worker(connect, request_count=2)
        messages = list(map(json.loads, output.splitlines()))
        self.assertEqual(prompts, [])
        self.assertEqual([message["id"] for message in messages], ["0", "1"])
        self.assertTrue(all(message.get("code") == "SIGN_IN_REQUIRED" for message in messages))


if __name__ == "__main__":
    unittest.main()

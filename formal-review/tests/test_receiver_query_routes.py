"""Loopback HTTP regression tests with synthetic data and no Alibaba requests."""
from http.client import HTTPConnection
from http.server import HTTPServer
import json
from pathlib import Path
import sys
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import workflow
from collection.receiver import Handler


class ReceiverQueryRoutesTests(unittest.TestCase):
    def setUp(self):
        state = {"runId": "synthetic-run", "status": "active", "rulesSha256": "synthetic-rules"}
        self.bridge = SimpleNamespace(
            kind="profile", run="synthetic-run", state=state, secret="synthetic-secret",
            deadline=time.monotonic() + 60, started="synthetic-start", stopped=False,
            closed=False, done={}, queue={"synthetic": {"buyerProfileLink":
                "https://profile.alibaba.com/profile/my_profile.htm?m=synthetic"}},
            code=Mock(return_value="async () => ({synthetic: true})"),
            verify_store=Mock(), next_row=Mock(return_value={"lease": None, "rows": []}),
            accept=Mock(), append=Mock())
        for target, value in (("load_state", state), ("rules_hash", "synthetic-rules"), ("inspect", (3, []))):
            patched = patch.object(workflow, target, return_value=value)
            patched.start()
            self.addCleanup(patched.stop)
        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.server.bridge = self.bridge
        self.server.identity = {"runId": "synthetic-run", "kind": "profile"}
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()
        self.addCleanup(self.close_server)

    def close_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def request(self, method, path, body=None, *, origin="https://profile.alibaba.com", credential="synthetic-secret", extra=None):
        headers = {"Authorization": "Bearer " + credential, **(extra or {})}
        if origin is not None:
            headers["Origin"] = origin
        if body is not None:
            headers["Content-Type"] = "application/json"
        connection = HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        try:
            connection.request(method, path, body=None if body is None else json.dumps(body), headers=headers)
            response = connection.getresponse()
            data = response.read()
            return response.status, data
        finally:
            connection.close()

    def test_get_and_post_routes_ignore_query_only(self):
        for suffix in ("", "?cache=synthetic&empty=&encoded=%2Fnext"):
            for path in ("/collector.js", "/status", "/profile-url"):
                with self.subTest(path=path + suffix):
                    self.assertEqual(self.request("GET", path + suffix)[0], 200)
            for path in ("/next", "/results", "/failure"):
                with self.subTest(path=path + suffix):
                    self.assertEqual(self.request("POST", path + suffix, {"runId": "synthetic-run"})[0], 200)
        self.assertEqual(self.bridge.accept.call_count, 2)
        self.assertEqual(self.bridge.next_row.call_count, 2)

    def test_query_does_not_supply_credentials_origin_or_run_identity(self):
        suffix = "?Authorization=synthetic-secret&runId=synthetic-run"
        for options in ({"credential": "wrong"}, {"origin": "https://evil.example"}, {"origin": None},
                        {"extra": {"Host": "evil.example"}}):
            with self.subTest(options=options):
                self.assertEqual(self.request("GET", "/collector.js" + suffix, **options)[0], 403)
                self.assertEqual(self.request("POST", "/next" + suffix, {"runId": "synthetic-run"}, **options)[0], 400)
        self.assertEqual(self.request("POST", "/next" + suffix, {"runId": "wrong"})[0], 400)
        self.bridge.next_row.assert_not_called()

    def test_local_status_keeps_control_exception_but_not_collection_access(self):
        self.bridge.state["status"] = "paused"
        self.assertEqual(self.request("GET", "/status?cache=synthetic", origin=None)[0], 200)
        self.assertEqual(self.request("GET", "/collector.js?cache=synthetic")[0], 403)
        self.assertEqual(self.request("POST", "/next?cache=synthetic", {"runId": "synthetic-run"})[0], 400)
        self.bridge.state["status"] = "active"
        self.assertEqual(self.request("GET", "/profile-url?cache=synthetic", origin=None)[0], 200)

    def test_unknown_encoded_or_traversal_paths_are_not_normalized_into_routes(self):
        for path in ("/missing", "/next/", "/../next", "/%6eext", "/collector.js/extra", "/%2fcollector.js"):
            with self.subTest(path=path):
                self.assertEqual(self.request("GET", path + "?cache=synthetic")[0], 404)
                self.assertEqual(self.request("POST", path + "?cache=synthetic", {"runId": "synthetic-run"})[0], 404)
        self.bridge.accept.assert_not_called()
        self.bridge.next_row.assert_not_called()


if __name__ == "__main__":
    unittest.main()

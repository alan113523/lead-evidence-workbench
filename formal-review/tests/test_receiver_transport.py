"""Real loopback regressions for idle browser sockets and bridge serialization."""
import os
import socket
import threading
import time
import unittest
from unittest.mock import patch

import test_receiver_query_routes as fixtures
from collection.receiver import Handler, ReceiverServer


class ReceiverTransportTests(unittest.TestCase):
    def setUp(self):
        self.accepted = threading.Event()
        accepted = self.accepted

        class ObservedHandler(Handler):
            def setup(self):
                super().setup()
                accepted.set()

        self.fixture = fixtures.ReceiverQueryRoutesTests()
        with patch.object(fixtures, 'HTTPServer', ReceiverServer), patch.object(fixtures, 'Handler', ObservedHandler):
            self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)

    def test_idle_socket_does_not_block_authenticated_request(self):
        idle = socket.create_connection(('127.0.0.1', self.fixture.server.server_port), timeout=2)
        try:
            self.assertTrue(self.accepted.wait(2), 'idle socket was not accepted')
            status, _ = self.fixture.request('GET', '/collector.js?transport=synthetic')
            self.assertEqual(status, 200)
        finally:
            idle.close()

    def test_bridge_operations_remain_serial_across_connections(self):
        active = 0
        maximum = 0
        statuses = []
        errors = []
        start = threading.Barrier(3)

        def next_row():
            nonlocal active, maximum
            active += 1
            maximum = max(maximum, active)
            time.sleep(0.1)
            active -= 1
            return {'lease': None, 'rows': []}

        def request():
            try:
                start.wait(timeout=2)
                statuses.append(self.fixture.request('POST', '/next', {'runId': 'synthetic-run'})[0])
            except Exception as error:
                errors.append(type(error).__name__)

        self.fixture.bridge.next_row.side_effect = next_row
        threads = [threading.Thread(target=request) for _ in range(2)]
        for thread in threads:
            thread.start()
        start.wait(timeout=2)
        for thread in threads:
            thread.join(timeout=4)
            self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(statuses, [200, 200])
        self.assertEqual(maximum, 1)

    def test_shutdown_rejects_later_operations(self):
        body = {'runId': 'synthetic-run', 'startedAt': 'synthetic-start', 'pid': os.getpid()}
        self.assertEqual(self.fixture.request('POST', '/shutdown', body, origin=None)[0], 200)
        self.assertEqual(self.fixture.request('GET', '/status', origin=None)[0], 403)
        self.assertEqual(self.fixture.request('POST', '/next', {'runId': 'synthetic-run'})[0], 400)
        self.fixture.bridge.next_row.assert_not_called()


if __name__ == '__main__':
    unittest.main()

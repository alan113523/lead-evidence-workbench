"""Synthetic collection -> shared workflow; no Alibaba access or real customer fixture."""
import copy
from http.server import HTTPServer
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT/"scripts"), str(ROOT/"examples"), str(ROOT/"hooks")]
import workflow as w
import codex_guard
from collection import collect as c
from collection.receiver import Bridge, Handler, control
from extract_research_view import Invalid, atomic, digest, now, read_json, validate_pair
from synthetic_demo import fill, source


def wrapper(count=3):
    rows = [{"customerId": r["crmCustomerId"], "companyName": r["customerDetail"]["companyName"],
             "loginId": r["buyerLoginId"]} for r in source(count)["records"]]
    start = int(c.datetime(2026, 10, 4, tzinfo=c.timezone(c.timedelta(hours=8))).timestamp())
    return {"status": 200, "ok": True, "capturedAt": now(),
            "criteria": {"startDate": "2026-10-04", "endDate": "2026-10-05", "salesName": "全部", "salesId": None,
                         "pageSize": 500, "total": count, "recordsCollected": count},
            "requestBody": {"jsonArray": json.dumps([{"id": "667", "gmt_create_start": str(start), "gmt_create_end": str(start+86400)}])},
            "json": {"success": True, "data": {"total": count, "data": rows}}}


class CollectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        browser_map = self.base/"browser-map.json"
        atomic(browser_map, {"schema_version": "alibaba-store-browser-map-v1", "bindings": [{
            "schema_version": "alibaba-store-proof-v1", "store_key": "demobeta", "store_host": "demobeta.en.alibaba.com",
            "source_url": "https://i.alibaba.com/ajax/sellerProfileAjax.do", "observed_at_ms": int(time.time()*1000),
            "request_id": "synthetic-discovery", "browser_binding": {"channel": "chrome-devtools", "browser_id": "synthetic-native"}}]})
        config = c.configuration("2026-10-04", store="demobeta", browser_map=browser_map)
        self.run = Path(w.initialize(None, None, self.base, collect_config=config, session="synthetic-collection")["run"])
        self.state = w.load_state(self.run)

    def tearDown(self):
        self.temp.cleanup()

    def proof(self, bridge):
        return {"schema_version": "alibaba-store-proof-v1", "store_key": "demobeta", "store_host": "demobeta.en.alibaba.com",
                "source_url": "https://i.alibaba.com/ajax/sellerProfileAjax.do", "observed_at_ms": int(time.time()*1000),
                "request_id": bridge.identity_request, "browser_binding": bridge.browser_binding}

    def payload(self, bridge, body):
        return {**body, "storeProof": bridge.store_proof or self.proof(bridge)}

    def save_list(self, count=3):
        b = Bridge(self.run, self.state, "list")
        b.accept(self.payload(b, {"runId": self.run.name, "kind": "list", "value": wrapper(count)}))
        return w.advance(self.run)

    def test_collection_to_research_full_flow_and_source_tamper(self):
        self.assertEqual(self.save_list()["nextStage"], "collection.customer_detail_done")
        with self.assertRaises(Invalid):
            w.advance(self.run, finalize=True)
        records = source()["records"]
        for i, r in enumerate(records[:2]):
            # Preserve the exact private locator; normalization is navigation-only.
            link = f" http://profile.alibaba.com/profile/my_profile.htm?m=synthetic-{i}#anchor "
            r["customerDetail"]["fieldsMissingFromList"]["contacts"][0]["buyerProfileLink"] = link
            r["buyerHomepage"].update(buyerProfileLink=link, profileUrl=link)
        bridge = Bridge(self.run, w.load_state(self.run), "detail")
        for i, record in enumerate(records):
            batch = bridge.next_row()
            cid = batch["rows"][0]["customerId"]
            self.assertEqual(cid, record["crmCustomerId"])
            bridge.accept(self.payload(bridge, {"runId": self.run.name, "kind": "detail", "lease": batch["lease"], "results": [record["customerDetail"]]}))
            if i == 0:
                bridge = Bridge(self.run, w.load_state(self.run), "detail")
                self.assertEqual(len(bridge.done), 1)
        self.assertEqual(bridge.next_row()["rows"], [])
        w.advance(self.run)
        w.advance(self.run)
        bridge = Bridge(self.run, w.load_state(self.run), "profile")
        for record in records[:2]:
            batch = bridge.next_row()
            bridge.accept(self.payload(bridge, {"runId": self.run.name, "kind": "profile", "lease": batch["lease"], "results": [record["buyerHomepage"]]}))
        for _ in range(3):
            result = w.advance(self.run)
        self.assertEqual(result["nextStage"], "research.input_validated")
        self.assertEqual(c.diagnose(self.run, devtools_authorized=True, host_allows_devtools=True)["code"], "COLLECTION_COMPLETE")
        state = w.load_state(self.run)
        self.assertEqual(len(validate_pair(state["inputs"]["json"]["path"], state["inputs"]["xlsx"]["path"])["records"]), 3)
        full = read_json(state["inputs"]["json"]["path"])
        self.assertEqual(full["records"][0]["buyerHomepage"]["profileUrl"], records[0]["buyerHomepage"]["profileUrl"])
        w.advance(self.run)
        w.advance(self.run)
        fill(self.run, 0)
        for _ in range(5):
            result = w.advance(self.run)
        self.assertTrue(result["complete"])
        self.assertEqual(len(result["checks"]), 13)
        self.assertNotIn("profile.alibaba.com", (self.run/"report.md").read_text(encoding="utf-8"))
        data = c.folder(self.run)/"detail_missing_fields.jsonl"
        with data.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(records[0]["customerDetail"])+"\n")
        self.assertFalse(w.status(self.run)["complete"])
        self.assertEqual(w.status(self.run)["nextStage"], "collection.customer_detail_done")

    def test_zero_customers_is_not_six_fake_passes(self):
        result = self.save_list(0)
        self.assertTrue(result["complete"])
        self.assertEqual(result["status"], "completed_no_customers")
        self.assertEqual(result["checks"]["collection.customer_detail_done"], "not_applicable_no_customers")
        self.assertFalse((self.run/"research.json").exists())
        self.assertFalse((self.run/"matched.pdf").exists())
        value = read_json(c.folder(self.run)/"list.wrapper.json")
        value["json"]["success"] = False
        atomic(c.folder(self.run)/"list.wrapper.json", value)
        self.assertFalse(w.status(self.run)["complete"])

    def test_nonempty_no_profile_links_still_exports_pair(self):
        self.save_list(1)
        bridge = Bridge(self.run, w.load_state(self.run), "detail")
        batch = bridge.next_row()
        bridge.accept(self.payload(bridge, {"runId": self.run.name, "kind": "detail", "lease": batch["lease"],
                       "results": [source(1)["records"][0]["customerDetail"]]}))
        for _ in range(5):
            result = w.advance(self.run)
        self.assertEqual(result["nextStage"], "research.input_validated")
        proof = w.load_state(self.run)["proofs"]["collection.buyer_profile_done"]
        self.assertEqual(proof["summary"]["buyerProfileStatus"], "skipped_no_profile_links")
        self.assertFalse(result["complete"])
        self.assertTrue(c.paths(self.run, self.state)[2].exists())

    def test_invalid_empty_dates_filters_counts_and_duplicate_rejected(self):
        mutations = [
            lambda v: v.update(status=403),
            lambda v: v["json"].update(success=False),
            lambda v: v["json"]["data"].pop("total"),
            lambda v: v["criteria"].update(startDate="2026-10-03"),
            lambda v: v["criteria"].update(recordsCollected=4),
            lambda v: v["requestBody"].update(jsonArray="[]"),
            lambda v: v["json"]["data"]["data"].__setitem__(1, v["json"]["data"]["data"][0]),
        ]
        for mutation in mutations:
            value = wrapper()
            mutation(value)
            with self.subTest(mutation=mutation), self.assertRaises((Invalid, ValueError)):
                c.wrapper_check(value, self.state)

    def test_cross_run_wrong_identity_duplicate_and_reviewed_resume(self):
        self.save_list()
        b = Bridge(self.run, w.load_state(self.run), "detail")
        batch = b.next_row()
        payload = {"runId": self.run.name, "kind": "detail", "lease": batch["lease"], "results": [source()["records"][0]["customerDetail"]]}
        for mutation in (lambda p: p.update(runId="different"), lambda p: p.update(lease="unissued"),
                         lambda p: p["results"][0].update(customerId="unknown")):
            wrong = copy.deepcopy(payload)
            mutation(wrong)
            with self.assertRaises(Invalid):
                b.accept(self.payload(b, wrong))
        cid = batch["rows"][0]["customerId"]
        b.accept(self.payload(b, {**payload, "results": [{"customerId": cid, "error": "secret must never be written"}]}))
        with self.assertRaises(Invalid):
            b.next_row()
        with self.assertRaises(Invalid):
            Bridge(self.run, w.load_state(self.run), "detail")
        resumed = Bridge(self.run, w.load_state(self.run), "detail", resume=True)
        batch = resumed.next_row()
        resumed.accept(self.payload(resumed, {**payload, "lease": batch["lease"]}))
        with self.assertRaises(Invalid):
            resumed.accept(self.payload(resumed, {**payload, "lease": batch["lease"]}))
        self.assertNotIn("secret must", (c.folder(self.run)/"errors.jsonl").read_text())

    def test_http_origin_credential_size_identity_and_malformed_json(self):
        server = HTTPServer(("127.0.0.1", 0), Handler)
        server.bridge = b = Bridge(self.run, self.state, "list")
        server.identity = {"runId": self.run.name, "kind": "list"}
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        def request(path, body=None, origin="https://alicrm.alibaba.com", credential=None, headers=None):
            options = {"Origin": origin, "Authorization": "Bearer "+(credential or b.secret), **(headers or {})}
            if body is not None:
                options["Content-Type"] = "application/json"
            return urlopen(Request(f"http://127.0.0.1:{server.server_port}"+path, data=body, headers=options), timeout=5)
        try:
            with request("/collector.js") as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(response.headers["Access-Control-Allow-Origin"], "https://alicrm.alibaba.com")
                self.assertNotEqual(response.headers["Access-Control-Allow-Origin"], "*")
            for origin, credential in [("https://evil.example", None), ("https://alicrm.alibaba.com", "wrong")]:
                with self.assertRaises(HTTPError):
                    request("/collector.js", origin=origin, credential=credential)
            with self.assertRaises(HTTPError):
                request("/results", b"{")
            with self.assertRaises(HTTPError):
                request("/results", b"{}", headers={"Content-Length": str(33*1024*1024)})
            value = json.dumps(self.payload(b, {"runId": self.run.name, "kind": "list", "value": wrapper(0)})).encode()
            with request("/results", value) as response:
                self.assertEqual(response.status, 200)
            with self.assertRaises(HTTPError):
                request("/results", value)
            self.assertTrue(w.advance(self.run)["complete"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_collection_hooks_block_research_shortcuts(self):
        payload = {"hook_event_name": "PreToolUse", "session_id": "synthetic-collection", "cwd": str(self.base),
                   "tool_name": "exec_command", "tool_input": {"cmd": f'python workflow.py finalize --run "{self.run}"'}}
        self.assertEqual(codex_guard.handle(payload)["hookSpecificOutput"]["permissionDecision"], "deny")
        payload.update(hook_event_name="Stop")
        for _ in range(2):
            self.assertEqual(codex_guard.handle(payload)["decision"], "block")
        self.assertNotIn("decision", codex_guard.handle(payload))

    def test_browser_collectors_offline(self):
        result = subprocess.run([shutil.which("node"), str(ROOT/"tests"/"collection_browser.cjs")], capture_output=True, text=True, encoding="utf-8", timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_store_binding_stops_swapped_stale_missing_and_previous_receiver_proofs(self):
        b = Bridge(self.run, self.state, "list")
        valid = self.proof(b)
        other = Bridge(self.run, self.state, "list")
        cases = [None, {**valid, "store_key": "demogamma", "store_host": "demogamma.en.alibaba.com"},
                 {**valid, "browser_binding": {"channel": "chrome-devtools", "browser_id": "other-native"}},
                 {**valid, "request_id": "another-run"}, {**valid, "observed_at_ms": 1}, self.proof(other)]
        for value in cases:
            with self.subTest(value=value), self.assertRaises(Invalid):
                b.accept({"runId": self.run.name, "kind": "list", "storeProof": value, "value": wrapper(0)})
        self.assertFalse((c.folder(self.run)/"list.wrapper.json").exists())
        self.assertFalse((c.folder(self.run)/"identity-list.jsonl").exists())
        b.accept({"runId": self.run.name, "kind": "list", "storeProof": valid, "value": wrapper(0)})
        self.assertTrue(w.advance(self.run)["complete"])
        self.assertEqual(w.load_state(self.run)["proofs"]["collection.input_resolved"]["summary"]["storeKey"], "demobeta")

    def test_three_store_routes_and_output_directories_are_distinct(self):
        routes = []
        for channel in ("chrome-devtools", "cua-cdp"):
            for store in ("demoalpha", "demobeta", "demogamma"):
                routes.append({**self.proof(Bridge(self.run, self.state, "list")), "store_key": store,
                               "store_host": store+".en.alibaba.com", "browser_binding": {"channel": channel, "browser_id": "synthetic-"+store}})
        file = self.base/"three-stores.json"
        atomic(file, {"schema_version": "alibaba-store-browser-map-v1", "bindings": routes})
        for row in routes:
            store = row["store_key"]
            config = c.configuration("2026-10-04", store=store, browser_map=file, channel=row["browser_binding"]["channel"])
            run = Path(w.initialize(None, None, self.base, collect_config=config)["run"])
            self.assertEqual(run.parent.parent.name, store)
            self.assertEqual(config["browserBinding"], row["browser_binding"])
        with self.assertRaises(Invalid):
            c.configuration("2026-10-04", store="demoalpha", browser_map=file)
        routes[0]["browser_binding"] = routes[1]["browser_binding"]
        atomic(file, {"schema_version": "alibaba-store-browser-map-v1", "bindings": routes})
        with self.assertRaises(Invalid):
            c.configuration("2026-10-04", store="demoalpha", browser_map=file)
        atomic(file, {"schema_version": "alibaba-store-browser-map-v1", "bindings": routes[3:]})
        self.assertEqual(c.configuration("2026-10-04", store="demoalpha", browser_map=file)["browserBinding"]["channel"], "cua-cdp")
        with self.assertRaises(Invalid):
            c.configuration("2026-10-04", store="demoalpha", browser_map=file, channel="chrome-devtools")
        with self.assertRaises(Invalid):
            c.configuration("2026-10-04", store="demoalpha", browser_map=file, channel="unknown")

    def cdp_run(self):
        file = self.base/"cdp-browser-map.json"
        row = {**self.proof(Bridge(self.run, self.state, "list")),
               "browser_binding": {"channel": "cua-cdp", "browser_id": "synthetic-cdp"}}
        atomic(file, {"schema_version": "alibaba-store-browser-map-v1", "bindings": [row]})
        config = c.configuration("2026-10-04", store="demobeta", browser_map=file, channel="cua-cdp")
        return Path(w.initialize(None, None, self.base, collect_config=config)["run"])

    def test_cdp_receiver_preserves_channel_and_proof_gates(self):
        run = self.cdp_run()
        bridge = Bridge(run, w.load_state(run), "list")
        valid = self.proof(bridge)
        for changes in ({"browser_binding": {"channel": "chrome-devtools", "browser_id": "synthetic-cdp"}},
                        {"browser_binding": {"channel": "cua-cdp", "browser_id": "another-browser"}},
                        {"store_key": "demogamma", "store_host": "demogamma.en.alibaba.com"},
                        {"observed_at_ms": 1}, {"request_id": "other-receiver"}):
            with self.subTest(changes=changes), self.assertRaises(Invalid):
                bridge.accept({"runId": run.name, "kind": "list", "storeProof": {**valid, **changes}, "value": wrapper(0)})
        self.assertFalse((c.folder(run)/"list.wrapper.json").exists())
        bridge.accept({"runId": run.name, "kind": "list", "storeProof": valid, "value": wrapper(0)})
        self.assertTrue(w.advance(run)["complete"])
        summary = w.load_state(run)["proofs"]["collection.input_resolved"]["summary"]
        self.assertEqual(summary["browserBinding"], valid["browser_binding"])

    def test_cdp_diagnosis_uses_bound_channel_and_preserves_site_stops(self):
        run = self.cdp_run()
        before = digest(run/"workflow_state.json")
        for user, host, code in ((False, False, "CDP_REQUIRED"), (True, False, "HOST_CHANNEL_NOT_ALLOWED"),
                                 (False, True, "REVIEW_BROWSER_AUTHORIZATION"), (True, True, "CHECK_AUTHORIZED_CDP")):
            result = c.diagnose(run, devtools_authorized=user, host_allows_devtools=host)
            self.assertEqual(result["code"], code)
            self.assertEqual(result["requiredBrowserChannel"], "cua-cdp")
            self.assertFalse(result["collectionAllowed"])
            self.assertFalse(result["authorizationObserved"]["nativeDevtools"])
        allowed = {"devtools_authorized": True, "host_allows_devtools": True}
        self.assertEqual(c.diagnose(run, ["devtools_failed"], **allowed)["code"], "CDP_CONNECTION_FAILED")
        self.assertEqual(c.diagnose(run, ["devtools_failed", "captcha"], **allowed)["code"], "SITE_GATE_BLOCKED")
        self.assertEqual(digest(run/"workflow_state.json"), before)

    def test_generated_worker_verifies_store_before_business_reads(self):
        harness = r"""
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const input=JSON.parse(fs.readFileSync(0,'utf8'));
(async()=>{
  for(const wrong of [true,false]){
    const requests=[];
    const env={window:{},location:{hostname:'alicrm.alibaba.com',pathname:'/'},document:{cookie:'_tb_token_=SYNTHETIC'},URL,Date,AbortSignal,
      fetch:async(url,options)=>{
        requests.push(url);
        if(url.startsWith('http://127.0.0.1:'))return {ok:true,json:async()=>({verified:true,saved:true})};
        assert.ok(url.startsWith('https://alicrm.alibaba.com/eggCrmQn/crm/customerQueryServiceI/queryCustomerList.json'));
        return {ok:true,status:200,redirected:false,json:async()=>input.wrapper.json};
      }};
    const collect=vm.runInNewContext(input.code,env);
    if(wrong){await assert.rejects(()=>collect({...input.proof,store_key:'demogamma'}),/store_identity_mismatch/);assert.equal(requests.length,0);}
    else{await collect(input.proof);await env.window.__alibabaLocalCollectionPromise;
      assert.equal(env.window.__alibabaLocalCollection.status,'saved_requires_python_validation');
      assert.ok(requests[0].endsWith('/verify-store'));assert.ok(requests.at(-1).endsWith('/results'));}
  }
})().catch(e=>{console.error(e);process.exitCode=1});
"""
        for run in (self.run, self.cdp_run()):
            bridge = Bridge(run, w.load_state(run), "list")
            with self.subTest(channel=bridge.browser_binding["channel"]):
                result = subprocess.run([shutil.which("node"), "-e", harness], input=json.dumps({"code": bridge.code(17889), "proof": self.proof(bridge), "wrapper": wrapper(0)}),
                                        capture_output=True, text=True, encoding="utf-8", timeout=20)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_diagnosis_is_read_only_and_site_gates_take_priority(self):
        before = digest(self.run/"workflow_state.json")
        self.assertEqual(c.diagnose(self.run, ["devtools_failed"])["code"], "DEVTOOLS_CONNECTION_FAILED")
        self.assertEqual(c.diagnose(self.run, ["devtools_failed", "captcha"])["code"], "SITE_GATE_BLOCKED")
        self.assertEqual(c.diagnose(self.run, ["cim_query_failed"])["code"], "PROCESS_QUERY_FAILED")
        self.assertEqual(before, digest(self.run/"workflow_state.json"))
        self.assertFalse(c.diagnose(self.run, ["unknown_failure"])["automaticRetry"])

    def test_beijing_calendar_and_mapping_input(self):
        self.assertEqual(c.configuration("2025-12-31")["endDate"], "2026-01-01")
        self.assertEqual(c.configuration("2024-02-29")["endDate"], "2024-03-01")
        with self.assertRaises(ValueError):
            c.configuration("2026-02-30")
        with self.assertRaises(Invalid):
            c.configuration("20261004")
        mapping = self.base/"synthetic-map.json"
        atomic(mapping, {"verifiedAt": now(), "includesUnassigned": False, "segments": [{"salesId": "synthetic"}]})
        with self.assertRaises(Invalid):
            c.configuration("2026-10-04", sales_map=mapping)

    def test_real_loopback_process_identity_and_clean_shutdown(self):
        import socket
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        # Windows venv executables can be redirectors with a separate child PID.
        process = subprocess.Popen([getattr(sys, "_base_executable", sys.executable), "-X", "utf8", str(ROOT/"scripts"/"workflow.py"),
                                    "receiver", "--run", str(self.run), "--kind", "list", "--port", str(port)],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0)
        try:
            marker = c.folder(self.run)/"receiver-list.private.json"
            deadline = time.monotonic()+8
            while not marker.exists() and process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue(marker.exists())
            function_path = c.folder(self.run)/"inject-list.devtools.js"
            self.assertTrue(function_path.exists())
            # Execute the generated function against a fake fetch, without any browser/network.
            js = "const fs=require('fs'),vm=require('vm'); const f=vm.runInNewContext('('+fs.readFileSync(process.argv[1],'utf8')+')',{fetch:async(u,o)=>{if(!o.headers.Authorization.startsWith('Bearer '))throw Error('auth missing');return {ok:true,text:async()=>'(async()=>({started:true}))'}}}); f().then(r=>{if(!r.started)process.exit(2)}).catch(()=>process.exit(3));"
            checked = subprocess.run([shutil.which("node"), "-e", js, str(function_path)], capture_output=True, timeout=10)
            self.assertEqual(checked.returncode, 0, checked.stderr)
            self.assertEqual(control(self.run, "list")["pid"], process.pid)
            self.assertTrue(control(self.run, "list", stop=True)["stopped"])
            _, errors = process.communicate(timeout=8)
            self.assertEqual(process.returncode, 0, errors.decode())
            self.assertFalse(marker.exists())
            self.assertFalse((c.folder(self.run)/"inject-list.js").exists())
            self.assertFalse(function_path.exists())
            self.assertFalse((c.folder(self.run)/"identity-list.devtools.js").exists())
        finally:
            if process.poll() is None:
                try:
                    control(self.run, "list", stop=True)
                    process.communicate(timeout=5)
                finally:
                    if process.poll() is None:
                        process.terminate()  # Exact base-interpreter handle owned by this test.
                        process.communicate(timeout=5)


if __name__ == "__main__":
    unittest.main()

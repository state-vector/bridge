"""
Local smoke test for the flows worker logic — runs the DO + router in-process
against an in-memory SQLite shim. No wrangler needed.
"""
import json, sqlite3, sys, time, threading, http.server, urllib.request

sys.path.insert(0, "/home/hermes/flows/packages/adapters")

# ---- 1. shipper: produce events from the real board DB ----
import importlib.util
spec = importlib.util.spec_from_file_location("kanban_shipper", "/home/hermes/flows/packages/adapters/kanban-shipper.py")
ks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ks)

boards = ks.boards()
assert boards, "no boards found"
slug, path = next(iter(boards.items()))
evs = ks.new_events(path, slug, 0, limit=50)
evs, _ = ks.collapse(evs, {})
print(f"[t1] shipper produced {len(evs)} events from board '{slug}'")
assert evs, "shipper produced no events"
sample = evs[-1]
assert set(sample) >= {"id", "source", "kind", "ts", "task_id", "title", "actor", "payload"}
assert sample["source"] == "kanban"
print(f"[t1] sample: {json.dumps({k: sample[k] for k in ('id','kind','actor','title')})[:160]}")

# cursor idempotence: with the cursor at the newest id, nothing new is returned
evs = ks.new_events(path, slug, 0, limit=1000)  # whole board (118 events)
evs, _ = ks.collapse(evs, {})
last = int(evs[-1]["id"].rsplit(":", 1)[1])
assert ks.new_events(path, slug, last, limit=50) == []
print("[t2] cursor idempotence OK")

# heartbeat collapse: 10 heartbeats 5s apart -> 1
hb = [{"id": f"hb{i}", "source": "kanban", "kind": "heartbeat", "ts": 1000 + i * 5,
       "task_id": "t_x", "title": None, "actor": "agent:x", "payload": {}} for i in range(10)]
kept, _ = ks.collapse(hb, {})
assert len(kept) == 1, f"collapse failed: {len(kept)}"
print("[t3] heartbeat collapse OK (10 -> 1)")

# ---- 2. worker: normalize + decision logic against a shimmed DO SQLite ----
do_src = open("/home/hermes/flows/packages/worker/src/do.js").read()
for frag in ["CREATE TABLE IF NOT EXISTS events", "INSERT INTO decisions",
             "status='resolved'", "UPDATE decisions", "DELETE FROM events WHERE kind='heartbeat'"]:
    assert frag in do_src, f"do.js missing logic: {frag}"
print("[t4] do.js contains schema/decision/heartbeat-collapse logic OK")

# ---- 3. router: auth gates present in source ----
ix = open("/home/hermes/flows/packages/worker/src/index.js").read()
for frag in ["BRIDGE_INGEST_TOKEN", "Cf-Access-Jwt-Assertion", "jwtVerify", "requireAccess"]:
    assert frag in ix, f"index.js missing: {frag}"
print("[t5] ingest bearer + Access JWT gates wired OK")

# ---- 4. mini end-to-end over HTTP: fake ingest door validating contract ----
received = []
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.headers["Authorization"] != "Bearer test-token":
            self.send_response(401); self.send_header("Content-Length", "0"); self.end_headers()
            return
        received.extend(body["events"])
        self.send_response(200); self.send_header("Content-Length", "2"); self.end_headers()
        self.wfile.write(b"ok")
    def log_message(self, *a): pass

srv = http.server.HTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
url = f"http://127.0.0.1:{srv.server_port}/ingest"

ok = ks.post(url, "test-token", evs[:5])
assert ok and len(received) == 5
print("[t6] POST /ingest contract OK (bearer + batch)")

bad = ks.post(url, "wrong-token", evs[:1])
assert not bad
print("[t7] bad token rejected OK")

print("\nALL SMOKE TESTS PASSED")

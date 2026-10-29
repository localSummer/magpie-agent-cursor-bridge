import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordLatency } from "../lib/diagnostics.js";

test("latency diagnostics retain only bounded metadata and ignore private payloads", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-diagnostics-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "latency.jsonl");
  const event = {
    event: "latency",
    call_id: "9b31ab27-1234:0",
    attempt: 1,
    phase: "retry",
    reason: "gateway_unavailable",
    elapsed_ms: 1000,
    remaining_ms: 119000,
    message: "SECRET",
    key: "SECRET",
    text: "SECRET",
  };
  recordLatency(file, event);
  const text = fs.readFileSync(file, "utf8"),
    row = JSON.parse(text);
  assert.equal(row.phase, "retry");
  assert.equal(row.elapsed_ms, 1000);
  assert.equal(row.call_id, event.call_id);
  assert.doesNotMatch(text, /SECRET|message|key|text/);
  recordLatency(file, {
    ...event,
    call_id: "https://private.example?key=SECRET",
  });
  recordLatency(file, { ...event, phase: "private prompt" });
  assert.equal(fs.readFileSync(file, "utf8"), text);
  fs.writeFileSync(file, "x".repeat(1024 * 1024));
  recordLatency(file, event);
  assert.ok(fs.statSync(file).size < 2048);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).attempt, 1);
  if (process.platform !== "win32")
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("diagnostics failures never break the request path", () => {
  assert.doesNotThrow(() =>
    recordLatency("/dev/null/no-file", {
      event: "latency",
      phase: "completed",
      attempt: 0,
      call_id: "test-1",
    }),
  );
});

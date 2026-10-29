import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
async function until(check) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("supervisor state timeout");
}

test("periodic catalogue failure preserves the engine but rejected credentials stop it", async (t) => {
  if (process.platform === "win32") {
    t.skip("fake executable requires Unix");
    return;
  }
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const relayPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-refresh-"));
  let child,
    mode = "ok",
    requests = 0,
    held = null;
  const server = http.createServer((req, res) => {
    requests++;
    if (mode === "hold") {
      held = res;
      return;
    }
    res.writeHead(mode === "ok" ? 200 : mode === "temporary" ? 503 : 401, {
      "Content-Type": "application/json",
    });
    res.end(
      JSON.stringify(
        mode === "ok"
          ? { data: [{ id: "p/model", reasoning_levels: ["low"] }] }
          : { error: "not logged" },
      ),
    );
  });
  t.after(async () => {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const staged = path.join(root, "package");
  fs.mkdirSync(path.join(staged, "bin"), { recursive: true });
  fs.copyFileSync(
    path.join(packageRoot, "bridge.js"),
    path.join(staged, "bridge.js"),
  );
  fs.copyFileSync(
    path.join(packageRoot, "package.json"),
    path.join(staged, "package.json"),
  );
  for (const name of ["lib", "node_modules"])
    fs.symlinkSync(
      path.join(packageRoot, name),
      path.join(staged, name),
      "dir",
    );
  const engine = path.join(
    staged,
    "bin",
    process.platform === "win32"
      ? "cursor-magpie-bridge.exe"
      : "cursor-magpie-bridge",
  );
  fs.writeFileSync(
    engine,
    `#!${process.execPath}\nconsole.log(JSON.stringify({event:'ready',proxy:'http://127.0.0.1:1',backend:'http://127.0.0.1:2'}));console.log(JSON.stringify({event:'latency',phase:'retry',attempt:1,call_id:'test-call:0',elapsed_ms:100,message:'SECRET'}));process.stdin.resume();setInterval(()=>{},1000);\n`,
    { mode: 0o700 },
  );
  const settings = path.join(root, "settings.json"),
    original = '{"editor.fontSize":17}\n';
  fs.writeFileSync(settings, original);
  const config = {
    enabled: true,
    gateway: `http://127.0.0.1:${server.address().port}/v1`,
    key: "test-only",
    model: "p/model",
    models: [{ id: "p/model" }],
  };
  fs.writeFileSync(path.join(root, "connection.json"), JSON.stringify(config));
  child = spawn(
    process.execPath,
    [path.join(staged, "bridge.js"), "supervise"],
    {
      env: {
        ...process.env,
        CURSOR_BRIDGE_ROOT: root,
        CURSOR_BRIDGE_SETTINGS: settings,
        CURSOR_BRIDGE_NO_WATCHDOG: "1",
        CURSOR_BRIDGE_RELAY_PORT: String(relayPort),
      },
      stdio: "ignore",
    },
  );
  const state = () => {
    try {
      return JSON.parse(
        fs.readFileSync(path.join(root, "status.json"), "utf8"),
      );
    } catch {
      return {};
    }
  };
  const first = await until(() => state().state === "connected" && state());
  assert.ok(first.catalogueUpdated);
  assert.ok(first.catalogueAccepted);
  await until(() => fs.existsSync(path.join(root, "latency.jsonl")));
  const diagnostic = fs.readFileSync(path.join(root, "latency.jsonl"), "utf8");
  assert.equal(JSON.parse(diagnostic).phase, "retry");
  assert.doesNotMatch(diagnostic, /SECRET/);
  const effective = fs.readFileSync(path.join(root, "effective.json"), "utf8");
  mode = "temporary";
  await until(() => state().catalogueStale);
  assert.equal(state().state, "connected");
  assert.equal(state().pid, first.pid);
  assert.equal(state().proxy, first.proxy);
  assert.equal(
    fs.readFileSync(path.join(root, "effective.json"), "utf8"),
    effective,
  );
  const failedRequests = requests;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(
    requests,
    failedRequests,
    "refresh failure must not retry every supervisor tick",
  );
  mode = "ok";
  await until(() => state().state === "connected" && !state().catalogueStale);
  assert.equal(state().pid, first.pid);
  mode = "auth";
  await until(() => state().state === "error");
  assert.equal(fs.readFileSync(settings, "utf8"), original);
  mode = "ok";
  await until(() => state().state === "connected");
  fs.writeFileSync(
    path.join(root, "connection.json"),
    JSON.stringify({ ...config, gateway: config.gateway + "/missing" }),
  );
  mode = "auth";
  await until(() => state().state === "error");
  assert.equal(fs.readFileSync(settings, "utf8"), original);
  mode = "ok";
  fs.writeFileSync(path.join(root, "connection.json"), JSON.stringify(config));
  await until(() => state().state === "connected");
  mode = "hold";
  await until(() => held);
  fs.writeFileSync(path.join(root, "connection.json"), JSON.stringify({}));
  held.writeHead(200, { "Content-Type": "application/json" });
  held.end(
    JSON.stringify({ data: [{ id: "p/model", reasoning_levels: ["high"] }] }),
  );
  await until(() => state().state === "disconnected");
  assert.equal(fs.readFileSync(settings, "utf8"), original);
  assert.equal(
    fs.readFileSync(path.join(root, "effective.json"), "utf8"),
    effective,
    "discard the obsolete response after disconnect",
  );
});

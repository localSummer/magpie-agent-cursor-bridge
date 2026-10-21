// Explicit synthetic-only native smoke test. Reuses an already trusted local
// CA in a private temporary directory; never changes system trust or settings.
// Usage: node test/manual-commit.mjs [engine-path]
// Live (current bridge): node test/manual-commit.mjs --live
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn, spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';

const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = process.env.CURSOR_BRIDGE_ROOT || path.join(os.homedir(), '.config/magpie-cursor-bridge');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const syntheticDiff = 'diff --git a/synthetic-test.txt b/synthetic-test.txt\n--- a/synthetic-test.txt\n+++ b/synthetic-test.txt\n@@ -1 +1 @@\n-old value\n+new value\n';
function field(value) {
  const bytes = Buffer.from(value);
  let n = bytes.length;
  const length = [];
  do { const b = n & 127; n >>>= 7; length.push(b | (n ? 128 : 0)); } while (n);
  return Buffer.concat([Buffer.from([10, ...length]), bytes]);
}
function decode(bytes) {
  assert.equal(bytes[0], 10, 'expected commit_message protobuf field');
  let length = 0, shift = 0, i = 1;
  for (; i < bytes.length; i++) {
    length |= (bytes[i] & 127) << shift;
    if (!(bytes[i] & 128)) { i++; break; }
    shift += 7;
  }
  assert.ok(length > 0 && i + length <= bytes.length, 'expected nonempty complete commit message');
  return bytes.subarray(i, i + length).toString('utf8');
}
async function generate(backend, expectedStatus = 200) {
  const response = await fetch(`${backend}/aiserver.v1.AiService/WriteGitCommitMessage`, {
    method: 'POST', headers: {'Content-Type': 'application/proto', 'connect-timeout-ms': '120000'},
    body: field(syntheticDiff), signal: AbortSignal.timeout(125000)
  });
  const body = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, expectedStatus, `unexpected status ${response.status}: ${body.toString('utf8').slice(0, 200)}`);
  return expectedStatus === 200 ? decode(body) : null;
}
if (process.argv[2] === '--live') {
  const status = JSON.parse(fs.readFileSync(path.join(root, 'status.json'), 'utf8'));
  assert.equal(status.state, 'connected');
  const result = spawnSync('/usr/bin/curl', [
    '--silent', '--show-error', '--fail', '--max-time', '125',
    '--proxy', status.proxy, '--noproxy', '',
    '--cacert', path.join(root, 'data/ca/ca.crt'),
    '--request', 'POST', '--header', 'Content-Type: application/proto',
    '--header', 'connect-timeout-ms: 120000', '--data-binary', '@-',
    'https://api2.cursor.sh/aiserver.v1.AiService/WriteGitCommitMessage'
  ], {input: field(syntheticDiff), maxBuffer: 1024 * 1024});
  assert.equal(result.status, 0, `proxied synthetic request failed: ${result.stderr.toString('utf8')}`);
  console.log(JSON.stringify({version: status.version, model: status.model, proxy: status.proxy, commit_message: decode(result.stdout)}, null, 2));
} else {
  const engine = process.argv[2] || path.join(packageDir, 'bin/cursor-magpie-bridge');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-commit-smoke-'));
  fs.chmodSync(scratch, 0o700);
  let child, server;
  const seen = [];
  let fail = false;
  try {
    const ca = path.join(scratch, 'data/ca');
    fs.mkdirSync(ca, {recursive: true, mode: 0o700});
    for (const name of ['ca.crt', 'ca.key']) {
      fs.copyFileSync(path.join(root, 'data/ca', name), path.join(ca, name));
      fs.chmodSync(path.join(ca, name), 0o600);
    }
    server = http.createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      seen.push({path: request.url, authorization: request.headers.authorization, body: JSON.parse(body)});
      if (fail) { response.writeHead(503, {'Content-Type': 'application/json'}); response.end('{"error":{"message":"synthetic gateway unavailable"}}'); return; }
      response.writeHead(200, {'Content-Type': 'text/event-stream'});
      const text = `fix: synthetic ${seen.at(-1).body.model}`;
      response.end(`data: ${JSON.stringify({type: 'response.output_text.delta', delta: text})}\n\ndata: ${JSON.stringify({type: 'response.completed', response: {usage: {input_tokens: 1, output_tokens: 1}}})}\n\n`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const gateway = `http://127.0.0.1:${server.address().port}/v1`;
    const configPath = path.join(scratch, 'effective.json');
    const config = {gateway, key: 'synthetic-only-key', model: 'test/a', models: [{id: 'test/a', name: 'A'}, {id: 'test/b', name: 'B'}]};
    const publish = () => { fs.writeFileSync(configPath + '.tmp', JSON.stringify(config), {mode: 0o600}); fs.renameSync(configPath + '.tmp', configPath); };
    publish();
    child = spawn(engine, [configPath], {env: {...process.env, CURSOR_BYOK_DATA_DIR: path.join(scratch, 'data')}, stdio: ['pipe', 'pipe', 'pipe']});
    child.stderr.resume();
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('native startup timed out')), 30000);
      const lines = createInterface({input: child.stdout});
      lines.on('line', line => { try { const item = JSON.parse(line); if (item.event === 'ready') { clearTimeout(timer); resolve(item); } } catch {} });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('exit', code => { clearTimeout(timer); reject(new Error(`native exit ${code}`)); });
    });
    assert.equal(await generate(ready.backend), 'fix: synthetic test/a');
    config.model = 'test/b'; publish(); await wait(2500);
    assert.equal(await generate(ready.backend), 'fix: synthetic test/b');
    config.key = 'rotated-synthetic-key'; config.models[1].name = 'Renamed B'; publish(); await wait(2500);
    assert.equal(await generate(ready.backend), 'fix: synthetic test/b');
    assert.equal(seen.at(-1).authorization, 'Bearer rotated-synthetic-key');
    fail = true;
    await generate(ready.backend, 502);
    assert.equal(seen.length, 4);
    assert.ok(seen.every(item => item.path === '/v1/responses'));
    assert.ok(seen.every(item => JSON.stringify(item.body).includes('synthetic-test.txt')));
    console.log('PASS: native Responses mapping, selected-model switch, key/name refresh, protobuf response, gateway error. Only synthetic diffs sent.');
  } finally {
    if (child && child.exitCode === null) {
      child.stdin.end();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), wait(12000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    server?.closeAllConnections();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    fs.rmSync(scratch, {recursive: true, force: true});
  }
}

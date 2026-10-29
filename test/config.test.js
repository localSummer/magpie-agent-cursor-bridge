import test from 'node:test';
import assert from 'node:assert/strict';
import {validate,gatewayModels,isTransientGatewayError} from '../lib/config.js';
import {connect,agent} from '../agent.js';
const c={enabled:true,gateway:'http://127.0.0.1:3425/v1',key:'test-only',model:'provider/model',models:[{id:'provider/model'}]};
test('plugin is a Magpie agent and maps supplied credentials and models',()=>{assert.equal(agent.id,'cursor-bridge');const out=connect({gateway:{v1:c.gateway,key:c.key},models:c.models});assert.equal(out.key,c.key);assert.deepEqual(validate({...out,model:c.model}).models,[{id:c.model,name:c.model,context:null}]);});
test('disconnected configuration is inactive',()=>{assert.equal(validate({}),null);assert.equal(validate({...c,enabled:false}),null);});
test('refuses remote gateway and credential-bearing URL',()=>{for(const gateway of ['https://evil.example/v1','http://127.0.0.1.evil.example','http://key@127.0.0.1','file:///tmp/test'])assert.throws(()=>validate({...c,gateway}));});
test('selected model must exist and IDs must be unique',()=>{assert.throws(()=>validate({...c,model:'missing'}));assert.throws(()=>validate({...c,models:[...c.models,...c.models]}));});

const response = (data, status = 200) =>
  new Response(JSON.stringify({ data }), { status });

test("gateway keeps reasoning capabilities on their exact route", async () => {
  const out = await gatewayModels(c, {
    fetchImpl: async () =>
      response([
        {
          id: c.model,
          reasoning_levels: ["low", "high"],
          supported_reasoning_levels: [{ effort: "high" }, { effort: "low" }],
        },
        { id: "other/model", reasoning_levels: ["high"] },
      ]),
  });
  assert.deepEqual(out.models[0].reasoningLevels, ["low", "high"]);
  assert.deepEqual(out.models[1].reasoningLevels, ["high"]);
});

test("unknown, malformed or contradictory capabilities never enable low", async () => {
  for (const capabilities of [
    {},
    { reasoning_levels: [] },
    { reasoning_levels: ["low", 1] },
    { supported_reasoning_levels: [{ level: "low" }] },
    {
      reasoning_levels: ["low", "high"],
      supported_reasoning_levels: [{ effort: "high" }, { effort: "high" }],
    },
    { reasoning_levels: ["low", "low"] },
    {
      reasoning_levels: ["low"],
      supported_reasoning_levels: [{ effort: "high" }],
    },
  ]) {
    const out = await gatewayModels(c, {
      fetchImpl: async () => response([{ id: c.model, ...capabilities }]),
    });
    assert.equal(out.models[0].reasoningLevels, null);
  }
  const out = await gatewayModels(c, {
    fetchImpl: async () =>
      response([
        { id: c.model, supported_reasoning_levels: [{ effort: "low" }] },
      ]),
  });
  assert.deepEqual(out.models[0].reasoningLevels, ["low"]);
});

test("gateway distinguishes transient failures from rejected credentials and invalid catalogues", async () => {
  for (const status of [401, 403, 404, 429, 500, 502, 503, 504]) {
    await assert.rejects(
      gatewayModels(c, { fetchImpl: async () => response([], status) }),
      (error) => {
        assert.equal(isTransientGatewayError(error), status >= 500);
        assert.equal(error.message, `Magpie gateway HTTP ${status}`);
        return true;
      },
    );
  }
  for (const error of [
    new TypeError("private URL"),
    new DOMException("timeout", "TimeoutError"),
  ]) {
    await assert.rejects(
      gatewayModels(c, {
        fetchImpl: async () => {
          throw error;
        },
      }),
      (e) => {
        assert.equal(isTransientGatewayError(e), true);
        assert.doesNotMatch(e.message, /private URL/);
        return true;
      },
    );
  }
  await assert.rejects(
    gatewayModels(c, {
      fetchImpl: async () => ({
        ok: true,
        json: async () => {
          throw new TypeError("body socket closed");
        },
      }),
    }),
    (e) => isTransientGatewayError(e) && !e.message.includes("socket"),
  );
  await assert.rejects(
    gatewayModels(c, { fetchImpl: async () => response([{ id: "missing" }]) }),
    (e) => !isTransientGatewayError(e),
  );
  const aborted = new AbortController();
  await assert.rejects(
    gatewayModels(c, {
      signal: aborted.signal,
      fetchImpl: async () => ({
        ok: true,
        json: async () => {
          aborted.abort();
          throw new DOMException("body aborted", "AbortError");
        },
      }),
    }),
    (e) => e.code === "gateway_timeout",
  );
  await assert.rejects(
    gatewayModels(c, { fetchImpl: async () => new Response("broken JSON") }),
    (e) => !isTransientGatewayError(e),
  );
});

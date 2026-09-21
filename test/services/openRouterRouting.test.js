// No network or real keys. Run with upstream's node --import tsx --test runner.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const r = require(
  process.env.OPENROUTER_ROUTING_TEST_MODULE ||
    path.resolve(__dirname, "../../src/services/ai/openRouterRouting.ts")
);

function store() {
  const values = new Map();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}
const prefs = (patch = {}) => ({ ...r.defaultRouting(), ...patch });
const model = "test-vendor/test-model";
const url = "https://openrouter.ai/api/v1/chat/completions";
function capture() {
  const calls = [];
  return {
    calls,
    fetch: async (input, init) => {
      calls.push({ input, init });
      return new Response('{"choices":[{"message":{"content":"Clean text."}}]}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
}

test("default routing changes nothing", () => {
  const body = { model, messages: [] };
  r.applyOpenRouterRouting(body, "openrouter", url, store());
  assert.deepEqual(body, { model, messages: [] });
  assert.equal(r.providerPreference(prefs()), undefined);
});

test("latency, throughput and price routing use the supported API values", () => {
  for (const sort of ["latency", "throughput", "price"]) {
    assert.deepEqual(r.providerPreference(prefs({ sort })), { sort });
  }
});

test("strict provider selection cannot silently fall back", () => {
  assert.deepEqual(r.providerPreference(prefs({ sort: "latency", upstream: "groq" })), {
    sort: "latency",
    only: ["groq"],
    allow_fallbacks: false,
  });
});

test("fallback selection prefers the chosen provider", () => {
  assert.deepEqual(
    r.providerPreference(prefs({ upstream: "some-provider/turbo", allowFallbacks: true })),
    {
      order: ["some-provider/turbo"],
      allow_fallbacks: true,
    }
  );
});

test("rate ceilings use dollars per million; zero is not treated as absent", () => {
  assert.deepEqual(r.providerPreference(prefs({ maxInputPrice: 0, maxOutputPrice: 1.8 })), {
    max_price: { prompt: 0, completion: 1.8 },
  });
});

test("malformed preferences fail closed instead of dropping a provider restriction", () => {
  for (const invalid of [
    null,
    [],
    { sort: "fast" },
    { sort: ["latency"] },
    { upstream: 42 },
    { upstream: "bad slug" },
    { allowFallbacks: "true" },
    { maxInputPrice: -1 },
    { maxOutputPrice: Infinity },
    { maxInputPrice: "NaN" },
  ]) {
    assert.throws(() => r.validateRouting(invalid));
  }
});

test("per-model storage changes no existing keys or dictionary settings", () => {
  const s = store();
  s.setItem("openrouterApiKey", "mock-existing-key-not-a-real-secret");
  s.setItem("customDictionary", '["OpenWhispr"]');
  r.writeRouting(model, prefs({ upstream: "groq" }), s);
  r.writeRouting("other/model", prefs({ sort: "price" }), s);
  assert.equal(r.readRouting(model, s).upstream, "groq");
  assert.equal(r.readRouting("other/model", s).sort, "price");
  r.resetRouting(model, s);
  assert.deepEqual(r.readRouting(model, s), prefs());
  assert.equal(r.readRouting("other/model", s).sort, "price");
  r.resetAllRouting(s);
  assert.equal(s.getItem("openrouterApiKey"), "mock-existing-key-not-a-real-secret");
  assert.equal(s.getItem("customDictionary"), '["OpenWhispr"]');
  assert.equal(s.values.size, 2);
});

test("invalid saved document prevents inference before a request is sent", async () => {
  const s = store();
  s.setItem(r.ROUTING_STORAGE_KEY, "not json");
  const c = capture();
  const wrapped = r.createOpenRouterRoutingFetch(c.fetch, false, s);
  await assert.rejects(
    wrapped(url, { method: "POST", body: JSON.stringify({ model }) }),
    /unreadable/
  );
  assert.equal(c.calls.length, 0);
  r.resetAllRouting(s);
  assert.deepEqual(r.readRouting(model, s), prefs());
});

test("unsupported document versions and malformed pinned providers are rejected", () => {
  const s = store();
  for (const doc of [
    { version: 2, routes: {} },
    { version: 1, routes: [] },
    { version: 1, routes: { [model]: { upstream: 123 } } },
  ]) {
    s.setItem(r.ROUTING_STORAGE_KEY, JSON.stringify(doc));
    assert.throws(() => r.readRouting(model, s));
  }
});

test("stored settings contain only routing preferences", () => {
  const s = store();
  r.writeRouting(
    model,
    { ...prefs({ upstream: "groq" }), apiKey: "never-store-this", transcript: "private" },
    s
  );
  const serialized = s.getItem(r.ROUTING_STORAGE_KEY);
  assert.equal(serialized.includes("never-store-this"), false);
  assert.equal(serialized.includes("private"), false);
  assert.throws(() => r.writeRouting("", prefs(), s));
});

test("endpoint authentication host checks reject lookalike hosts and non-HTTPS", () => {
  assert.equal(r.isOpenRouterEndpoint(url), true);
  assert.equal(r.isOpenRouterEndpoint("https://openrouter.ai:443/api/v1"), true);
  for (const endpoint of [
    "http://openrouter.ai/api/v1",
    "https://openrouter.ai.evil.test/api/v1",
    "https://evil.test/openrouter.ai/api/v1",
    "https://openrouter.ai:8443/api/v1",
    "https://user:pass@openrouter.ai/api/v1",
    "https://openrouter.ai/api/v123",
    "not-url",
  ]) {
    assert.equal(r.isOpenRouterEndpoint(endpoint), false);
  }
});

test("routing is not sent to native providers or non-OpenRouter custom endpoints", () => {
  const s = store();
  r.writeRouting(model, prefs({ upstream: "groq" }), s);
  for (const [provider, endpoint] of [
    ["groq", "https://api.groq.com/openai/v1/chat/completions"],
    ["custom", "https://api.x.ai/v1/chat/completions"],
    ["openrouter", "https://unrelated.test/v1"],
  ]) {
    const body = { model };
    r.applyOpenRouterRouting(body, provider, endpoint, s);
    assert.deepEqual(body, { model });
  }
  const custom = { model };
  r.applyOpenRouterRouting(custom, "custom", url, s);
  assert.deepEqual(custom.provider, { only: ["groq"], allow_fallbacks: false });
});

test("catalog URL encodes model names and strips only routing-only variants", () => {
  assert.equal(
    r.endpointCatalogUrl(model + ":nitro"),
    `https://openrouter.ai/api/v1/models/${model}/endpoints`
  );
  assert.equal(
    r.endpointCatalogUrl(model + ":floor"),
    `https://openrouter.ai/api/v1/models/${model}/endpoints`
  );
  assert.equal(
    r.endpointCatalogUrl(model + ":free"),
    `https://openrouter.ai/api/v1/models/${model}%3Afree/endpoints`
  );
  for (const id of ["", "plain", "../foo", "a/..", "x/y/z"])
    assert.throws(() => r.endpointCatalogUrl(id));
});

test("catalog uses canonical routing tags, correct price units, and median metrics", () => {
  const result = r.parseEndpoints({
    data: {
      endpoints: [
        {
          tag: "slow",
          provider_name: "Slow",
          pricing: { prompt: "0.000001", completion: "0.000002" },
          latency_last_30m: { p50: 1.5 },
          throughput_last_30m: { p50: 50 },
          status: 0,
        },
        {
          tag: "groq",
          provider_name: "Groq",
          pricing: { prompt: "0.0000006", completion: "0.0000018" },
          latency_last_30m: { p50: 0.15 },
          throughput_last_30m: { p50: 300 },
        },
        { tag: "groq", provider_name: "Duplicate" },
        { provider_name: "Missing routing tag" },
        { tag: "unknown" },
      ],
    },
  });
  assert.equal(result.length, 3);
  assert.equal(result[0].tag, "groq");
  assert.equal(result[0].name, "Groq");
  assert.equal(result[0].inputPerMillion, 0.6);
  assert.ok(Math.abs(result[0].outputPerMillion - 1.8) < 1e-10);
  assert.equal(result[0].latencySeconds, 0.15);
  assert.equal(result[0].tokensPerSecond, 300);
  assert.equal(result[2].latencySeconds, null);
  assert.equal(result[2].inputPerMillion, null);
});

test("bad catalog response does not masquerade as a successful empty catalog", () => {
  assert.throws(() => r.parseEndpoints({ error: "Access denied" }), /invalid/);
  assert.deepEqual(r.parseEndpoints({ data: { endpoints: [] } }), []);
});

test("existing privacy restrictions and stricter price ceilings survive merging", () => {
  const old = {
    only: ["groq", "other"],
    zdr: true,
    require_parameters: true,
    data_collection: "deny",
    ignore: ["blocked"],
    max_price: { prompt: 0.5, completion: 3 },
  };
  const merged = r.mergeProviderPreferences(old, {
    only: ["groq"],
    allow_fallbacks: false,
    max_price: { prompt: 1, completion: 2 },
    sort: "latency",
  });
  assert.equal(merged.zdr, true);
  assert.equal(merged.data_collection, "deny");
  assert.equal(merged.require_parameters, true);
  assert.deepEqual(merged.ignore, ["blocked"]);
  assert.deepEqual(merged.only, ["groq"]);
  assert.deepEqual(merged.max_price, { prompt: 0.5, completion: 2 });
  assert.deepEqual(old.only, ["groq", "other"]);
});

test("provider allowlist intersection retains the more-specific endpoint", () => {
  assert.deepEqual(
    r.mergeProviderPreferences({ only: ["provider/turbo"] }, { only: ["provider"] }).only,
    ["provider/turbo"]
  );
  assert.deepEqual(
    r.mergeProviderPreferences({ only: ["provider"] }, { only: ["provider/turbo"] }).only,
    ["provider/turbo"]
  );
  assert.throws(() => r.mergeProviderPreferences({ only: ["a"] }, { only: ["b"] }), /conflicts/);
  assert.throws(
    () => r.mergeProviderPreferences({ only: ["a"] }, { order: ["b"], allow_fallbacks: true }),
    /excluded/
  );
  assert.throws(() => r.mergeProviderPreferences({ only: [1] }, { sort: "latency" }), /Invalid/);
});

test("an existing no-fallback rule cannot be weakened", () => {
  const result = r.mergeProviderPreferences(
    { allow_fallbacks: false },
    { order: ["groq"], allow_fallbacks: true }
  );
  assert.equal(result.allow_fallbacks, false);
});

test("AI SDK transport injects routing, preserves auth/signal, and suppresses reasoning when requested", async () => {
  const s = store();
  r.writeRouting(model, prefs({ upstream: "groq", sort: "latency" }), s);
  const c = capture();
  const headers = { Authorization: "Bearer test-only" };
  const signal = new AbortController().signal;
  const wrapped = r.createOpenRouterRoutingFetch(c.fetch, true, s);
  await wrapped(url, {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hello" }], stream: true }),
  });
  assert.equal(c.calls.length, 1);
  const call = c.calls[0];
  assert.equal(call.input, url);
  assert.equal(call.init.headers, headers);
  assert.equal(call.init.signal, signal);
  const body = JSON.parse(call.init.body);
  assert.equal(body.stream, true);
  assert.deepEqual(body.messages, [{ role: "user", content: "hello" }]);
  assert.deepEqual(body.reasoning, { enabled: false });
  assert.deepEqual(body.provider, { only: ["groq"], sort: "latency", allow_fallbacks: false });
});

test("AI SDK transport supports Request objects without mutating the original body", async () => {
  const s = store();
  r.writeRouting(model, prefs({ sort: "latency" }), s);
  const c = capture();
  const request = new Request(url, {
    method: "POST",
    headers: { "x-test": "preserved" },
    body: JSON.stringify({ model }),
  });
  await r.createOpenRouterRoutingFetch(c.fetch, false, s)(request);
  assert.equal(c.calls[0].input, request);
  assert.deepEqual(JSON.parse(c.calls[0].init.body).provider, { sort: "latency" });
  assert.deepEqual(await request.json(), { model });
});

test("AI SDK transport leaves metadata GETs and unrelated hosts untouched", async () => {
  const s = store();
  s.setItem(r.ROUTING_STORAGE_KEY, "unreadable");
  const c = capture();
  const wrapped = r.createOpenRouterRoutingFetch(c.fetch, true, s);
  const init = { method: "POST", body: JSON.stringify({ model }) };
  await wrapped("https://api.x.ai/v1/chat/completions", init);
  await wrapped("https://openrouter.ai/api/v1/models", { method: "GET" });
  assert.equal(c.calls[0].init, init);
  assert.equal(c.calls[1].init.body, undefined);
});

test("SDK transport retains reasoning settings when toggle is off", async () => {
  const c = capture();
  await r.createOpenRouterRoutingFetch(
    c.fetch,
    false,
    store()
  )(url, { method: "POST", body: JSON.stringify({ model, reasoning: { effort: "low" } }) });
  assert.deepEqual(JSON.parse(c.calls[0].init.body).reasoning, { effort: "low" });
});

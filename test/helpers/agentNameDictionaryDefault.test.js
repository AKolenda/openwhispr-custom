const test = require("node:test");
const assert = require("node:assert/strict");

const load = async () => {
  const loaded = await import("../../src/helpers/agentNameDictionary.js");
  return loaded.agentNameDictionaryChangesWithoutDefault ? loaded : loaded.default;
};

test("removes the built-in OpenWhispr name instead of adding it", async () => {
  const { agentNameDictionaryChangesWithoutDefault } = await load();
  assert.deepEqual(agentNameDictionaryChangesWithoutDefault(["OpenWhispr", "Nova"], "OpenWhispr"), {
    add: [],
    remove: ["OpenWhispr"],
  });
  assert.deepEqual(agentNameDictionaryChangesWithoutDefault(["Nova"], "OpenWhispr"), {
    add: [],
    remove: [],
  });
});

test("keeps custom assistant names in the dictionary", async () => {
  const { agentNameDictionaryChangesWithoutDefault } = await load();
  assert.deepEqual(
    agentNameDictionaryChangesWithoutDefault(["OpenWhispr", "Nova"], "Jarvis", "OpenWhispr"),
    { add: ["Jarvis"], remove: ["OpenWhispr"] }
  );
});

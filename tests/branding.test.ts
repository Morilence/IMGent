import assert from "node:assert/strict";
import { test } from "node:test";
import { parseIMGentCommand } from "../src/runtime/application.js";

test("IMGent command namespace rejects legacy and lookalike prefixes", () => {
  assert.deepEqual(parseIMGentCommand("/imgent cancel"), { name: "cancel" });
  assert.deepEqual(parseIMGentCommand("/imgent"), { name: "help" });
  assert.equal(parseIMGentCommand(`/${["pig", "eon"].join("")} cancel`), undefined);
  assert.equal(parseIMGentCommand("/imgent-other cancel"), undefined);
});

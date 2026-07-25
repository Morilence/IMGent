import assert from "node:assert/strict";
import { test } from "node:test";
import { ensurePrereleaseDistTag, prereleaseTagForVersion } from "./ensure-prerelease-dist-tag.mjs";

function fakeNpm(initialTags = {}, options = {}) {
  const calls = [];
  const tags = { ...initialTags };
  return {
    calls,
    tags,
    run: async (args) => {
      calls.push(args);
      if (args[0] === "dist-tag" && args[1] === "add") {
        if (!options.ignoreAdd) {
          const packageVersion = args[2];
          const separator = packageVersion.lastIndexOf("@");
          tags[args[3]] = packageVersion.slice(separator + 1);
        }
        return { stdout: "" };
      }
      if (args[0] === "dist-tag" && args[1] === "rm") {
        delete tags[args[3]];
        return { stdout: "" };
      }
      if (args[0] === "view") {
        return { stdout: JSON.stringify(tags) };
      }
      throw new Error(`Unexpected npm arguments: ${args.join(" ")}`);
    },
  };
}

test("extracts the prerelease channel from Changesets versions", () => {
  assert.equal(prereleaseTagForVersion("0.2.0-alpha.0"), "alpha");
  assert.equal(prereleaseTagForVersion("1.0.0-beta.3"), "beta");
  assert.equal(prereleaseTagForVersion("0.2.0"), undefined);
});

test("leaves dist-tags unchanged for stable versions", async () => {
  const npm = fakeNpm({ latest: "0.2.0" });
  const result = await ensurePrereleaseDistTag({
    name: "imgent",
    version: "0.2.0",
    runNpm: npm.run,
  });

  assert.deepEqual(result, { tag: undefined, removedLatest: false });
  assert.deepEqual(npm.calls, []);
});

test("keeps alpha current and removes a prerelease latest tag", async () => {
  const npm = fakeNpm({ latest: "0.2.0-alpha.0" });
  const result = await ensurePrereleaseDistTag({
    name: "imgent",
    version: "0.2.0-alpha.0",
    runNpm: npm.run,
  });

  assert.deepEqual(result, { tag: "alpha", removedLatest: true });
  assert.deepEqual(npm.tags, { alpha: "0.2.0-alpha.0" });
});

test("preserves a stable latest tag while advancing alpha", async () => {
  const npm = fakeNpm({ latest: "0.1.0", alpha: "0.2.0-alpha.0" });
  const result = await ensurePrereleaseDistTag({
    name: "imgent",
    version: "0.2.0-alpha.1",
    runNpm: npm.run,
  });

  assert.deepEqual(result, { tag: "alpha", removedLatest: false });
  assert.deepEqual(npm.tags, {
    latest: "0.1.0",
    alpha: "0.2.0-alpha.1",
  });
});

test("fails when npm does not advance the prerelease tag", async () => {
  const npm = fakeNpm({ alpha: "0.2.0-alpha.0" }, { ignoreAdd: true });

  await assert.rejects(
    ensurePrereleaseDistTag({
      name: "imgent",
      version: "0.2.0-alpha.1",
      runNpm: npm.run,
    }),
    /Expected npm dist-tag alpha to point to 0\.2\.0-alpha\.1/,
  );
});

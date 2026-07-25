import assert from "node:assert/strict";
import { test } from "node:test";
import { ensurePrereleaseDistTag, prereleaseTagForVersion } from "./ensure-prerelease-dist-tag.mjs";

function fakeNpm(initialTags = {}, options = {}) {
  const calls = [];
  const tags = { ...initialTags };
  let remainingViewFailures = options.viewFailures ?? 0;
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
      if (args[0] === "view") {
        if (remainingViewFailures > 0) {
          remainingViewFailures -= 1;
          throw new Error("npm registry has not exposed the package yet");
        }
        return { stdout: JSON.stringify(tags) };
      }
      throw new Error(`Unexpected npm arguments: ${args.join(" ")}`);
    },
  };
}

const noWait = async () => {};

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

  assert.deepEqual(result, { tag: undefined, prereleaseLatest: false });
  assert.deepEqual(npm.calls, []);
});

test("keeps alpha current and accepts the required prerelease latest tag", async () => {
  const npm = fakeNpm({ latest: "0.2.0-alpha.0" });
  const result = await ensurePrereleaseDistTag({
    name: "imgent",
    version: "0.2.0-alpha.0",
    runNpm: npm.run,
    wait: noWait,
  });

  assert.deepEqual(result, { tag: "alpha", prereleaseLatest: true });
  assert.deepEqual(npm.tags, {
    latest: "0.2.0-alpha.0",
    alpha: "0.2.0-alpha.0",
  });
});

test("preserves a stable latest tag while advancing alpha", async () => {
  const npm = fakeNpm({ latest: "0.1.0", alpha: "0.2.0-alpha.0" });
  const result = await ensurePrereleaseDistTag({
    name: "imgent",
    version: "0.2.0-alpha.1",
    runNpm: npm.run,
    wait: noWait,
  });

  assert.deepEqual(result, { tag: "alpha", prereleaseLatest: false });
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
      wait: noWait,
    }),
    /Expected npm dist-tag alpha to point to 0\.2\.0-alpha\.1/,
  );
});

test("retries while a newly published package becomes visible", async () => {
  const npm = fakeNpm({}, { viewFailures: 2 });
  const waits = [];
  const result = await ensurePrereleaseDistTag({
    name: "imgent",
    version: "0.2.0-alpha.1",
    runNpm: npm.run,
    wait: async (milliseconds) => waits.push(milliseconds),
  });

  assert.deepEqual(result, { tag: "alpha", prereleaseLatest: false });
  assert.deepEqual(waits, [1000, 2000]);
  assert.equal(npm.tags.alpha, "0.2.0-alpha.1");
});

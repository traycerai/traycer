import { beforeEach, describe, expect, it, vi } from "vitest";

// `applyEnvOverrides` must match keys case-insensitively on win32 (where the
// process env is case-insensitive and the PATH key is spelled `Path`, not
// `PATH`) while staying case-sensitive on POSIX. The platform is the only OS
// input this behavior depends on, so - exactly like `detect-shells.test.ts` -
// we mock `os.platform()` to exercise both branches honestly from one runner.
const world = vi.hoisted(() => ({ platform: "linux" as NodeJS.Platform }));
vi.mock("node:os", async (importActual) => {
  const actual = await importActual<typeof import("node:os")>();
  return { ...actual, platform: () => world.platform };
});

import { applyEnvOverrides } from "../store";

/** All keys in `env` that name the PATH variable in any casing. */
function pathKeys(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter((key) => /^path$/i.test(key));
}

beforeEach(() => {
  world.platform = "linux";
});

describe("applyEnvOverrides - POSIX key matching (case-sensitive, unchanged)", () => {
  it("treats `PATH` and `Path` as distinct keys (no case-folding)", () => {
    // On POSIX a `PATH` override does NOT touch an existing `Path`; both keys
    // coexist. This locks the current behavior against the win32 change below.
    expect(applyEnvOverrides({ Path: "orig" }, { PATH: "new" })).toEqual({
      Path: "orig",
      PATH: "new",
    });
  });

  it("deletes only the exactly-cased key on a null override", () => {
    expect(applyEnvOverrides({ Path: "orig" }, { PATH: null })).toEqual({
      Path: "orig",
    });
    expect(applyEnvOverrides({ Path: "orig" }, { Path: null })).toEqual({});
  });

  it("still layers unrelated overrides and null-deletes (existing contract)", () => {
    expect(
      applyEnvOverrides(
        { OPENAI_API_KEY: "inherited", ANTHROPIC_API_KEY: "kept" },
        { OPENAI_API_KEY: null, GEMINI_API_KEY: "set" },
      ),
    ).toEqual({ ANTHROPIC_API_KEY: "kept", GEMINI_API_KEY: "set" });
  });
});

describe("applyEnvOverrides - win32 key matching (case-insensitive)", () => {
  beforeEach(() => {
    world.platform = "win32";
  });

  it("replaces an existing `Path` value in place when overriding `PATH`", () => {
    // The real key on Windows is `Path`; a Settings->Shell override keyed
    // `PATH` must update THAT value, not add a second colliding key. The
    // original key's casing is preserved (replace in place).
    const result = applyEnvOverrides({ Path: "orig" }, { PATH: "new" });
    expect(pathKeys(result)).toEqual(["Path"]);
    expect(result).toEqual({ Path: "new" });
  });

  it("matches regardless of the override's casing", () => {
    const result = applyEnvOverrides(
      { Path: "orig", TEMP: "t" },
      { path: "new" },
    );
    expect(result).toEqual({ Path: "new", TEMP: "t" });
  });

  it("deletes the case-insensitively matching key on a null override", () => {
    expect(applyEnvOverrides({ Path: "orig" }, { PATH: null })).toEqual({});
    expect(applyEnvOverrides({ Path: "orig" }, { path: null })).toEqual({});
  });

  it("adds a genuinely new key that matches nothing existing", () => {
    expect(applyEnvOverrides({ Path: "orig" }, { FOO: "bar" })).toEqual({
      Path: "orig",
      FOO: "bar",
    });
  });

  it("keeps a single PATH-like key when several overrides target it", () => {
    // Two overrides both naming PATH in different casings must still collapse
    // onto the one existing key - never leave `Path`, `PATH` and `path` all set.
    const result = applyEnvOverrides(
      { Path: "orig" },
      { PATH: "first", path: "second" },
    );
    expect(pathKeys(result)).toHaveLength(1);
    expect(Object.values(result)).toEqual(["second"]);
  });

  it("matches non-PATH vars case-insensitively too (Windows env semantics)", () => {
    // The win32 rule is general to the env object, not special-cased to PATH:
    // an inherited `Temp` is replaced by a `TEMP` override in place.
    const result = applyEnvOverrides({ Temp: "old" }, { TEMP: "new" });
    expect(Object.keys(result)).toEqual(["Temp"]);
    expect(result.Temp).toBe("new");
  });
});

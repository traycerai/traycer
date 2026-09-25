// gui-app's oxlint.config.ts pins GOMAXPROCS=1 (one tsgolint type checker
// instead of one per core, which multiplied the lint's memory) unless CI or
// GOMAXPROCS is set to a non-empty value. It lives in the config, not in
// lint-files.mjs, because oxlint evaluates the config in its own process
// before spawning tsgolint: the setting then reaches every type-aware run of
// this config, including an agent calling oxlint directly. The base config is
// `.oxlintrc.base.json`, so a bare `oxlint` in gui-app discovers only
// `oxlint.config.ts`. With a `.oxlintrc.json` present too, a bare `oxlint`
// fails and suggests deleting one, and `-c .oxlintrc.json` starts tsgolint
// without evaluating the config.
// Each case loads the real config in a fresh bun process and reads the env.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const GUI_APP_DIR = fileURLToPath(
  new URL("../../clients/gui-app", import.meta.url),
);
const CONFIG_URL = pathToFileURL(join(GUI_APP_DIR, "oxlint.config.ts")).href;

/** Imports `configUrl` in a fresh bun and returns the GOMAXPROCS it left. */
function gomaxprocsAfterLoading(configUrl, extra) {
  const env = { ...process.env };
  delete env.CI;
  delete env.GOMAXPROCS;
  Object.assign(env, extra);
  const script = `await import(${JSON.stringify(configUrl)}); console.log(JSON.stringify({ GOMAXPROCS: process.env.GOMAXPROCS ?? null }));`;
  const result = spawnSync("bun", ["--eval", script], {
    cwd: GUI_APP_DIR,
    env,
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  const lastLine = result.stdout.trim().split("\n").at(-1);
  return JSON.parse(lastLine).GOMAXPROCS;
}

describe("gui-app oxlint.config.ts single type checker", () => {
  it.each([
    ["locally", {}, "1"],
    ["under CI", { CI: "true" }, null],
    ["with an explicit GOMAXPROCS", { GOMAXPROCS: "4" }, "4"],
    ["with an empty CI", { CI: "" }, "1"],
    ["with an empty GOMAXPROCS", { GOMAXPROCS: "" }, "1"],
  ])(
    "%s",
    (_name, extra, expected) => {
      expect(gomaxprocsAfterLoading(CONFIG_URL, extra)).toBe(expected);
    },
    60_000,
  );

  it("a bare oxlint resolves to this config", () => {
    const printConfig = (args) => {
      const result = spawnSync("bun", ["x", "oxlint", ...args], {
        cwd: GUI_APP_DIR,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout;
    };
    expect(printConfig(["--print-config"])).toBe(
      printConfig(["-c", "oxlint.config.ts", "--print-config"]),
    );
  }, 60_000);

  it("lint-files.mjs runs oxlint with this config", () => {
    const script = readFileSync(
      join(GUI_APP_DIR, "scripts/lint-files.mjs"),
      "utf8",
    );
    expect(script).toMatch(/"oxlint",\s*"-c",\s*"oxlint\.config\.ts"/);
  });
});

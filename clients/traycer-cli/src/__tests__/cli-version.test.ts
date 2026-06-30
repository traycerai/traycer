import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOCAL_CLI_VERSION, buildProgram, resolveCliVersion } from "../index";

// `traycer --version` must report the release-injected
// `TRAYCER_CLI_VERSION` for SEA builds and the local/dev fallback
// otherwise. Before this fixup, `index.ts` registered a hardcoded
// `0.0.0` so the SEA artifact reported the source-tree placeholder
// even when the release workflow had injected the correct version
// (ticket:e86b8372-…/284b9132-…).
//
// These tests pin both the env-resolution unit boundary and the
// Commander integration so a future refactor that bypasses the
// helper (or drops the `.version(...)` call) cannot regress the
// SEA build silently.

describe("resolveCliVersion", () => {
  it("returns TRAYCER_CLI_VERSION when the release pipeline injected it", () => {
    expect(resolveCliVersion({ TRAYCER_CLI_VERSION: "1.6.0" })).toBe("1.6.0");
  });

  it("preserves pre-release suffixes (e.g. 1.6.0-rc.1) verbatim", () => {
    expect(resolveCliVersion({ TRAYCER_CLI_VERSION: "1.6.0-rc.1" })).toBe(
      "1.6.0-rc.1",
    );
  });

  it("falls back to the local/dev sentinel when the env var is unset", () => {
    expect(resolveCliVersion({})).toBe(LOCAL_CLI_VERSION);
    // Explicit undefined behaves the same as missing.
    expect(resolveCliVersion({ TRAYCER_CLI_VERSION: undefined })).toBe(
      LOCAL_CLI_VERSION,
    );
  });

  it("treats an empty TRAYCER_CLI_VERSION as 'unset' so a bogus injection still falls back", () => {
    expect(resolveCliVersion({ TRAYCER_CLI_VERSION: "" })).toBe(
      LOCAL_CLI_VERSION,
    );
  });

  it("returns the local sentinel in the literal form the package-manager refute_match guards against", () => {
    // The Homebrew formula's `refute_match /\A0\.0\.0(?:-local)?\z/`
    // pins exactly two placeholder shapes - '0.0.0' and '0.0.0-local'.
    // If a future refactor changed the sentinel to e.g. 'dev', the
    // release flow would also need to update the formula guard. This
    // test makes the coupling explicit so the change is intentional.
    expect(LOCAL_CLI_VERSION).toBe("0.0.0-local");
  });

  it("matches the fallback literal hardcoded in build-cli-sea.cjs", () => {
    // The SEA build pipeline embeds the same sentinel via esbuild's
    // `define` map. The two files live in different layers (TS source
    // + CJS build script) and CI failures from drift here are hard to
    // diagnose, so the cross-file invariant is pinned here.
    const buildScript = readFileSync(
      join(__dirname, "..", "..", "scripts", "build-cli-sea.cjs"),
      "utf8",
    );
    expect(buildScript).toContain(`"${LOCAL_CLI_VERSION}"`);
  });

  it("SEA release builds overwrite ambient TRAYCER_CLI_VERSION with the baked version", () => {
    const buildScript = readFileSync(
      join(__dirname, "..", "..", "scripts", "build-cli-sea.cjs"),
      "utf8",
    );
    expect(buildScript).toContain(
      "process.env.TRAYCER_CLI_VERSION=${JSON.stringify(cliVersion)}",
    );
    expect(buildScript).not.toContain(
      "if(!process.env.TRAYCER_CLI_VERSION)process.env.TRAYCER_CLI_VERSION=",
    );
  });

  it("npm release builds overwrite ambient CLI version/distribution env with baked package values", () => {
    const buildScript = readFileSync(
      join(__dirname, "..", "..", "scripts", "build-cli-npm.cjs"),
      "utf8",
    );
    expect(buildScript).toContain(
      "process.env.TRAYCER_CLI_VERSION=${JSON.stringify(cliVersion)}",
    );
    expect(buildScript).toContain('process.env.TRAYCER_CLI_DISTRIBUTION="npm"');
    expect(buildScript).not.toContain(
      "if(!process.env.TRAYCER_CLI_VERSION)process.env.TRAYCER_CLI_VERSION=",
    );
    expect(buildScript).not.toContain(
      "if(!process.env.TRAYCER_CLI_DISTRIBUTION)process.env.TRAYCER_CLI_DISTRIBUTION=",
    );
  });
});

describe("buildProgram() Commander version registration", () => {
  it("registers the local/dev fallback when TRAYCER_CLI_VERSION is unset at module-evaluation time", () => {
    // `buildProgram()` reads `process.env.TRAYCER_CLI_VERSION` directly,
    // so we save/restore the slot around the assertion. Tests run under
    // tsx/vitest where the env var is not injected at the build step,
    // so the natural default is the local fallback.
    const previous = process.env.TRAYCER_CLI_VERSION;
    delete process.env.TRAYCER_CLI_VERSION;
    try {
      const program = buildProgram();
      expect(program.version()).toBe(LOCAL_CLI_VERSION);
    } finally {
      if (previous === undefined) {
        delete process.env.TRAYCER_CLI_VERSION;
      } else {
        process.env.TRAYCER_CLI_VERSION = previous;
      }
    }
  });

  it("registers TRAYCER_CLI_VERSION when the release pipeline injected it", () => {
    const previous = process.env.TRAYCER_CLI_VERSION;
    process.env.TRAYCER_CLI_VERSION = "9.9.9";
    try {
      const program = buildProgram();
      expect(program.version()).toBe("9.9.9");
    } finally {
      if (previous === undefined) {
        delete process.env.TRAYCER_CLI_VERSION;
      } else {
        process.env.TRAYCER_CLI_VERSION = previous;
      }
    }
  });

  it("never advertises the bare '0.0.0' source-tree placeholder from the pre-fix code path", () => {
    const previous = process.env.TRAYCER_CLI_VERSION;
    delete process.env.TRAYCER_CLI_VERSION;
    try {
      const program = buildProgram();
      // Specifically guards the regression - the pre-fix value was
      // exactly "0.0.0" with no suffix. The local fallback is
      // "0.0.0-local" which is distinguishable.
      expect(program.version()).not.toBe("0.0.0");
    } finally {
      if (previous === undefined) {
        delete process.env.TRAYCER_CLI_VERSION;
      } else {
        process.env.TRAYCER_CLI_VERSION = previous;
      }
    }
  });
});

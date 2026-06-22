"use strict";

// Smoke test for the production CLI SEA artifact. Verifies that:
//
//   1. `dist-sea/traycer[.exe]` exists (`build:sea` ran first).
//   2. The binary executes with `PATH=""` so neither user-installed
//      `node` nor `bun` can be picked up - proving the SEA blob carries
//      its own Node runtime end-to-end.
//   3. The expected commander surface is reachable (`traycer --version`
//      returns a non-empty version string).
//
// `PATH=""` is the best-effort local approximation of "machine with no
// Node/Bun installed". On Windows PATH always includes the system32
// directory regardless, so we settle for clearing user PATH entries
// rather than emptying it entirely.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const workspaceRoot = path.resolve(__dirname, "..");
const binaryName = process.platform === "win32" ? "traycer.exe" : "traycer";
const binaryPath = path.join(workspaceRoot, "dist-sea", binaryName);

function fail(msg) {
  console.error(`[cli smoke] FAIL: ${msg}`);
  process.exit(1);
}

function buildCleanPath() {
  if (process.platform === "win32") {
    // Keep just system32; everything else (node/bun installers, scoop,
    // chocolatey) lives in user-controlled PATH segments.
    const sysRoot = process.env.SystemRoot || "C:\\Windows";
    return `${sysRoot}\\System32`;
  }
  // POSIX: empty PATH makes `node`/`bun` fall through to nothing; the
  // SEA binary uses its embedded Node and shouldn't shell out to either.
  return "";
}

function main() {
  if (!fs.existsSync(binaryPath)) {
    fail(
      `${binaryPath} not found. Run \`bun run --filter @traycer-clients/traycer-cli build:sea\` first.`,
    );
  }

  const cleanEnv = { ...process.env, PATH: buildCleanPath() };
  // Some shells (esp. zsh on macOS) inherit PATH via a `path` env var
  // when launching child processes; strip those casing variants too.
  delete cleanEnv.NODE;
  delete cleanEnv.BUN_INSTALL;

  const result = runVersionProbe(cleanEnv);
  if (result.error) {
    fail(
      `Failed to spawn ${binaryPath}: ${result.error.message || result.error}`,
    );
  }
  if (result.status !== 0) {
    fail(
      `\`traycer --version\` exited with status=${result.status}, stderr=${result.stderr}`,
    );
  }
  const out = (result.stdout || "").trim();
  if (out.length === 0) {
    fail("`traycer --version` produced no stdout");
  }
  // Regression guard for ticket:e86b8372-…/284b9132-… - the pre-fix
  // entrypoint advertised a hardcoded `0.0.0` regardless of what
  // `TRAYCER_CLI_VERSION` injected. The local-fallback sentinel is
  // `0.0.0-local`, so we only refuse the bare `0.0.0` shape here.
  if (out === "0.0.0") {
    fail(
      `\`traycer --version\` reported the pre-fix placeholder '0.0.0'; the SEA build is not consuming TRAYCER_CLI_VERSION`,
    );
  }
  // When the build environment injected an expected version, assert
  // the SEA reports it exactly. CI release workflows always set this;
  // local builds skip the check.
  const expected = process.env.TRAYCER_CLI_VERSION_EXPECT;
  if (typeof expected === "string" && expected.length > 0 && out !== expected) {
    fail(
      `\`traycer --version\` reported '${out}' but the test harness expected '${expected}' (TRAYCER_CLI_VERSION_EXPECT)`,
    );
  }
  if (typeof expected === "string" && expected.length > 0) {
    const hostileEnv = {
      ...cleanEnv,
      TRAYCER_CLI_VERSION: "0.0.0-local",
    };
    const hostileResult = runVersionProbe(hostileEnv);
    if (hostileResult.status !== 0) {
      fail(
        `hostile-env \`traycer --version\` exited with status=${hostileResult.status}, stderr=${hostileResult.stderr}`,
      );
    }
    const hostileOut = (hostileResult.stdout || "").trim();
    if (hostileOut !== expected) {
      fail(
        `hostile-env \`traycer --version\` reported '${hostileOut}' but expected baked version '${expected}'`,
      );
    }
  }

  console.log(
    `[cli smoke] OK platform=${process.platform} arch=${process.arch} version="${out}" path-isolation=${JSON.stringify(cleanEnv.PATH)}`,
  );
}

function runVersionProbe(env) {
  return spawnSync(binaryPath, ["--version"], {
    env,
    encoding: "utf8",
  });
}

main();

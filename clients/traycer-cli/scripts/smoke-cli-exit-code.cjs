"use strict";

// Repro/regression gate for the win32 SEA exit-teardown abort (int#4840,
// field: OSS #955 and #995, both 1.1.9 win32):
//
//   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
//
// The CLI printed its complete `host available --json` document and THEN died
// with that assertion, so the operation succeeded and the exit code said it
// failed. `assert(!(handle->flags & UV_HANDLE_CLOSING))` lives inside
// `uv_async_send()`; libuv's POSIX `uv_async_send` carries no such assertion,
// which is why this reproduces on Windows and nowhere else.
//
// It is a teardown RACE, so a single run proves nothing - this loops.
//
// THE INVARIANT, and why it is not "exit code must be 0": `host available`
// fetches the live registry manifest over the network. A genuine network
// failure is a legitimate CLI outcome - terminal `error` envelope, non-zero
// exit - and must NOT turn this gate red. The defect is precisely:
//
//     a terminal `ok` envelope was emitted AND the process still exited non-zero
//
// so that is what is asserted. Registry flakiness fails the fetch, not the
// gate. The assertion text on stderr is failed unconditionally on top, since
// nothing legitimate ever prints it.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const workspaceRoot = path.resolve(__dirname, "..");
const binaryName = process.platform === "win32" ? "traycer.exe" : "traycer";
const binaryPath = path.join(workspaceRoot, "dist-sea", binaryName);

// Every iteration is a full process spawn + a live registry fetch. The org
// caps CI jobs at ten minutes and the SEA build eats most of it, so keep the
// default modest and let the workflow raise it via the env var.
const DEFAULT_ITERATIONS = 15;

function fail(msg) {
  console.error(`[cli exit-code] FAIL: ${msg}`);
  process.exit(1);
}

function resolveIterations() {
  const raw = process.env.TRAYCER_CLI_EXIT_ITERATIONS;
  if (typeof raw !== "string" || raw.length === 0) return DEFAULT_ITERATIONS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    fail(
      `TRAYCER_CLI_EXIT_ITERATIONS must be a positive integer, got '${raw}'`,
    );
  }
  return parsed;
}

// The runner emits NDJSON: zero or more `progress` lines then exactly one
// terminal line. Mirrors `extractTerminalEnvelope` in
// clients/desktop/src/electron-main/cli/traycer-cli.ts - this gate has to
// agree with the consumer about what "the CLI succeeded" means.
function terminalStatus(stdout) {
  let status = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object") continue;
    if (parsed.type !== "result") continue;
    // A pre-runner CLI emitted a bare `{type:"result", data:...}`; absent
    // `status` reads as ok, same as the desktop parser.
    status = typeof parsed.status === "string" ? parsed.status : "ok";
  }
  return status;
}

function main() {
  if (!fs.existsSync(binaryPath)) {
    fail(
      `${binaryPath} not found. Run \`bun run --filter @traycer-clients/traycer-cli build:sea\` first.`,
    );
  }

  const iterations = resolveIterations();
  let okEnvelopes = 0;
  let fetchFailures = 0;

  for (let i = 1; i <= iterations; i += 1) {
    const result = spawnSync(binaryPath, ["host", "available", "--json"], {
      encoding: "utf8",
    });
    if (result.error) {
      fail(
        `iteration ${i}/${iterations}: failed to spawn ${binaryPath}: ${result.error.message || result.error}`,
      );
    }
    const stdout = result.stdout || "";
    const stderr = result.stderr || "";

    // Unconditional: no healthy exit path ever prints a libuv assertion,
    // whatever the exit code ended up being.
    if (stderr.includes("Assertion failed")) {
      fail(
        `iteration ${i}/${iterations}: libuv assertion on stderr (exit=${result.status})\n${stderr.trim()}`,
      );
    }

    const status = terminalStatus(stdout);
    if (status === "ok") {
      okEnvelopes += 1;
      if (result.status !== 0) {
        fail(
          `iteration ${i}/${iterations}: the CLI emitted a successful terminal envelope but exited ${result.status} - ` +
            `the work completed and the exit code reported failure.\nstderr: ${stderr.trim()}`,
        );
      }
      continue;
    }
    // No terminal ok: either the registry fetch genuinely failed (error
    // envelope) or the process died before emitting one. The first is not
    // this gate's business; the second is already covered by the assertion
    // check above, so just account for it and keep going.
    fetchFailures += 1;
  }

  if (okEnvelopes === 0) {
    fail(
      `no iteration produced a successful terminal envelope across ${iterations} runs - ` +
        `the registry was unreachable for the whole job, so this gate proved nothing.`,
    );
  }

  console.log(
    `[cli exit-code] OK platform=${process.platform} arch=${process.arch} ` +
      `iterations=${iterations} clean-exits=${okEnvelopes} fetch-failures=${fetchFailures}`,
  );
}

main();

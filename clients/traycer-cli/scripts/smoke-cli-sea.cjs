"use strict";

// Smoke test for the production CLI SEA artifact. Verifies that:
//
//   1. `dist-sea/traycer[.exe]` exists (`build:sea` ran first).
//   2. The binary executes with `PATH=""` so neither user-installed
//      `node` nor `bun` can be picked up - proving the SEA blob carries
//      its own Node runtime end-to-end.
//   3. The expected commander surface is reachable (`traycer --version`
//      returns a non-empty version string).
//   4. `node:sqlite` works INSIDE the SEA: the binary reads a fixture
//      chat-store stamp through `traycer host store-formats --json`.
//
// `PATH=""` is the best-effort local approximation of "machine with no
// Node/Bun installed". On Windows PATH always includes the system32
// directory regardless, so we settle for clearing user PATH entries
// rather than emptying it entirely.
//
// Why (4) is here and not in the vitest suites. The store-format floor - the
// gate that refuses a host downgrade over chat stores it cannot read - reads
// those stamps through Node's BUILT-IN `node:sqlite`, chosen precisely so the
// CLI ships no native addon (`scripts/build-cli-sea.cjs`). "Built-in" is a
// property of the Node runtime the SEA embeds, and the suites run under bun
// and a developer's node, neither of which is that runtime. Node also still
// labels the module "active development", so an embedded-runtime bump can
// move it without any source change here. This script runs on EVERY release
// platform (`release-cli.yml`, `macos-15-intel` included), which makes it the
// only check positioned to catch that before the binary ships - and the
// failure it catches is silent by construction: every survey error maps to
// `indeterminate`, so a broken engine would present as a floor that refuses
// every downgrade rather than as a crash.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Must match `chat-store-survey.ts` (`chat_db_meta` / `schema_version`, and
// the `epic-state/<epicId>/chat/chat.db` layout) and the host's own schema
// writer. A drift here shows up as this smoke reporting no epics, so the
// assertion below insists the epic is PRESENT, never merely that the command
// exited 0.
const FIXTURE_EPIC_ID = "smoke-epic-0000-0000-0000-000000000000";
const FIXTURE_CHAT_DB_FORMAT = 9;

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

  const chatDbFormat = probeChatStoreFormats(cleanEnv);

  console.log(
    `[cli smoke] OK platform=${process.platform} arch=${process.arch} version="${out}" chatDbFormat=${chatDbFormat} path-isolation=${JSON.stringify(cleanEnv.PATH)}`,
  );
}

function runVersionProbe(env) {
  return spawnSync(binaryPath, ["--version"], {
    env,
    encoding: "utf8",
  });
}

// Point the binary at a throwaway home and make it read a real SQLite file.
//
// The home is redirected rather than passed as a flag because `store/paths.ts`
// roots everything at `os.homedir()`, which Node resolves from `$HOME` on
// POSIX and `%USERPROFILE%` on Windows. That keeps the smoke off the running
// user's `~/.traycer` - it must never survey, or be confused by, a real
// installation - without adding a test-only flag to the shipped surface.
function probeChatStoreFormats(baseEnv) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "traycer-cli-smoke-"));
  try {
    const env = { ...baseEnv, HOME: home, USERPROFILE: home };
    // Pass 1 on an EMPTY home, for the data root the binary itself resolves.
    // Never a path this script composes: the root is environment-dependent
    // (`store/paths.ts` nests non-production environments), so a hardcoded
    // `.traycer/host` would silently survey an empty directory and report a
    // pass with no epics - the shape of a green run that proved nothing.
    const discovered = runStoreFormats(env, "on an empty home");
    const hostHome = discovered.data.hostHome;
    if (typeof hostHome !== "string" || hostHome.length === 0) {
      fail(
        `\`host store-formats --json\` reported no hostHome; data=${JSON.stringify(discovered.data)}`,
      );
    }
    if ((discovered.data.epics || []).length > 0) {
      fail(
        `the smoke's throwaway home is not empty - it may be surveying a real installation at ${hostHome}`,
      );
    }

    writeFixtureChatDb(hostHome);
    const event = runStoreFormats(env, "over the fixture store");
    const failures = event.data.failures || [];
    if (failures.length > 0) {
      // The load-bearing assertion. `node:sqlite` missing, unloadable, or
      // unable to open the file all land HERE as a failure entry rather than
      // as a non-zero exit, so a smoke that only checked the exit code would
      // pass on exactly the breakage this exists to catch.
      fail(
        `\`host store-formats --json\` could not read the fixture store: ${JSON.stringify(failures)}`,
      );
    }
    const epic = (event.data.epics || []).find(
      (row) => row.epicId === FIXTURE_EPIC_ID,
    );
    if (epic === undefined) {
      fail(
        `\`host store-formats --json\` did not report the fixture epic; data=${JSON.stringify(event.data)}`,
      );
    }
    if (epic.chatDbFormat !== FIXTURE_CHAT_DB_FORMAT) {
      fail(
        `fixture epic reported chatDbFormat=${epic.chatDbFormat}, expected ${FIXTURE_CHAT_DB_FORMAT}`,
      );
    }
    return epic.chatDbFormat;
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function runStoreFormats(env, context) {
  const result = spawnSync(binaryPath, ["host", "store-formats", "--json"], {
    env,
    encoding: "utf8",
  });
  if (result.error) {
    fail(
      `Failed to spawn \`host store-formats\` ${context}: ${result.error.message || result.error}`,
    );
  }
  if (result.status !== 0) {
    fail(
      `\`host store-formats --json\` ${context} exited with status=${result.status}, stderr=${result.stderr}`,
    );
  }
  const event = parseResultEvent(result.stdout || "");
  if (event === null) {
    fail(
      `\`host store-formats --json\` ${context} emitted no terminal result event; stdout=${JSON.stringify(result.stdout)}`,
    );
  }
  if (event.status !== "ok") {
    fail(
      `\`host store-formats --json\` ${context} reported ${event.error && event.error.code}: ${event.error && event.error.message}`,
    );
  }
  return event;
}

function writeFixtureChatDb(hostHome) {
  // The harness's own Node, not the SEA's: this is the fixture WRITER, and it
  // is deliberately a different runtime from the reader under test. A harness
  // Node without `node:sqlite` cannot produce the fixture at all, so it fails
  // loudly here rather than skipping the check that matters.
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch (err) {
    fail(
      `this Node (${process.version}) cannot load 'node:sqlite', so the chat-store fixture cannot be written: ${err && err.message}`,
    );
  }
  const chatDir = path.join(hostHome, "epic-state", FIXTURE_EPIC_ID, "chat");
  fs.mkdirSync(chatDir, { recursive: true });
  const db = new DatabaseSync(path.join(chatDir, "chat.db"));
  try {
    // Byte-for-byte the host's own `CHAT_DB_META_DDL`, and the stamp written
    // as TEXT the way the host writes it (`String(version)`). A fixture that
    // stored an integer would still pass - the survey parses both - and would
    // stop proving that the shape on a real machine is readable.
    db.exec(
      "CREATE TABLE IF NOT EXISTS chat_db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    db.prepare("INSERT INTO chat_db_meta (key, value) VALUES (?, ?)").run(
      "schema_version",
      String(FIXTURE_CHAT_DB_FORMAT),
    );
  } finally {
    db.close();
  }
}

// The runner emits NDJSON: zero or more `progress` lines, then exactly one
// terminal `result`. Take the LAST result line so a future progress event
// cannot break this parse.
function parseResultEvent(stdout) {
  let found = null;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (parsed && parsed.type === "result") found = parsed;
  }
  return found;
}

main();

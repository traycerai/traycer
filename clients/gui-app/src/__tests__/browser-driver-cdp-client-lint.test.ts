/// <reference types="node" />

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `clients/gui-app/scripts/*-browser*.mjs` are real-browser regression
 * drivers (vite + headless Chrome over CDP, `run-tests.ts` spawns each with
 * no timeout of its own). Every driver used to carry its own copy of a
 * `connectCdp` WebSocket client, and most copies had no path to settle a
 * command once Chrome died mid-command: no `close` handler, no per-command
 * deadline. A Chrome crash or a dropped DevTools socket then left `send()`
 * pending forever, the driver never reached its `finally` to terminate
 * Chrome and Vite, and the CI job hung until ITS OWN limit, hiding the real
 * failure behind a timeout rather than a red test.
 *
 * They now all import ONE hardened client, `scripts/cdp-client.mjs`
 * (`export function connectCdp`), whose `send()` rejects - never hangs - on
 * a socket error, a socket close, or a command that outlives its own
 * deadline. This guard's job is to keep it that way: no driver reintroduces
 * a private `connectCdp`, every caller of `connectCdp(` reaches it through
 * the shared module, and no driver reconstructs the underlying `WebSocket`
 * itself outside a reasoned, named exception.
 *
 * WHY A SOURCE SCAN AND NOT A BEHAVIOURAL TEST. The regression this guards
 * against is architectural - a second implementation existing at all - not a
 * runtime outcome jsdom can observe: these files spawn real headless Chrome
 * and are deliberately not run under vitest. `cdp-client-browser.mjs` is the
 * behavioural half, driving a real dying Chrome process against the shared
 * client; this file is the census that keeps a new driver, or an ablated one,
 * from quietly growing a second client instead of importing the one that was
 * already hardened.
 */
const SCRIPTS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
);

/** The one file allowed to own the real implementation. */
const CDP_CLIENT_FILE = "cdp-client.mjs";

/**
 * Files allowed to construct their own `WebSocket`, each with the reason
 * written beside it. Both predate the shared client, drive a fundamentally
 * different event surface than `send`/`close` models, and already fail their
 * own pending requests on socket close/error - so neither is the hang this
 * guard exists to prevent; they are just not migrated, on purpose.
 */
const WEBSOCKET_ALLOWLIST: readonly string[] = [
  // A manual driver - not run by CI or `run-tests.ts` - whose client also
  // captures `Runtime.exceptionThrown` events, which the shared send/close
  // client does not model.
  "tab-recovery-browser-regression.mjs",
  // A development tool that attaches to the LIVE desktop app over CDP (not a
  // test); same event-capturing mismatch as the driver above.
  "seed-canvas-fixture-browser.mjs",
];

/**
 * A little below the real count (17 importers as of writing) so ordinary
 * churn - one driver renamed or retired - doesn't redden this, while a glob
 * that silently stopped matching anything (an empty or near-empty result)
 * still would.
 */
const MIN_CDP_CLIENT_IMPORTERS = 12;

/** `function connectCdp(`, `async function connectCdp(`, or `const connectCdp =`. */
const OWN_CONNECT_CDP_DECLARATION =
  /\b(?:(?:export\s+)?(?:async\s+)?function\s+connectCdp\s*\(|const\s+connectCdp\s*=)/;

const CONNECT_CDP_CALL = /\bconnectCdp\s*\(/;

const CDP_CLIENT_IMPORT =
  /import\s*\{[^}]*\bconnectCdp\b[^}]*\}\s*from\s*["']\.\/cdp-client\.mjs["']/;

const NEW_WEBSOCKET = /\bnew\s+WebSocket\s*\(/;

/** Every `*.mjs` file directly in `scripts/` (no recursion - there are no subdirectories of drivers). */
function listScriptFiles(): readonly string[] {
  return readdirSync(SCRIPTS_DIR)
    .filter((entry) => entry.endsWith(".mjs"))
    .sort();
}

function readScript(file: string): string {
  return readFileSync(path.join(SCRIPTS_DIR, file), "utf8");
}

describe("browser driver CDP client stays singular (scripts/cdp-client.mjs)", () => {
  const files = listScriptFiles();
  const otherFiles = files.filter((file) => file !== CDP_CLIENT_FILE);

  it(`found at least ${String(MIN_CDP_CLIENT_IMPORTERS)} drivers importing connectCdp from ./cdp-client.mjs (a sanity floor - a broken glob must not pass vacuously)`, () => {
    const importers = otherFiles.filter((file) =>
      CDP_CLIENT_IMPORT.test(readScript(file)),
    );
    expect(importers.length).toBeGreaterThanOrEqual(MIN_CDP_CLIENT_IMPORTERS);
  });

  it("no file but cdp-client.mjs declares its own connectCdp", () => {
    const offenders = otherFiles.filter((file) =>
      OWN_CONNECT_CDP_DECLARATION.test(readScript(file)),
    );
    expect(offenders).toEqual([]);
  });

  it("every file that calls connectCdp( imports it from ./cdp-client.mjs", () => {
    const offenders = otherFiles.filter((file) => {
      const source = readScript(file);
      return CONNECT_CDP_CALL.test(source) && !CDP_CLIENT_IMPORT.test(source);
    });
    expect(offenders).toEqual([]);
  });

  it("no file but cdp-client.mjs and the reasoned allowlist constructs its own WebSocket", () => {
    const offenders = otherFiles.filter((file) => {
      if (WEBSOCKET_ALLOWLIST.includes(file)) return false;
      return NEW_WEBSOCKET.test(readScript(file));
    });
    expect(offenders).toEqual([]);
  });

  it("every allowlisted file still constructs its own WebSocket (a stale entry must be noticed)", () => {
    const stale = WEBSOCKET_ALLOWLIST.filter(
      (file) => !NEW_WEBSOCKET.test(readScript(file)),
    );
    expect(stale).toEqual([]);
  });
});

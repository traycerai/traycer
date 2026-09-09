/// <reference types="node" />

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EPIC_WORKER_STREAM_METHOD_LIST } from "@traycer-clients/shared/replica-runtime/worker/stream-proxy-protocol";

/**
 * THE WORKER NEVER DIALS.
 *
 * It holds an `IStreamClient` proxy whose frames cross the bridge; the socket,
 * its process-wide session cache and every app-wide single-flight it depends on
 * stay on the main thread. This file is the static half of that rule, and it is
 * static because no runtime pin can reach it: a proxy that behaves correctly in
 * every test would still be wrong if the module beside it opened a second
 * socket, and nothing about the proxy's behaviour would say so.
 *
 * Three distinct failure modes, all of them "a second copy of something that
 * must be app-wide":
 *
 *   - `RemoteSession` is PROCESS-scoped. `acquireRemoteSession` is a module
 *     cache in which the RPC messenger, every durable stream client and the
 *     app-wide client share exactly ONE session per (hostId, userId) - one
 *     Noise handshake, one relay socket, one re-auth loop. A worker importing
 *     it gets a second one, outside the process-wide wake sweep. Mobile is
 *     remote-only, so this is the common path, not an edge.
 *   - the credential mint is MODULE-scoped. `appHostCredentialMintFlow` closes
 *     over module-level maps (in-flight attempts, the adoption claim, the
 *     escalation ladder); a second copy is not a second reference to one flow
 *     but a second copy of all its state. The server supersedes older
 *     credentials on every mint, so two copies revoke each other and settle as
 *     409s, leaving the host with nothing.
 *   - `StreamAuthRevalidator` is INSTANCE-scoped: `useStreamAuthRevalidator`
 *     memoises one per `AuthService` and 13 consumers share it, so one expiry
 *     produces one refresh rather than thirteen.
 *
 * Scope is the worker tree's PRODUCTION files. Tests are excluded because a
 * suite naming a symbol in a fixture is not a production import - this file
 * names every one of them itself.
 */
const WORKER_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * The real symbols, by name.
 *
 * Named rather than matched by concept, because a concept grep is the one that
 * lies: "revalidat" also matches every comment explaining why the import is
 * absent, and a suite that greps for prose reports a violation the moment
 * somebody documents the rule.
 */
const FORBIDDEN_SYMBOLS: readonly string[] = [
  // --- the app-wide single-flights ---
  "createStreamAuthRevalidator",
  "useStreamAuthRevalidator",
  "appHostCredentialMintFlow",
  "setHostCredentialMintRunner",
  "useRunnerHost",
  // --- anything that opens a socket ---
  "WsStreamClient",
  "createRemoteHostTransport",
  "acquireRemoteSession",
  "buildHostStreamClient",
  "openDurableStreamTransport",
  "browserStreamWebSocketFactory",
];

/** The modules they live in, for an import that renames on the way. */
const FORBIDDEN_MODULES: readonly string[] = [
  "lib/auth/stream-auth-revalidator",
  "lib/host/stream-auth-revalidator",
  "lib/auth/host-credential-provisioning",
  "lib/host/durable-stream-transport",
  "lib/host/use-durable-stream-transport",
  "providers/use-runner-host",
  "host-transport/ws-stream-client",
  "host-transport/remote/create-remote-transport",
  "host-transport/remote/active-remote-sessions",
  "host-transport/whatwg-stream-ws-factory",
];

function productionFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      return entry === "__tests__" ? [] : productionFiles(full);
    }
    return entry.endsWith(".ts") || entry.endsWith(".tsx") ? [full] : [];
  });
}

describe("the worker never dials", () => {
  const files = productionFiles(WORKER_DIR);

  it("has production files to check", () => {
    // A walk that found nothing would make every assertion below vacuous - the
    // `it.each` would expand to zero cases and the suite would report green
    // having read no code at all.
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s", (file) => {
    const source = readFileSync(file, "utf8");
    // Import statements only. These names appear in prose all over this tree -
    // explaining exactly why the socket stays on main - and a whole-file grep
    // would flag that prose as the violation.
    const imports = source
      .split("\n")
      .filter((line) => /^\s*import\b|^\s*}\s*from\s+"/.test(line))
      .join("\n");
    const importedSymbols = FORBIDDEN_SYMBOLS.filter((symbol) =>
      new RegExp(`\\b${symbol}\\b`).test(imports),
    );
    expect(importedSymbols).toEqual([]);
    const importedModules = FORBIDDEN_MODULES.filter((module) =>
      source.includes(`/${module}"`),
    );
    expect(importedModules).toEqual([]);
  });

  it("forbids at least one dialling symbol per method the proxy carries", () => {
    // Ties the list to the ruling rather than leaving it a loose inventory: the
    // worker subscribes exactly the closed union's methods and opens exactly
    // zero sockets to do it. A fifth method arriving is a moment to re-read
    // this list, not to extend it silently.
    expect(FORBIDDEN_SYMBOLS.length).toBeGreaterThan(
      EPIC_WORKER_STREAM_METHOD_LIST.length,
    );
    expect([...EPIC_WORKER_STREAM_METHOD_LIST].sort()).toEqual([
      "artifact.subscribe",
      "epic.state.subscribe",
      "epic.status.subscribe",
      "epic.subscribe",
    ]);
  });
});

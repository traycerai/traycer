
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EPIC_WORKER_STREAM_METHOD_LIST } from "@traycer-clients/shared/replica-runtime/worker/stream-proxy-protocol";

/** THE WORKER NEVER DIALS. */
const WORKER_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** The real symbols, by name. */
const FORBIDDEN_SYMBOLS: readonly string[] = [
  "createStreamAuthRevalidator",
  "useStreamAuthRevalidator",
  "appHostCredentialMintFlow",
  "setHostCredentialMintRunner",
  "useRunnerHost",
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
    // A walk that found nothing would make every assertion below vacuous - the `it.each` would expand
    // to zero cases and the suite would report green having read no code at all.
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s", (file) => {
    const source = readFileSync(file, "utf8");
    // Import statements only. These names appear in prose all over this tree - explaining exactly why
    // the socket stays on main - and a whole-file grep would flag that prose as the violation.
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

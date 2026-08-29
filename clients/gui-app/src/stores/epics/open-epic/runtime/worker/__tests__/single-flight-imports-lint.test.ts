/// <reference types="node" />

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAIN_CALL_KINDS } from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";

/**
 * The worker tree must not IMPORT either app-wide single-flight. It may only
 * be handed one.
 *
 * This is the half of the ruling that a runtime pin cannot reach. The spawner's
 * identity pins prove the handler map calls the instance it was passed - but
 * they say nothing about where that instance came from, and a provider that
 * constructed a fresh revalidator on the way in would satisfy every one of
 * them. The only static fact that closes it is this: the worker tree contains
 * no route to a second instance, because it never names the things that build
 * one.
 *
 * The two failure modes are not the same, and both are covered:
 *
 *   - `StreamAuthRevalidator` is INSTANCE-scoped. `useStreamAuthRevalidator`
 *     memoises one per `AuthService`, and 13 consumers share it so that a
 *     single expiry produces one refresh rather than thirteen. A second
 *     instance is a second single-flight.
 *   - the mint flow is MODULE-scoped. `appHostCredentialMintFlow` closes over
 *     module-level maps (the in-flight attempts, the adoption claim, the
 *     escalation ladder), so importing the module inside a bundle the worker
 *     owns does not give you a second reference to one flow - it gives you a
 *     second COPY of all of its state. The server supersedes older credentials
 *     on every mint, so two copies revoke each other's rows and settle as 409s,
 *     leaving the host with nothing.
 *
 * Scope is the worker tree's PRODUCTION files. Tests are excluded because a
 * suite naming a symbol in a fixture or an assertion is not a production
 * import - this file names all of them itself.
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
  // Builds a StreamAuthRevalidator.
  "createStreamAuthRevalidator",
  // The hook that memoises the shared one - and a hook cannot run in a worker
  // at all, so an import of it is evidence of a much larger mistake.
  "useStreamAuthRevalidator",
  // The module-scoped mint flow, and the seam that installs its runner.
  "appHostCredentialMintFlow",
  "setHostCredentialMintRunner",
  // The runner host the mint is reached through on the main thread.
  "useRunnerHost",
];

/** The modules those symbols live in, for an import that renames on the way. */
const FORBIDDEN_MODULES: readonly string[] = [
  "lib/auth/stream-auth-revalidator",
  "lib/host/stream-auth-revalidator",
  "lib/auth/host-credential-provisioning",
  "providers/use-runner-host",
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

describe("the worker tree never imports an app-wide single-flight", () => {
  const files = productionFiles(WORKER_DIR);

  it("has production files to check", () => {
    // A walk that found nothing would make every assertion below vacuous - the
    // `it.each` would expand to zero cases and the suite would report green
    // having read no code at all.
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s", (file) => {
    const source = readFileSync(file, "utf8");
    // Import statements only. The symbol names appear in prose all over this
    // tree - explaining exactly why they are called rather than constructed -
    // and a whole-file grep would flag that prose as the violation.
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

  it("covers one forbidden symbol per worker->main call, plus the transitive ones", () => {
    // Ties the list to the ruling: the two calls exist because two things are
    // app-wide single-flights, so a THIRD call arriving without a new entry
    // here would leave its single-flight unguarded. The count is deliberately
    // `>=` - `useRunnerHost` and `setHostCredentialMintRunner` are reachable
    // routes to the same two flows, not calls of their own.
    expect(FORBIDDEN_SYMBOLS.length).toBeGreaterThanOrEqual(
      MAIN_CALL_KINDS.length,
    );
    expect([...MAIN_CALL_KINDS]).toEqual([
      "main/auth-revalidate",
      "main/mint-credential",
    ]);
  });
});

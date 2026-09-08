/// <reference types="node" />

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * No module owning PROCESS-SCOPED state may be value-reachable from the worker
 * entry.
 *
 * This is the third member of one class. `appHostCredentialMintFlow` was the
 * first: a module-scoped single-flight whose app-wideness is guaranteed by
 * module identity, so a worker importing it gets a second COPY of its state
 * rather than a second reference to one. `active-remote-sessions`' process-wide
 * `RemoteSession` cache was the second - it is why the socket never moved.
 * `process-memory-accountant`'s `let processRuntime` is the third, and 4e
 * closed it by INVERTING the dependency rather than by moving the module -
 * which is why this file walks two entries rather than one.
 *
 * Every one of them is invisible to an in-process suite, because in-process the
 * "worker" shares the module instance and there is exactly one copy. No
 * behavioural test can find these; only the import graph can.
 *
 * A RATCHET, and today it holds the set at ZERO with an EMPTY allowlist -
 * which is stronger than the allowlist this started with. WHICH REASON holds
 * it there changed at the flip, and reading the old one out of this header is
 * how a future edit talks itself into a re-coupling: the entry DOES import the
 * composition root now (`installEpicRuntimeCore`), so `epic-replica-runtime.ts`
 * is squarely inside this graph and the walk is not small any more. It holds at
 * zero because 4e INVERTED the accounting dependency - the runtime receives an
 * `EpicRuntimeAccountingPort` through its options and no longer names
 * `process-memory-accountant` by module identity, so that import stays on main
 * in `process-backed-accounting-port.ts`.
 *
 * So this pin is load-bearing every day rather than on some future commit. It
 * reds on any change that re-couples the worker's graph to a process-scoped
 * module: re-importing the accountant, or reaching `active-remote-sessions` or
 * the mint flow from anything the composition pulls in. The allowlist stays
 * EMPTY rather than pre-loaded, because an entry naming a chain the graph does
 * not have makes the anti-rot check below assert nothing - a failing test
 * describing nothing.
 */
const WORKER_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
// SEVEN, not six: worker → runtime → open-epic → epics → stores → src →
// gui-app → clients. At six this landed on `gui-app`, so every `@/` specifier
// resolved to a path that does not exist, the walk never left this directory,
// and the pin passed while seeing nothing. Caught by ablating it - a value
// import of the accountant from the entry stayed GREEN.
const CLIENTS_DIR = path.join(
  WORKER_DIR,
  "..",
  "..",
  "..",
  "..",
  "..",
  "..",
  "..",
);

const ENTRY = path.join(WORKER_DIR, "epic-runtime-worker-entry.ts");

/**
 * The second entry, and the one 4e actually moved.
 *
 * `epic-replica-runtime.ts` is reachable from `ENTRY` today (entry ->
 * `install-epic-runtime-core` -> `epic-runtime-composition` -> here), so this
 * walk no longer covers ground the first one misses. It is kept because it
 * ISOLATES the module 4e changed: before 4e this file value-imported
 * `process-memory-accountant` directly, and a regression re-adding that import
 * reds here naming the RUNTIME rather than naming the whole entry graph -
 * which is the difference between a diagnosis and a symptom.
 */
const RUNTIME_ENTRY = path.join(WORKER_DIR, "..", "epic-replica-runtime.ts");

/**
 * Known process-scoped modules, each with the chain that reaches it.
 *
 * Emptied by 4e, which inverts the runtime's accounting dependency so
 * `epic-replica-runtime.ts` stops reaching for the singleton by module
 * identity.
 */
const ALLOWED: ReadonlyMap<string, string> = new Map();

/**
 * The floor under {@link GraphWalk.resolvedAliasCount}. Today's count is 5.
 *
 * Deliberately BELOW the real count and well above zero. The failure this
 * guards - a `CLIENTS_DIR` that points at the wrong directory - takes the
 * count to zero outright rather than decrementing it, because both alias
 * families (`@/` and `@traycer-clients/shared/`) resolve off that one anchor.
 * A floor pinned to the exact count would instead red on any unrelated import
 * being removed, and a pin that reds for uninteresting reasons gets its number
 * bumped without being read.
 */
const MIN_RESOLVED_ALIAS_IMPORTS = 3;

/** Modules that own module-level state and are CORRECT to duplicate per thread. */
const PER_THREAD_OK: readonly string[] = [];

/**
 * Value imports only.
 *
 * `import type X`, and a braced clause whose specifiers are ALL `type`, emit
 * nothing - so they create no module instance and cannot fork a singleton.
 * A walker that counts them reports four false positives here on day one
 * (`negotiated-manifest-registry`, `remote-session`, `ws-rpc-client`,
 * `ws-stream-client` are all type-only reachable), which is how a pin teaches
 * people to ignore it.
 */
function valueImportSpecs(source: string): string[] {
  const specs: string[] = [];
  const withClause =
    /^\s*import\s+(?!type\s)([^;]*?)\s*from\s*["']([^"']+)["']/gm;
  let match = withClause.exec(source);
  while (match !== null) {
    const clause = match[1];
    const braced = /\{([^}]*)\}/s.exec(clause);
    const names =
      braced === null
        ? []
        : braced[1]
            .split(",")
            .map((n) => n.trim())
            .filter((n) => n.length > 0);
    const allTypes =
      names.length > 0 && names.every((n) => n.startsWith("type "));
    if (!allTypes) specs.push(match[2]);
    match = withClause.exec(source);
  }
  const bare = /^\s*import\s+["']([^"']+)["']/gm;
  let sideEffect = bare.exec(source);
  while (sideEffect !== null) {
    specs.push(sideEffect[1]);
    sideEffect = bare.exec(source);
  }
  return specs;
}

function resolveSpec(spec: string, from: string): string | null {
  let base: string;
  if (spec.startsWith("@/"))
    base = path.join(CLIENTS_DIR, "gui-app/src", spec.slice(2));
  else if (spec.startsWith("@traycer-clients/shared/"))
    base = path.join(
      CLIENTS_DIR,
      "shared",
      spec.slice("@traycer-clients/shared/".length),
    );
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** By PREDICATE, never a name list - the 4th member must fail here too. */
function ownsProcessState(source: string): boolean {
  const body = source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
  return (
    /^let\s+\w+/m.test(body) ||
    /^const\s+\w+\s*=\s*new (?:Map|Set|WeakMap|WeakSet)\b/m.test(body)
  );
}

interface GraphWalk {
  /** Process-scoped modules found, keyed by module, valued by the chain. */
  readonly stateful: ReadonlyMap<string, string>;
  /**
   * How many WORKSPACE-ALIASED specifiers (`@/`, `@traycer-clients/shared/`)
   * actually resolved to a file on disk.
   *
   * This is the pin's own liveness signal. `resolveSpec` returns `null` for
   * anything it cannot place, and a null is indistinguishable from "this
   * module imports nothing forbidden" - which is precisely how a wrong
   * `CLIENTS_DIR` made the whole walk vacuous while it reported success.
   */
  readonly resolvedAliasCount: number;
}

function walk(entry: string): GraphWalk {
  const parent = new Map<string, string>();
  const seen = new Set<string>([entry]);
  const queue: string[] = [entry];
  let resolvedAliasCount = 0;
  while (queue.length > 0) {
    const file = queue.shift();
    if (file === undefined || !existsSync(file)) continue;
    for (const spec of valueImportSpecs(readFileSync(file, "utf8"))) {
      const resolved = resolveSpec(spec, file);
      // Counted per SPECIFIER, not per newly-seen module: a module reached
      // twice still proves its alias resolved both times, and counting only
      // first sights would make the floor drift with graph shape.
      if (resolved !== null && !spec.startsWith(".")) resolvedAliasCount += 1;
      if (resolved !== null && !seen.has(resolved)) {
        seen.add(resolved);
        parent.set(resolved, file);
        queue.push(resolved);
      }
    }
  }
  const stateful = new Map<string, string>();
  for (const file of seen) {
    if (file.includes("__tests__") || file.includes("test-support")) continue;
    if (!ownsProcessState(readFileSync(file, "utf8"))) continue;
    const chain: string[] = [];
    let cursor: string | undefined = file;
    while (cursor !== undefined) {
      chain.push(path.relative(CLIENTS_DIR, cursor));
      cursor = parent.get(cursor);
    }
    stateful.set(
      path.relative(CLIENTS_DIR, file),
      chain.reverse().join("\n      -> "),
    );
  }
  return { stateful, resolvedAliasCount };
}

/**
 * The runtime entry's allowlist. SEPARATE from {@link ALLOWED}, which covers
 * the worker entry — and, since 4f, **also empty**.
 *
 * It held one entry: `active-remote-sessions`, reached because
 * `StaleHostBindingAuthorityError` was DECLARED inside
 * `host-binding-authority-registry.ts`, a module that value-imports the
 * process-wide `RemoteSession` cache. `epic-write-command.ts` read none of that
 * registry's members — 0 of its 2 structural exports — and imported the module
 * only to `instanceof` that one class. 4f moved the class to an import-free
 * leaf (`host-binding-authority-error.ts`), which cut the chain while keeping
 * `instanceof` exactly as sharp.
 *
 * Both allowlists are now empty, which is the T14 gate. Keeping it empty is
 * the point: an entry here is a singleton with permission to ship.
 */
const RUNTIME_ALLOWED: ReadonlyMap<string, string> = new Map();

describe("the epic replica runtime's value-import graph", () => {
  it("no longer reaches the process memory accountant - 4e's inversion, pinned", () => {
    // Before 4e this walk found `process-memory-accountant` one hop out, via
    // `ensureProcessMemoryRuntime(environment)` in the runtime's constructor.
    // The accountant is now supplied as `options.accounting`, so the module
    // that moves into the worker no longer names the singleton at all and the
    // import lives on main, in `process-backed-accounting-port.ts`.
    const found = walk(RUNTIME_ENTRY).stateful;
    const detail = [...found.keys()]
      .filter((file) => !RUNTIME_ALLOWED.has(file))
      .map((file) => `${file}\n      via ${found.get(file) ?? "?"}`)
      .join("\n\n");
    expect(detail).toBe("");
  });

  it("keeps ITS allowlist honest - the recorded chain must still exist", () => {
    // Same anti-rot check as the worker entry's. An entry naming a chain the
    // graph no longer has is permission granted to nothing, and it would wave
    // through the next singleton to appear under that name. When the
    // write-command ruling lands, this test is what tells you to delete the
    // entry rather than leaving it as cover.
    const found = walk(RUNTIME_ENTRY).stateful;
    for (const file of RUNTIME_ALLOWED.keys()) {
      expect(found.has(file)).toBe(true);
    }
  });

  it("resolves its own anchor, so the walk above is not vacuous", () => {
    expect(walk(RUNTIME_ENTRY).resolvedAliasCount).toBeGreaterThanOrEqual(
      MIN_RESOLVED_ALIAS_IMPORTS,
    );
  });
});

describe("the worker entry's value-import graph", () => {
  // The pin's own liveness, asserted BEFORE anything it concludes.
  //
  // This pin once passed while seeing nothing: `CLIENTS_DIR` was one `..`
  // short, landing on `gui-app` instead of `clients`, so every `@/` specifier
  // resolved to a path that does not exist, `resolveSpec` answered `null`, the
  // walk never left this directory, and "no forbidden module found" was true
  // and worthless. The ablation that should have reddened it stayed GREEN.
  //
  // A graph pin that resolves nothing is indistinguishable from a clean graph,
  // so the resolver's own success is the thing to assert. Both halves matter:
  // the anchor check fails loudly and exactly on a path change, and the
  // positive count fails if resolution breaks for any other reason.
  it("resolves its own anchor and a positive number of aliased imports", () => {
    // Exact, and immune to how large the graph happens to be.
    expect(existsSync(path.join(CLIENTS_DIR, "gui-app"))).toBe(true);
    expect(existsSync(path.join(CLIENTS_DIR, "shared"))).toBe(true);

    // A floor, not the current count: the graph legitimately grows, and a
    // pin that must be edited on every unrelated import gets edited without
    // being read.
    expect(walk(ENTRY).resolvedAliasCount).toBeGreaterThanOrEqual(
      MIN_RESOLVED_ALIAS_IMPORTS,
    );
  });

  it("reaches no process-scoped module outside the ratchet's allowlist", () => {
    const found = walk(ENTRY).stateful;
    const unexpected = [...found.keys()].filter(
      (file) => !ALLOWED.has(file) && !PER_THREAD_OK.includes(file),
    );
    // The chain, not just the module: "which import pulled it in" is the whole
    // of the fix, and a bare module name sends the reader looking for it.
    const detail = unexpected
      .map((file) => `${file}\n      via ${found.get(file) ?? "?"}`)
      .join("\n\n");
    expect(detail).toBe("");
  });

  it("keeps the allowlist honest - every entry must still be reachable", () => {
    // The other direction, and it is why the allowlist is empty today. An
    // entry naming a module the graph does not reach is a permission granted
    // to nothing, and the next singleton to appear under that name would be
    // waved through. With an empty allowlist this holds vacuously and starts
    // meaning something the moment an entry is added.
    const found = walk(ENTRY).stateful;
    for (const file of ALLOWED.keys()) {
      expect(found.has(file)).toBe(true);
    }
  });
});


import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WORKER_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
// SEVEN, not six: worker → runtime → open-epic → epics → stores → src → gui-app → clients.
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

/** The second entry, and the one 4e actually moved. */
const RUNTIME_ENTRY = path.join(WORKER_DIR, "..", "epic-replica-runtime.ts");

/** Known process-scoped modules, each with the chain that reaches it. */
const ALLOWED: ReadonlyMap<string, string> = new Map();

/** The floor under {@link GraphWalk.resolvedAliasCount}. Today's count is 5. */
const MIN_RESOLVED_ALIAS_IMPORTS = 3;

/** Modules that own module-level state and are CORRECT to duplicate per thread. */
const PER_THREAD_OK: readonly string[] = [];

/**
 * Value imports only. `import type X`, and a braced clause whose specifiers are ALL `type`, emit
 * nothing - so they create no module instance and cannot fork a singleton.
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
   * How many WORKSPACE-ALIASED specifiers (`@/`, `@traycer-clients/shared/`) actually resolved to a
   * file on disk. This is the pin's own liveness signal.
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
      // Counted per SPECIFIER, not per newly-seen module: a module reached twice still proves its alias
      // resolved both times, and counting only first sights would make the floor drift with graph shape.
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
 * The runtime entry's allowlist. SEPARATE from {@link ALLOWED}, which covers the worker entry -
 * and, since 4f, also empty.
 */
const RUNTIME_ALLOWED: ReadonlyMap<string, string> = new Map();

describe("the epic replica runtime's value-import graph", () => {
  it("no longer reaches the process memory accountant - 4e's inversion, pinned", () => {
    // Before 4e this walk found `process-memory-accountant` one hop out, via
    // `ensureProcessMemoryRuntime(environment)` in the runtime's constructor.
    const found = walk(RUNTIME_ENTRY).stateful;
    const detail = [...found.keys()]
      .filter((file) => !RUNTIME_ALLOWED.has(file))
      .map((file) => `${file}\n      via ${found.get(file) ?? "?"}`)
      .join("\n\n");
    expect(detail).toBe("");
  });

  it("keeps ITS allowlist honest - the recorded chain must still exist", () => {
    // Same anti-rot check as the worker entry's.
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
  it("resolves its own anchor and a positive number of aliased imports", () => {
    // Exact, and immune to how large the graph happens to be.
    expect(existsSync(path.join(CLIENTS_DIR, "gui-app"))).toBe(true);
    expect(existsSync(path.join(CLIENTS_DIR, "shared"))).toBe(true);

    // A floor, not the current count: the graph legitimately grows, and a pin that must be edited on
    // every unrelated import gets edited without being read.
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
    // The other direction, and it is why the allowlist is empty today.
    const found = walk(ENTRY).stateful;
    for (const file of ALLOWED.keys()) {
      expect(found.has(file)).toBe(true);
    }
  });
});

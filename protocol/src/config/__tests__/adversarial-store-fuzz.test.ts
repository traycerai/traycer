import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Same harness seams the sibling store.test.ts uses: redirect the config file
// to a per-test temp home via os.homedir, and pin the passwd login shell so
// defaultShellPath() is deterministic (the mirror's args-only-auto branch reads
// it). os.platform() stays real: on the macOS/Linux CI runner isWindows === false,
// so path comparison is case-sensitive throughout.
const h = vi.hoisted(() => ({ home: "", passwdShell: "/bin/zsh" }));
vi.mock("node:os", async (importActual) => {
  const actual = await importActual<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => h.home,
    userInfo: (...args: Parameters<typeof actual.userInfo>) => {
      const base = actual.userInfo(...args);
      return { ...base, shell: h.passwdShell };
    },
  };
});

import { cliConfigPath } from "../paths";
import type { CliConfig } from "../schema";
import {
  addShell,
  defaultShellArgs,
  defaultShellPath,
  readCliConfig,
  removeShell,
  resetShell,
  revertShellArgs,
  setShell,
} from "../store";

const DEFAULT_PATH = "/bin/zsh"; // == passwdShell, so defaultShellPath() returns it.

beforeEach(async () => {
  h.home = await mkdtemp(join(tmpdir(), "traycer-fuzz-config-"));
  h.passwdShell = "/bin/zsh";
});

// ------------------------------------------------------------------ //
// Independent reference model of the intended (contract) semantics.
// Deliberately NOT sharing code with the store: divergence between this
// and the real store on any op sequence is a finding.
// ------------------------------------------------------------------ //

type RefEntry = { path: string; args: string[] | null };
interface RefState {
  path: string | null;
  args: string[] | null;
  entries: RefEntry[];
}

function famDefault(path: string): string[] {
  return [...defaultShellArgs(path)];
}

function eq(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function canon(args: readonly string[] | null, path: string): string[] | null {
  if (args === null) return null;
  return eq(args, famDefault(path)) ? null : [...args];
}

function entryFor(entries: RefEntry[], path: string): RefEntry | undefined {
  return entries.find((e) => e.path === path);
}

function upsert(
  entries: RefEntry[],
  path: string,
  args: readonly string[] | null,
): RefEntry[] {
  const others = entries.filter((e) => e.path !== path);
  return [...others, { path, args: canon(args, path) }];
}

function refSetShell(
  s: RefState,
  path: string | null,
  args: readonly string[] | null,
): void {
  if (args !== null) {
    const sel = path !== null ? path : s.path;
    const eff = sel ?? DEFAULT_PATH;
    s.entries = upsert(s.entries, eff, args);
    if (sel === null) {
      s.path = null;
      s.args = null;
    } else {
      s.path = sel;
      s.args = [...args];
    }
    return;
  }
  if (path !== null) {
    const dev = entryFor(s.entries, path)?.args;
    s.path = path;
    s.args = dev != null ? [...dev] : famDefault(path);
    return;
  }
  // Neither field: preserve (the store guards this upstream).
}

function refAddShell(s: RefState, path: string): void {
  s.entries = upsert(s.entries, path, famDefault(path));
  s.path = path;
  s.args = famDefault(path);
}

function refRemoveShell(s: RefState, path: string): void {
  const before = s.entries.length;
  s.entries = s.entries.filter((e) => e.path !== path);
  const removed = s.entries.length !== before;
  const wasSelected = s.path !== null && s.path === path;
  if (!removed && !wasSelected) return; // no write
  if (wasSelected) {
    s.path = null;
    s.args = null;
  }
}

function refRevertShellArgs(s: RefState, path: string): void {
  const entry = entryFor(s.entries, path);
  if (entry === undefined) return; // no write
  s.entries = s.entries.map((e) =>
    e.path === path ? { path: e.path, args: null } : e,
  );
  if (s.path !== null && s.path === path) {
    s.args = famDefault(path);
  }
}

function refReset(s: RefState): void {
  s.path = null;
  s.args = null;
}

// ------------------------------------------------------------------ //
// Deterministic PRNG (mulberry32) so every seed is reproducible.
// ------------------------------------------------------------------ //
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FAMILY_PATHS = [
  "/bin/zsh",
  "/bin/bash",
  "/usr/bin/fish",
  "/bin/sh",
  "/opt/homebrew/bin/dash",
];
const NON_FAMILY_PATHS = [
  "/bin/cat",
  "/opt/homebrew/bin/nu",
  "/usr/bin/less",
  "/opt/custom/mysh",
];
const PATH_POOL = [...FAMILY_PATHS, ...NON_FAMILY_PATHS];
const ARGS_POOL: (string[] | null)[] = [
  null,
  [],
  ["-i"],
  ["-l"],
  ["-i", "-l"],
  ["-l", "-i"], // reordered default: a deviation (order-sensitive)
  ["-i", "-i"], // duplicate flags
  [""], // empty-string flag
  ["--login"],
  ["-x", "-y"],
];

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

function sortEntries(entries: readonly RefEntry[]): RefEntry[] {
  return [...entries].sort((a, b) => a.path.localeCompare(b.path));
}

// The invariants the contract promises after EVERY write.
function assertInvariants(cfg: CliConfig, entryPathsBefore: Set<string>): void {
  // Mirror: outside pure system default, shell.args === resolved args for path.
  if (!(cfg.shell.path === null && cfg.shell.args === null)) {
    const path = cfg.shell.path ?? DEFAULT_PATH;
    const dev = cfg.shell.entries.find((e) => e.path === path)?.args;
    expect(cfg.shell.args).toEqual(dev ?? famDefault(path));
  }
  // path:null + args:null only in the pure-auto state (there is no other way to
  // reach null/null); trivially satisfied by the schema, but assert consistency
  // with synthesised on the resolve side is covered elsewhere.
  // Canonicalisation: no entry args may be deep-equal to the family default.
  for (const e of cfg.shell.entries) {
    if (e.args !== null) {
      expect(eq(e.args, famDefault(e.path))).toBe(false);
    }
  }
  // Entries are only ever ADDED or kept by non-remove ops; the fuzz checks the
  // remove-only-deletes rule at the call site by diffing against the model.
  void entryPathsBefore;
}

describe("adversarial: property-style op-sequence fuzz vs reference model", () => {
  const SEEDS = Array.from({ length: 30 }, (_, i) => i * 1013 + 7);
  const OPS_PER_SEED = 500;

  it.each(SEEDS)("holds mirror/canonicalisation/resolution invariants (seed %i)", async (seed) => {
    const rng = mulberry32(seed);
    const ref: RefState = { path: null, args: null, entries: [] };

    for (let step = 0; step < OPS_PER_SEED; step++) {
      const before = new Set(ref.entries.map((e) => e.path));
      const opRoll = rng();
      if (opRoll < 0.4) {
        // setShell across all four shapes.
        const shape = rng();
        let path: string | null;
        let args: string[] | null;
        if (shape < 0.3) {
          path = pick(rng, PATH_POOL);
          args = null; // pick a shell
        } else if (shape < 0.55) {
          path = null;
          args = pick(rng, ARGS_POOL.filter((a) => a !== null)) as string[]; // args-only
        } else if (shape < 0.85) {
          path = pick(rng, PATH_POOL);
          args = pick(rng, ARGS_POOL.filter((a) => a !== null)) as string[]; // both
        } else {
          // Degenerate null/null is guarded upstream; skip so we mirror callers.
          path = pick(rng, PATH_POOL);
          args = null;
        }
        refSetShell(ref, path, args);
        await setShell(path, args);
      } else if (opRoll < 0.6) {
        const path = pick(rng, PATH_POOL);
        refAddShell(ref, path);
        await addShell(path);
      } else if (opRoll < 0.78) {
        const path = pick(rng, PATH_POOL);
        refRemoveShell(ref, path);
        await removeShell(path);
      } else if (opRoll < 0.92) {
        const path = pick(rng, PATH_POOL);
        refRevertShellArgs(ref, path);
        await revertShellArgs(path);
      } else {
        refReset(ref);
        await resetShell();
      }

      const cfg = await readCliConfig();
      // 1. Implementation state must match the independent reference model.
      expect({
        path: cfg.shell.path,
        args: cfg.shell.args,
        entries: sortEntries(cfg.shell.entries),
      }).toEqual({
        path: ref.path,
        args: ref.args,
        entries: sortEntries(ref.entries),
      });
      // 2. Contract invariants hold on the persisted config.
      assertInvariants(cfg, before);
    }
  });
});

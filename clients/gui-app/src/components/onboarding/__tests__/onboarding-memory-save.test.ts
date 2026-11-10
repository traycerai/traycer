/**
 * The memory act's save, explored exhaustively against a model of the host
 * (`onboarding-memory-save-world.ts`). No React and no timers: `runMemorySave`
 * is driven directly, so every order of host answers, rebinds and retries up
 * to a depth is run, not just the ones someone thought of.
 *
 * Skip is left out: it sends nothing at this level.
 */
import { describe, expect, it } from "vitest";
import {
  applicableEvents,
  applyWorldEvent,
  cloneWorld,
  eventLabel,
  initialWorld,
  runSave,
  worldKey,
  type Injection,
  type SaveRun,
  type World,
  type WorldEvent,
} from "@/components/onboarding/__tests__/onboarding-memory-save-world";
import {
  traycerStanding,
  type TraycerWriteEvidence,
} from "@/components/onboarding/onboarding-memory-save";

interface Found {
  readonly path: ReadonlyArray<string>;
  count: number;
}

interface State {
  readonly world: World;
  readonly path: ReadonlyArray<string>;
}

function record(
  found: Map<string, Found>,
  run: SaveRun,
  path: ReadonlyArray<string>,
): void {
  for (const violation of run.violations) {
    const known = found.get(violation.cls);
    if (known === undefined)
      found.set(violation.cls, {
        path: [...path, `[requests: ${run.trace.join(" ")}]`],
        count: 1,
      });
    else known.count += 1;
  }
}

/** E1: saves are atomic; every sequence of events up to `depth`, deduplicated. */
async function exploreBetweenSaves(depth: number): Promise<{
  found: Map<string, Found>;
  states: ReadonlyArray<State & { depth: number }>;
  saves: number;
}> {
  const found = new Map<string, Found>();
  const seen = new Set<string>([worldKey(initialWorld())]);
  const all: Array<State & { depth: number }> = [
    { world: initialWorld(), path: [], depth: 0 },
  ];
  let frontier: State[] = [all[0]];
  let saves = 0;
  for (let level = 1; level <= depth; level += 1) {
    const next: State[] = [];
    for (const state of frontier) {
      for (const event of applicableEvents(state.world)) {
        const world = cloneWorld(state.world);
        const path = [...state.path, eventLabel(event)];
        if (event.kind === "save") {
          saves += 1;
          record(found, await runSave(world, null), path);
        } else applyWorldEvent(world, event);
        const key = worldKey(world);
        if (seen.has(key)) continue;
        seen.add(key);
        const reached = { world, path };
        next.push(reached);
        all.push({ ...reached, depth: level });
      }
    }
    frontier = next;
  }
  return { found, states: all, saves };
}

const INJECTIONS: ReadonlyArray<{
  readonly label: string;
  readonly change: WorldEvent | "select-away";
}> = [
  { label: "rebind", change: { kind: "rebind" } },
  { label: "accept", change: { kind: "accept" } },
  { label: "refuse", change: { kind: "refuse" } },
  { label: "overturn", change: { kind: "overturn" } },
  { label: "deliver", change: { kind: "deliver" } },
  { label: "select-away", change: "select-away" },
];

function injectionAt(after: number, index: number): Injection {
  const { label, change } = INJECTIONS[index];
  return {
    after,
    label,
    apply: (world, selection) => {
      if (change === "select-away") selection.selected = false;
      else applyWorldEvent(world, change);
    },
  };
}

/** E2: one save with deferred answers, a change landing after each answer. */
async function exploreInsideSaves(states: ReadonlyArray<State>): Promise<{
  found: Map<string, Found>;
  runs: number;
  exemptWindows: number;
  oneAfterRebind: number;
}> {
  const found = new Map<string, Found>();
  let runs = 0;
  let exemptWindows = 0;
  let oneAfterRebind = 0;
  for (const state of states) {
    const base = await runSave(cloneWorld(state.world), null);
    for (let after = 1; after <= base.requests; after += 1) {
      for (let index = 0; index < INJECTIONS.length; index += 1) {
        const injection = injectionAt(after, index);
        const world = cloneWorld(state.world);
        const run = await runSave(world, injection);
        runs += 1;
        exemptWindows += run.exemptWindows;
        oneAfterRebind += run.oneAfterRebind;
        const path = [
          ...state.path,
          `save, then ${injection.label} after answer ${after}`,
        ];
        record(found, run, path);
        // The retry after a save that was changed under it.
        record(found, await runSave(world, null), [...path, "save (retry)"]);
      }
    }
  }
  return { found, runs, exemptWindows, oneAfterRebind };
}

/**
 * L (reported, never failed): from a reachable state, with the host applying
 * and accepting what it holds, can the act reach "done" within three saves?
 */
async function stuckStates(
  states: ReadonlyArray<State>,
): Promise<ReadonlyArray<State>> {
  const memo = new Map<string, boolean>();
  const reaches = async (world: World, savesLeft: number): Promise<boolean> => {
    if (savesLeft === 0) return false;
    const key = `${savesLeft}|${worldKey(world)}`;
    const known = memo.get(key);
    if (known !== undefined) return known;
    memo.set(key, false);
    const helpers: WorldEvent[] = [
      { kind: "accept" },
      { kind: "deliver" },
      { kind: "mode", mode: "applied" },
    ];
    let reached = false;
    const saved = cloneWorld(world);
    const run = await runSave(saved, null);
    if (run.result === "done") reached = true;
    else {
      for (const next of [{ kind: "save" } as const, ...helpers]) {
        if (reached) break;
        const branch = cloneWorld(next.kind === "save" ? saved : world);
        if (next.kind !== "save") applyWorldEvent(branch, next);
        reached = await reaches(
          branch,
          next.kind === "save" ? savesLeft - 1 : savesLeft,
        );
      }
    }
    memo.set(key, reached);
    return reached;
  };
  const stuck: State[] = [];
  for (const state of states) {
    const start = cloneWorld(state.world);
    start.mode = "applied";
    if (!(await reaches(start, 3))) stuck.push(state);
  }
  return stuck;
}

function describeFound(found: Map<string, Found>): string[] {
  return [...found.entries()].map(
    ([cls, { path, count }]) => `${cls} (x${count}): ${path.join(" > ")}`,
  );
}

describe("the memory act's save, over every order of host events", () => {
  it("keeps its invariants between saves and inside one", async () => {
    const started = performance.now();
    const between = await exploreBetweenSaves(12);
    const betweenMs = performance.now() - started;
    const inside = await exploreInsideSaves(
      between.states.filter((state) => state.depth <= 6),
    );
    const stuck = await stuckStates(
      between.states.filter((state) => state.depth <= 6),
    );
    const total = performance.now() - started;
    const reachable = between.states.filter((state) => state.depth <= 6);
    console.warn(
      [
        `E1: ${between.states.length} states, ${between.saves} saves, ${Math.round(betweenMs)} ms`,
        `E2: ${inside.runs} runs, ${inside.exemptWindows} exempt rebind windows, ${inside.oneAfterRebind} windows with one request after an unseen rebind`,
        `L: ${stuck.length} stuck of ${reachable.length}`,
        `total ${Math.round(total)} ms`,
      ].join("\n"),
    );
    // The walk must reach the places the invariants are about.
    expect(between.states.length).toBeGreaterThan(5000);
    expect(inside.exemptWindows).toBeGreaterThan(0);
    expect(inside.oneAfterRebind).toBeGreaterThan(0);
    // L: from every reachable state the act can still finish.
    expect(stuck.map((state) => state.path.join(" > "))).toEqual([]);
    expect([
      ...describeFound(between.found),
      ...describeFound(inside.found),
    ]).toEqual([]);
  });
});

describe("where Traycer memories stand in the configuration a read names", () => {
  interface StandingCase {
    readonly entry: TraycerWriteEvidence | undefined;
    readonly enabled: boolean;
    readonly revision: number | null;
    readonly standing: string;
  }
  const cases: Record<string, StandingCase> = {
    "no write, read on": {
      entry: undefined,
      enabled: true,
      revision: 3,
      standing: "on",
    },
    "no write, read off": {
      entry: undefined,
      enabled: false,
      revision: 3,
      standing: "off",
    },
    "held write, read on": {
      entry: { kind: "held", uploadId: "u" },
      enabled: true,
      revision: 3,
      standing: "held",
    },
    "written at 5, read on at 4": {
      entry: { kind: "written", revision: 5 },
      enabled: true,
      revision: 4,
      standing: "unconfirmed",
    },
    "written at 5, read off at 4": {
      entry: { kind: "written", revision: 5 },
      enabled: false,
      revision: 4,
      standing: "unconfirmed",
    },
    "written at 5, read on at 5": {
      entry: { kind: "written", revision: 5 },
      enabled: true,
      revision: 5,
      standing: "on",
    },
    "written at 5, read off at 6": {
      entry: { kind: "written", revision: 5 },
      enabled: false,
      revision: 6,
      standing: "overturned",
    },
    "written with no revision, read on": {
      entry: { kind: "written", revision: null },
      enabled: true,
      revision: 9,
      standing: "unconfirmed",
    },
    "written at 5, read with no revision": {
      entry: { kind: "written", revision: 5 },
      enabled: true,
      revision: null,
      standing: "unconfirmed",
    },
    "refused write, read off": {
      entry: { kind: "refused" },
      enabled: false,
      revision: 3,
      standing: "refused",
    },
    "failed write, read off": {
      entry: { kind: "failed" },
      enabled: false,
      revision: 3,
      standing: "failed",
    },
    "failed write, read on": {
      entry: { kind: "failed" },
      enabled: true,
      revision: 3,
      standing: "on",
    },
  };
  it.each(Object.entries(cases))("%s", (_name, each) => {
    expect(
      traycerStanding(
        {
          enabled: each.enabled,
          revision: each.revision,
          environmentId: "env",
        },
        each.entry,
      ),
    ).toBe(each.standing);
  });
});

import { describe, expect, it } from "vitest";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import {
  initialClaimedSandboxEvidence,
  reduceClaimedSandboxEvidence,
  chooseSandboxEvidence,
  TERMINAL_SANDBOX_STATES,
  type ClaimedSandboxEvidence,
  type ClaimedSandboxDecision,
  type ClaimedSandboxEvent,
  type ClaimedSandboxExactOutcome,
  type ClaimedSandboxRow,
} from "@/lib/sandboxes/claimed-sandbox-evidence";

const identity = {
  sandboxId: "sandbox-1",
  hostId: "host-1",
  userId: "user-1",
  teamId: "team-1",
  personalScope: false,
  boundary: 100,
};

type Route = "live" | "unavailable" | "returning";
type RowKind =
  | "awake"
  | "resting"
  | "failed"
  | "destroying"
  | "destroyed"
  | "absent";
type Access = "held" | "exact-lost" | "account-lost" | "fieldless";
type Script = {
  readonly route: Route;
  readonly row: RowKind;
  readonly access: Access;
  readonly wake: boolean;
};
type Reply =
  | { readonly kind: "bootstrap"; readonly order: number }
  | { readonly kind: "list"; readonly order: number }
  | { readonly kind: "exact"; readonly order: number; readonly probe: boolean }
  | { readonly kind: "access"; readonly order: number }
  | {
      readonly kind: "wake";
      readonly order: number;
      readonly boundary: number;
    };
type Search = {
  readonly state: ClaimedSandboxEvidence;
  readonly queue: readonly Reply[];
  readonly nextStamp: number;
  readonly listInFlight: number;
  readonly listsStarted: number;
  readonly bootstrapStarted: boolean;
  readonly exactReads: number;
  readonly accessStarted: boolean;
  readonly wakeStarted: boolean;
  readonly trace: readonly string[];
};

function sandboxRow(
  kind: RowKind,
  order: number,
  source: "exact" | "list",
): ClaimedSandboxRow | null {
  if (kind === "absent") return null;
  const state = kind === "resting" ? "stopped" : kind;
  return {
    row: sandboxSummaryFixture({
      id: identity.sandboxId,
      hostId: identity.hostId,
      state,
    }),
    order,
    source,
    sentAt: 101,
  };
}

function listEvent(
  order: number,
  kind: RowKind,
  bootstrap: boolean,
): ClaimedSandboxEvent {
  const evidence = sandboxRow(kind, order, "list");
  const answer = { order, sentAt: 101, row: evidence?.row ?? null };
  return bootstrap
    ? { kind: "bootstrap-result", answer }
    : { kind: "list-result", answer };
}

function exactOutcome(script: Script): ClaimedSandboxExactOutcome {
  if (script.access === "held")
    return { kind: "not-found", sentAt: 101, holdsTeam: true };
  if (script.access === "exact-lost")
    return { kind: "not-found", sentAt: 101, holdsTeam: false };
  return { kind: "not-found", sentAt: 101, holdsTeam: undefined };
}

function scheduleEvent(script: Script, reply: Reply): ClaimedSandboxEvent {
  switch (reply.kind) {
    case "bootstrap":
      return listEvent(
        reply.order,
        script.route === "returning" ? "absent" : script.row,
        true,
      );
    case "list":
      return listEvent(reply.order, script.row, false);
    case "exact":
      return {
        kind: "exact-result",
        order: reply.order,
        finished: reply.order + 1,
        outcome: exactOutcome(script),
      };
    case "access": {
      let holdsTeam: boolean | undefined;
      if (script.access === "account-lost") holdsTeam = false;
      else if (script.access === "fieldless") holdsTeam = undefined;
      else holdsTeam = true;
      return {
        kind: "access-result",
        dispatched: reply.order,
        holdsTeam,
        finished: reply.order + 1,
      };
    }
    case "wake":
      return {
        kind: "wake-result",
        order: reply.order,
        boundary: reply.boundary,
        awake: script.wake,
      };
  }
}

function decision(state: Search["state"]): ClaimedSandboxDecision {
  return reduceClaimedSandboxEvidence(state, {
    kind: "route",
    live: state.liveRoute,
  });
}

function append(
  search: Search,
  event: ClaimedSandboxEvent,
  label: string,
): Search {
  return {
    ...search,
    state: reduceClaimedSandboxEvidence(search.state, event).state,
    trace: [...search.trace, label],
  };
}

function dispatch(search: Search): Search {
  let next = search;
  let changed = true;
  while (changed) {
    changed = false;
    const current = decision(next.state);
    if (
      current.observeList &&
      next.listInFlight === 0 &&
      next.listsStarted < 2
    ) {
      const order = next.nextStamp;
      next = append(next, { kind: "list-start" }, `list-start#${order}`);
      next = {
        ...next,
        queue: [...next.queue, { kind: "list", order }],
        nextStamp: order + 1,
        listInFlight: order,
        listsStarted: next.listsStarted + 1,
      };
      changed = true;
      continue;
    }
    if (current.read === "bootstrap" && !next.bootstrapStarted) {
      const order = next.nextStamp;
      next = append(
        next,
        { kind: "bootstrap-start" },
        `bootstrap-start#${order}`,
      );
      next = {
        ...next,
        queue: [...next.queue, { kind: "bootstrap", order }],
        nextStamp: order + 1,
        bootstrapStarted: true,
      };
      changed = true;
      continue;
    }
    if (current.read === "exact" && next.exactReads < 2) {
      const order = next.nextStamp;
      const probe = next.state.rest === "access-lost";
      next = append(
        next,
        { kind: "exact-start", request: { order, probe } },
        `exact-start#${order}${probe ? "-probe" : ""}`,
      );
      next = {
        ...next,
        queue: [...next.queue, { kind: "exact", order, probe }],
        nextStamp: order + 1,
        exactReads: next.exactReads + 1,
      };
      changed = true;
      continue;
    }
    if (current.read === "access" && !next.accessStarted) {
      const order = next.nextStamp;
      next = append(next, { kind: "access-start" }, `access-start#${order}`);
      next = {
        ...next,
        queue: [...next.queue, { kind: "access", order }],
        nextStamp: order + 1,
        accessStarted: true,
      };
      changed = true;
    }
  }
  return next;
}

function isPending(state: Search["state"]): boolean {
  return (
    state.exact !== null ||
    state.access === "pending" ||
    state.list === "pending" ||
    state.bootstrap === "pending"
  );
}

function stableSignature(state: Search["state"]): string {
  const current = decision(state);
  const row = current.row;
  return JSON.stringify({
    row: row?.row?.state ?? null,
    passive: current.passive,
    awaitingEvidence: current.awaitingEvidence,
    read: current.read,
    wake: current.wake,
    observeList: current.observeList,
  });
}

function assertNoPendingPermissions(
  currentDecision: ClaimedSandboxDecision,
  trace: readonly string[],
): void {
  const canSend = currentDecision.row?.row?.state === "awake";
  const canRetry = currentDecision.row?.row?.state === "stopped";
  const evidence = currentDecision.row;
  const canEnd =
    evidence !== null &&
    (evidence.row === null || TERMINAL_SANDBOX_STATES.has(evidence.row.state));
  expect([canSend, canRetry, canEnd], trace.join(" → ")).toEqual([
    false,
    false,
    false,
  ]);
}

function expandPendingReplies(current: Search, script: Script): Search[] {
  return current.queue.map((reply, index) => {
    const remaining = current.queue.filter(
      (_, candidate) => candidate !== index,
    );
    const delivered = append(
      {
        ...current,
        queue: remaining,
        listInFlight:
          reply.kind === "list" && current.listInFlight === reply.order
            ? 0
            : current.listInFlight,
      },
      scheduleEvent(script, reply),
      `${reply.kind}-reply#${reply.order}`,
    );
    return delivered;
  });
}

function queueWakeReply(
  current: Search,
  currentDecision: ClaimedSandboxDecision,
): Search | null {
  if (
    current.wakeStarted ||
    currentDecision.row === null ||
    current.state.rest !== "active"
  )
    return null;
  const order = current.nextStamp;
  const boundary = current.state.boundary;
  const started = append(
    current,
    { kind: "wake-start", order, boundary },
    `wake-start#${order}`,
  );
  return {
    ...started,
    queue: [...started.queue, { kind: "wake", order, boundary }],
    nextStamp: order + 1,
    wakeStarted: true,
  };
}

function explore(script: Script): {
  readonly signatures: ReadonlySet<string>;
  readonly witnesses: readonly string[];
} {
  const liveRoute = script.route === "live";
  const state = initialClaimedSandboxEvidence({
    ...identity,
    liveRoute,
    boundary: identity.boundary,
  });
  const start: Search = {
    state,
    queue: [],
    nextStamp: 10,
    listInFlight: 0,
    listsStarted: 0,
    bootstrapStarted: false,
    exactReads: 0,
    accessStarted: false,
    wakeStarted: false,
    trace: [],
  };
  const initial = dispatch(start);
  const returned =
    script.route === "returning"
      ? append(initial, { kind: "route", live: true }, "route-return")
      : initial;
  const queue = [dispatch(returned)];
  const seen = new Set<string>();
  const signatures = new Set<string>();
  const witnesses: string[] = [];
  while (queue.length > 0) {
    const raw = queue.pop();
    if (raw === undefined) continue;
    const current = dispatch(raw);
    const key = JSON.stringify({
      state: current.state,
      queue: current.queue,
      listInFlight: current.listInFlight,
      listsStarted: current.listsStarted,
      bootstrapStarted: current.bootstrapStarted,
      exactReads: current.exactReads,
      accessStarted: current.accessStarted,
      wakeStarted: current.wakeStarted,
    });
    if (seen.has(key)) continue;
    seen.add(key);

    const currentDecision = decision(current.state);
    if (isPending(current.state))
      assertNoPendingPermissions(currentDecision, current.trace);

    if (current.queue.length === 0) {
      expect(currentDecision.read, current.trace.join(" → ")).toBeNull();
      expect(isPending(current.state), current.trace.join(" → ")).toBe(false);
      signatures.add(stableSignature(current.state));
      witnesses.push(current.trace.join(" → "));
      continue;
    }
    queue.push(...expandPendingReplies(current, script));
    const wake = queueWakeReply(current, currentDecision);
    if (wake !== null) queue.push(wake);
  }
  return { signatures, witnesses };
}

describe("claimed sandbox schedules", () => {
  it("chooses admitted evidence by freshness while terminal evidence wins", () => {
    const exactAwake = sandboxRow("awake", 20, "exact");
    const listStopped = sandboxRow("resting", 21, "list");
    const exactEnd = sandboxRow("destroyed", 10, "exact");
    const listAwake = sandboxRow("awake", 30, "list");
    const listEnd = sandboxRow("destroyed", 40, "list");
    const exactMissing: ClaimedSandboxRow = {
      row: null,
      order: 15,
      sentAt: 101,
      source: "exact",
    };

    expect(chooseSandboxEvidence(null, null)).toBeNull();
    expect(chooseSandboxEvidence(exactAwake, listStopped)).toBe(listStopped);
    expect(chooseSandboxEvidence(exactEnd, listAwake)).toBe(exactEnd);
    expect(chooseSandboxEvidence(exactMissing, listAwake)).toBe(exactMissing);
    expect(chooseSandboxEvidence(exactAwake, listEnd)).toBe(listEnd);
  });

  it.each(scheduleCases())(
    "explores outstanding reply orders for %s/%s/%s/wake=%s",
    (route, row, accessState, wake) => {
      const script: Script = { route, row, access: accessState, wake };
      const result = explore(script);
      const label = `${route}/${row}/${accessState}/wake=${wake}`;
      expect(
        result.signatures.size,
        `${label}: ${result.witnesses.join("; ")}`,
      ).toBe(1);
      const only = [...result.signatures][0];
      expect(only).toBeDefined();
      if (row === "failed" || row === "destroying" || row === "destroyed")
        expect(only).toContain(`"row":"${row}"`);
      assertScriptedAccessOutcome(script, only, result.witnesses, label);
    },
  );

  it("keeps startup omission from erasing overlapping terminal list evidence", () => {
    const script: Script = {
      route: "returning",
      row: "destroyed",
      access: "held",
      wake: false,
    };
    const { signatures, witnesses } = explore(script);
    expect(signatures.size, witnesses.join("; ")).toBe(1);
    expect([...signatures][0]).toContain('"row":"destroyed"');
  });

  it("keeps an exact End decision over a later awake shared-list result", () => {
    const state = initialClaimedSandboxEvidence({
      ...identity,
      liveRoute: true,
      boundary: identity.boundary,
    });
    let current = reduceClaimedSandboxEvidence(state, {
      kind: "exact-start",
      request: { order: 10, probe: false },
    }).state;
    current = reduceClaimedSandboxEvidence(current, {
      kind: "list-start",
    }).state;
    current = reduceClaimedSandboxEvidence(current, {
      kind: "exact-result",
      order: 10,
      finished: 11,
      outcome: { kind: "not-found", sentAt: 101, holdsTeam: true },
    }).state;
    current = reduceClaimedSandboxEvidence(current, {
      kind: "list-result",
      answer: {
        order: 12,
        sentAt: 101,
        row: sandboxRow("awake", 12, "list")?.row ?? null,
      },
    }).state;
    expect(decision(current).row).toMatchObject({ row: null, source: "exact" });
  });

  it.each([
    ["exact first", ["exact", "list"]],
    ["list first", ["list", "exact"]],
  ] as const)(
    "admits the newer shared row as staged fallback after an inconclusive exact read, %s",
    (_label, order) => {
      const state = initialClaimedSandboxEvidence({
        ...identity,
        liveRoute: true,
        boundary: identity.boundary,
      });
      let current = reduceClaimedSandboxEvidence(state, {
        kind: "exact-start",
        request: { order: 10, probe: false },
      }).state;
      current = reduceClaimedSandboxEvidence(current, {
        kind: "list-start",
      }).state;
      const trace = ["exact-start#10", "list-start"];
      for (const reply of order) {
        if (reply === "exact") {
          current = reduceClaimedSandboxEvidence(current, {
            kind: "exact-result",
            order: 10,
            finished: 11,
            outcome: { kind: "inconclusive" },
          }).state;
          trace.push("exact-inconclusive#10");
        } else {
          current = reduceClaimedSandboxEvidence(current, {
            kind: "list-result",
            answer: {
              order: 12,
              sentAt: 101,
              row: sandboxRow("awake", 12, "list")?.row ?? null,
            },
          }).state;
          trace.push("shared-awake#12");
        }
      }
      expect(decision(current).row, trace.join(" → ")).toMatchObject({
        row: { state: "awake" },
        source: "list",
        order: 12,
      });
    },
  );

  it.each(terminalOverlapCases())(
    "keeps exact %s terminal evidence over a newer awake shared reply through both overlaps (wake=%s)",
    (terminal, withWake, order) => {
      const result = runTerminalOverlap(terminal, withWake, order);
      expect(result.row, result.trace.join(" → ")).toMatchObject({
        row: { state: terminal },
        source: "exact",
      });
    },
  );
});

type OverlapReply = "exact" | "list" | "wake";
type OverlapOrder = readonly OverlapReply[];
type TerminalRowKind = "failed" | "destroying" | "destroyed";

function terminalOverlapCases(): ReadonlyArray<
  readonly [TerminalRowKind, boolean, OverlapOrder]
> {
  const terminalRows: readonly TerminalRowKind[] = [
    "failed",
    "destroying",
    "destroyed",
  ];
  const noWakeOrders: readonly OverlapOrder[] = [
    ["exact", "list"],
    ["list", "exact"],
  ];
  const wakeOrders: readonly OverlapOrder[] = [
    ["exact", "list", "wake"],
    ["exact", "wake", "list"],
    ["list", "exact", "wake"],
    ["list", "wake", "exact"],
    ["wake", "exact", "list"],
    ["wake", "list", "exact"],
  ];
  return terminalRows.flatMap((terminal) => [
    ...noWakeOrders.map((order) => [terminal, false, order] as const),
    ...wakeOrders.map((order) => [terminal, true, order] as const),
  ]);
}

function runTerminalOverlap(
  terminal: TerminalRowKind,
  withWake: boolean,
  order: OverlapOrder,
): {
  readonly row: ClaimedSandboxRow | null;
  readonly trace: readonly string[];
} {
  const initial = initialClaimedSandboxEvidence({
    ...identity,
    liveRoute: true,
    boundary: identity.boundary,
  });
  const initialRow = sandboxRow("awake", 5, "list");
  if (initialRow === null) throw new Error("awake fixture has no row");
  let current = reduceClaimedSandboxEvidence(initial, {
    kind: "list-result",
    answer: { order: 5, sentAt: 101, row: initialRow.row },
  }).state;
  current = reduceClaimedSandboxEvidence(current, {
    kind: "exact-start",
    request: { order: 10, probe: false },
  }).state;
  if (withWake)
    current = reduceClaimedSandboxEvidence(current, {
      kind: "wake-start",
      order: 11,
      boundary: identity.boundary,
    }).state;
  current = reduceClaimedSandboxEvidence(current, { kind: "list-start" }).state;
  const trace = [
    "initial-awake-list#5",
    "exact-start#10",
    ...(withWake ? ["wake-start#11"] : []),
    "list-start#12",
  ];
  for (const reply of order) {
    current = applyOverlapReply(current, terminal, reply);
    trace.push(`${reply}-reply`);
    if (isPending(current))
      assertNoPendingPermissions(decision(current), trace);
  }
  return { row: decision(current).row, trace };
}

function applyOverlapReply(
  state: ClaimedSandboxEvidence,
  terminal: TerminalRowKind,
  reply: OverlapReply,
): ClaimedSandboxEvidence {
  switch (reply) {
    case "exact": {
      const evidence = sandboxRow(terminal, 10, "exact");
      if (evidence === null) throw new Error("terminal fixture has no row");
      return reduceClaimedSandboxEvidence(state, {
        kind: "exact-result",
        order: 10,
        finished: 13,
        outcome: { kind: "row", row: evidence },
      }).state;
    }
    case "list":
      return reduceClaimedSandboxEvidence(state, {
        kind: "list-result",
        answer: {
          order: 12,
          sentAt: 101,
          row: sandboxRow("awake", 12, "list")?.row ?? null,
        },
      }).state;
    case "wake":
      return reduceClaimedSandboxEvidence(state, {
        kind: "wake-result",
        order: 11,
        boundary: identity.boundary,
        awake: true,
      }).state;
  }
}

function scheduleCases(): readonly [Route, RowKind, Access, boolean][] {
  const routes: readonly Route[] = ["live", "unavailable", "returning"];
  const rows: readonly RowKind[] = [
    "awake",
    "resting",
    "failed",
    "destroying",
    "destroyed",
    "absent",
  ];
  const access: readonly Access[] = [
    "held",
    "exact-lost",
    "account-lost",
    "fieldless",
  ];
  return routes.flatMap((route) =>
    rows.flatMap((row) =>
      access.flatMap((accessState) =>
        [false, true].map((wake) => [route, row, accessState, wake] as const),
      ),
    ),
  );
}

function assertScriptedAccessOutcome(
  script: Script,
  signature: string | undefined,
  witnesses: readonly string[],
  label: string,
): void {
  // Existing list evidence bypasses the exact read and its scripted access reply.
  if (script.row !== "absent") return;
  if (script.access === "held")
    expect(signature, label).toContain('"row":null');
  if (script.access === "exact-lost" || script.access === "account-lost")
    expect(signature, label).toContain('"passive":true');
  if (script.access === "fieldless")
    expect(signature, label).toContain('"passive":true');
  if (script.access === "account-lost" || script.access === "fieldless")
    expect(
      witnesses.every((witness) => witness.includes("access-reply#")),
      label,
    ).toBe(true);
}

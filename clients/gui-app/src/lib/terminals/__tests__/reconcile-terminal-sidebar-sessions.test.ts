import { describe, expect, it } from "vitest";
import type { PlainTerminalProjection } from "@traycer/protocol/host/terminal/plain-schemas";
import {
  deletePlainTerminal,
  replacePlainTerminalState,
  settlePlainTerminalSnapshot,
} from "@/lib/terminals/plain-terminal-authority";
import {
  reconcileTerminalSidebarSessions,
  type ListedTerminalSidebarSession,
  type ReconcileTerminalSidebarSessionsResult,
} from "@/lib/terminals/reconcile-terminal-sidebar-sessions";

const EPIC_ID = "epic-1";
const HOST_A = "host-a";
const HOST_B = "host-b";
const SHARED_ID = "shared-term";

function listedSession(
  sessionId: string,
  over: Partial<ListedTerminalSidebarSession>,
): ListedTerminalSidebarSession {
  return {
    sessionId,
    scope: { kind: "epic", epicId: EPIC_ID },
    sessionKind: "terminal",
    cwd: "/tmp/work",
    shellCommand: "/bin/zsh",
    shellArgs: [],
    cols: 80,
    rows: 24,
    status: "running",
    exitCode: null,
    createdAt: 1,
    title: sessionId,
    ...over,
  };
}

function durableTerminal(
  hostId: string,
  terminalId: string,
  runtime: "running" | "dormant",
): PlainTerminalProjection {
  return {
    record: {
      terminalId,
      hostId,
      scope: { kind: "epic", epicId: EPIC_ID },
      launch: {
        cwd: "/tmp/work",
        shellCommand: "/bin/zsh",
        shellArgs: [],
      },
      manualTitle: `${hostId}:${terminalId}`,
      revision: 1,
      createdAt: "2026-08-17T10:00:00.000Z",
      updatedAt: "2026-08-17T10:00:00.000Z",
    },
    runtime:
      runtime === "dormant"
        ? { status: "dormant" }
        : {
            status: "running",
            sessionId: terminalId,
            currentCwd: "/tmp/work",
            activeProcessName: null,
            cols: 80,
            rows: 24,
          },
  };
}

function completeFleet(terminals: readonly PlainTerminalProjection[]) {
  return settlePlainTerminalSnapshot(
    replacePlainTerminalState(undefined, {
      coverage: "complete-fleet",
      scope: { kind: "epic", epicId: EPIC_ID },
      terminals: [...terminals],
    }),
  );
}

function partialServing(
  servingHostId: string,
  terminals: readonly PlainTerminalProjection[],
) {
  return settlePlainTerminalSnapshot(
    replacePlainTerminalState(undefined, {
      coverage: "partial-serving-host",
      servingHostId,
      scope: { kind: "epic", epicId: EPIC_ID },
      terminals: [...terminals],
    }),
  );
}

function rowIds(
  result: ReconcileTerminalSidebarSessionsResult,
): readonly string[] {
  return result.rows.map((row) => `${row.hostId}:${row.session.sessionId}`);
}

describe("reconcileTerminalSidebarSessions", () => {
  it("unions durable rows from two v2 hosts without duplicates", () => {
    const result = reconcileTerminalSidebarSessions({
      epicId: EPIC_ID,
      servingHostId: HOST_A,
      capability: "capable",
      coverage: "complete-fleet",
      listed: [listedSession(SHARED_ID, { lifecycleOwner: "registry" })],
      durableCollection: completeFleet([
        durableTerminal(HOST_A, SHARED_ID, "running"),
        durableTerminal(HOST_B, SHARED_ID, "running"),
      ]),
    });
    expect(rowIds(result)).toEqual([
      `${HOST_A}:${SHARED_ID}`,
      `${HOST_B}:${SHARED_ID}`,
    ]);
    expect(result.rows.every((row) => row.durable)).toBe(true);
    expect(result.incompleteFleet).toBe(false);
  });

  it("suppresses a v2 terminal's listed shadow while present", () => {
    const result = reconcileTerminalSidebarSessions({
      epicId: EPIC_ID,
      servingHostId: HOST_A,
      capability: "capable",
      coverage: "complete-fleet",
      listed: [
        listedSession("term-a", { lifecycleOwner: "registry" }),
        listedSession("shadow", { lifecycleOwner: "registry" }),
      ],
      durableCollection: completeFleet([
        durableTerminal(HOST_A, "shadow", "running"),
      ]),
    });
    expect(rowIds(result)).toEqual([`${HOST_A}:shadow`]);
    expect(result.rows[0]?.durable).toBe(true);
  });

  it("does not let a stale listed cache resurrect a deleted durable terminal", () => {
    const collection = deletePlainTerminal(
      completeFleet([durableTerminal(HOST_A, "gone", "running")]),
      { hostId: HOST_A, terminalId: "gone" },
      2,
    );
    const result = reconcileTerminalSidebarSessions({
      epicId: EPIC_ID,
      servingHostId: HOST_A,
      capability: "capable",
      coverage: "complete-fleet",
      listed: [listedSession("gone", { lifecycleOwner: "registry" })],
      durableCollection: collection,
    });
    expect(result.rows).toEqual([]);
  });

  it("retains manager-owned setup and provider-login list rows on a v2 host", () => {
    const result = reconcileTerminalSidebarSessions({
      epicId: EPIC_ID,
      servingHostId: HOST_A,
      capability: "capable",
      coverage: "complete-fleet",
      listed: [
        listedSession("setup-term", { lifecycleOwner: "manager" }),
        listedSession("login-term", { lifecycleOwner: "manager" }),
        listedSession("ordinary-shadow", { lifecycleOwner: "registry" }),
      ],
      durableCollection: completeFleet([
        durableTerminal(HOST_A, "durable", "running"),
      ]),
    });
    expect(rowIds(result)).toEqual([
      `${HOST_A}:setup-term`,
      `${HOST_A}:login-term`,
      `${HOST_A}:durable`,
    ]);
    expect(result.rows.map((row) => row.durable)).toEqual([false, false, true]);
  });

  it("uses the full listed compatibility view on a genuinely older host", () => {
    const result = reconcileTerminalSidebarSessions({
      epicId: EPIC_ID,
      servingHostId: HOST_A,
      capability: "legacy",
      coverage: null,
      listed: [listedSession("legacy-a", {}), listedSession("legacy-b", {})],
      durableCollection: completeFleet([
        durableTerminal(HOST_B, SHARED_ID, "running"),
      ]),
    });
    expect(rowIds(result)).toEqual([
      `${HOST_A}:legacy-a`,
      `${HOST_A}:legacy-b`,
    ]);
    expect(result.rows.every((row) => !row.durable)).toBe(true);
    expect(result.incompleteFleet).toBe(false);
  });

  it("drops remote durable rows in partial coverage and marks the fleet incomplete", () => {
    const complete = completeFleet([
      durableTerminal(HOST_A, "local", "running"),
      durableTerminal(HOST_B, "remote", "running"),
    ]);
    const partial = partialServing(HOST_A, [
      durableTerminal(HOST_A, "local", "running"),
    ]);
    const recovered = completeFleet([
      durableTerminal(HOST_A, "local", "running"),
      durableTerminal(HOST_B, "remote-restored", "running"),
    ]);
    const listed = [listedSession("setup-term", { lifecycleOwner: "manager" })];

    const duringOutage = reconcileTerminalSidebarSessions({
      epicId: EPIC_ID,
      servingHostId: HOST_A,
      capability: "capable",
      coverage: "partial-serving-host",
      listed,
      durableCollection: partial,
    });
    expect(duringOutage.incompleteFleet).toBe(true);
    expect(rowIds(duringOutage)).toEqual([
      `${HOST_A}:setup-term`,
      `${HOST_A}:local`,
    ]);
    expect(rowIds(duringOutage)).not.toContain(`${HOST_B}:remote`);

    const before = reconcileTerminalSidebarSessions({
      epicId: EPIC_ID,
      servingHostId: HOST_A,
      capability: "capable",
      coverage: "complete-fleet",
      listed,
      durableCollection: complete,
    });
    expect(rowIds(before)).toContain(`${HOST_B}:remote`);

    const after = reconcileTerminalSidebarSessions({
      epicId: EPIC_ID,
      servingHostId: HOST_A,
      capability: "capable",
      coverage: "complete-fleet",
      listed,
      durableCollection: recovered,
    });
    expect(after.incompleteFleet).toBe(false);
    expect(rowIds(after)).toEqual([
      `${HOST_A}:setup-term`,
      `${HOST_A}:local`,
      `${HOST_B}:remote-restored`,
    ]);
  });

  it("keeps dormant persistent terminals visible", () => {
    const result = reconcileTerminalSidebarSessions({
      epicId: EPIC_ID,
      servingHostId: HOST_A,
      capability: "capable",
      coverage: "complete-fleet",
      listed: [],
      durableCollection: completeFleet([
        durableTerminal(HOST_A, "sleeping", "dormant"),
      ]),
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.runtimeStatus).toBe("dormant");
    expect(result.rows[0]?.durable).toBe(true);
  });

  it("emits no rows while capability is unknown, even with a cached list", () => {
    const result = reconcileTerminalSidebarSessions({
      epicId: EPIC_ID,
      servingHostId: HOST_A,
      capability: "unknown",
      coverage: null,
      listed: [
        listedSession("cached", { lifecycleOwner: "manager" }),
        listedSession("shadow", { lifecycleOwner: "registry" }),
      ],
      durableCollection: completeFleet([
        durableTerminal(HOST_A, "durable", "running"),
      ]),
    });
    expect(result.rows).toEqual([]);
    expect(result.incompleteFleet).toBe(false);
  });

  it("fail-closes missing or registry origin on a capable host", () => {
    const result = reconcileTerminalSidebarSessions({
      epicId: EPIC_ID,
      servingHostId: HOST_A,
      capability: "capable",
      coverage: "complete-fleet",
      listed: [
        listedSession("fresh-client-missing", {}),
        listedSession("tagged-shadow", { lifecycleOwner: "registry" }),
        listedSession("kept-manager", { lifecycleOwner: "manager" }),
      ],
      durableCollection: completeFleet([]),
    });
    expect(rowIds(result)).toEqual([`${HOST_A}:kept-manager`]);
  });

  it("retains more than 32 manager rows and exact adversarial identities", () => {
    const adversarial = [
      "host:a",
      "a:b",
      'quote"id',
      "slash\\id",
      "nul\u0000id",
    ];
    const managerIds = [
      ...Array.from({ length: 33 }, (_, index) => `mgr-${index}`),
      ...adversarial,
    ];
    const result = reconcileTerminalSidebarSessions({
      epicId: EPIC_ID,
      servingHostId: HOST_A,
      capability: "capable",
      coverage: "complete-fleet",
      listed: managerIds.map((sessionId) =>
        listedSession(sessionId, { lifecycleOwner: "manager" }),
      ),
      durableCollection: completeFleet([]),
    });
    expect(rowIds(result)).toEqual(
      managerIds.map((sessionId) => `${HOST_A}:${sessionId}`),
    );
  });
});

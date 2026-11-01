import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  remoteEntry,
  sandboxFacts,
} from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import type { TaskSandboxHost } from "@/hooks/epic/use-task-sandbox-end";
import type { SandboxConfigurations } from "@/hooks/sandboxes/use-sandbox-configurations";
import {
  sandboxOperationFixture,
  sandboxSummaryFixture,
} from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import { resolveChatSandbox } from "@/lib/sandboxes/chat-sandbox-state";
import { useSandboxWakeReportStore } from "@/stores/sandboxes/sandbox-wake-report-store";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * The classification a chat's footer and send path read, over the real hook.
 * Only its data sources are replaced: the task's projected hosts, the viewer's
 * sandbox list and configurations, and the host directory row.
 */

const NOW = Date.UTC(2026, 9, 27, 12, 0);

const sources = vi.hoisted(
  (): {
    task: TaskSandboxHost;
    /** `null`: the list read failed, or is disabled, with nothing cached. */
    sandboxes: SandboxSummary[] | null;
    configurations: SandboxConfigurations;
    entry: HostDirectoryEntry | null;
    /** Whether the relay holds a ready session to the host. */
    readySession: boolean;
  } => ({
    task: { kind: "other" },
    sandboxes: [],
    configurations: {
      configurations: [{ kind: "personal" }],
      teamEnvironmentIds: new Set(),
      complete: true,
    },
    entry: null,
    readySession: false,
  }),
);

vi.mock("@/hooks/epic/use-task-sandbox-end", () => ({
  useTaskSandboxHost: () => sources.task,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-list-query", () => ({
  useSandboxList: () => ({
    data:
      sources.sandboxes === null ? undefined : { sandboxes: sources.sandboxes },
  }),
}));
vi.mock(
  "@/hooks/sandboxes/use-sandbox-configurations",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/sandboxes/use-sandbox-configurations")
    >()),
    useSandboxConfigurations: () => sources.configurations,
  }),
);
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => sources.entry,
}));
vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useRemoteSessionPollReadiness: () => sources.readySession,
}));

import { useChatSandboxState } from "@/hooks/sandboxes/use-chat-sandbox-state";

const HOST = "host-sbx";
const VIEWER = "viewer-1";
const OTHER = "member-other";
const TEAM_ENV = "env-acme";

function row(overrides: Partial<SandboxSummary>): SandboxSummary {
  return sandboxSummaryFixture({
    id: "sbx-1",
    hostId: HOST,
    displayName: "e2e-sbx",
    ...overrides,
  });
}

function stateOf(reachable: boolean) {
  return renderHook(() => useChatSandboxState("epic-1", HOST, reachable)).result
    .current;
}

beforeEach(() => {
  sources.task = { kind: "other" };
  sources.sandboxes = [];
  sources.configurations = {
    configurations: [
      { kind: "personal" },
      {
        kind: "team",
        teamId: "team-a",
        teamName: "Acme",
        environmentId: TEAM_ENV,
      },
    ],
    teamEnvironmentIds: new Set([TEAM_ENV]),
    complete: true,
  };
  sources.entry = null;
  sources.readySession = false;
  useSandboxWakeReportStore.setState({ answeredWakes: {} });
  useAuthStore.setState({
    status: "signed-in",
    profile: { userId: VIEWER, userName: "V", email: "v@example.com" },
    contextMetadata: { userId: VIEWER, username: "V" },
  });
});

afterEach(() => {
  cleanup();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});

describe("useChatSandboxState", () => {
  it("lets the task's projected end win over a stale listed row", () => {
    const ended = {
      name: "e2e-sbx",
      end: {
        state: "destroyed",
        destroyedAt: Date.UTC(2026, 9, 27, 6, 21),
        cause: "resting",
        actor: null,
        idleMinutes: null,
      },
    } as const;
    sources.task = { kind: "ended", ended };
    sources.sandboxes = [row({ state: "suspended" })];

    expect(stateOf(false)).toEqual({ kind: "destroyed", ended });
  });

  it.each(["suspended", "stopped"] as const)(
    "reads a %s sandbox as resting, with the configuration it was found under",
    (state) => {
      const sandbox = row({ state, environmentId: TEAM_ENV });
      sources.sandboxes = [sandbox];

      const result = stateOf(false);

      expect(result).toMatchObject({
        kind: "resting",
        sandbox,
        configuration: { kind: "team", teamName: "Acme" },
      });
    },
  );

  it("reads a frozen sandbox as resting, and a personal one under Personal", () => {
    sources.sandboxes = [row({ state: "awake", frozen: true })];

    expect(stateOf(true)).toMatchObject({
      kind: "resting",
      configuration: { kind: "personal" },
    });
  });

  it("keeps a resting team sandbox resting before its configuration resolves, changing no payer", () => {
    const sandbox = row({
      state: "suspended",
      environmentId: "env-elsewhere",
      createdBy: { userId: OTHER, displayName: "Other" },
      wakePayer: { userId: OTHER, displayName: "Other" },
    });
    sources.sandboxes = [sandbox];

    expect(stateOf(false)).toEqual({
      kind: "resting",
      sandbox,
      configuration: null,
      wakeChangesPayer: false,
    });
  });

  it.each([
    ["failed", { kind: "failed" }],
    ["released", { kind: "released" }],
    ["destroyed", { kind: "moving", state: "destroying" }],
  ] as const)(
    "reads a listed %s sandbox by its own state, never as unknown",
    (state, expected) => {
      const sandbox = row({ state });
      sources.sandboxes = [sandbox];

      expect(stateOf(false)).toEqual({ ...expected, sandbox });
    },
  );

  it.each([
    "creating",
    "resuming",
    "starting",
    "suspending",
    "stopping",
    "destroying",
  ] as const)(
    "reads a %s sandbox as moving, with its row, never as unknown or not a sandbox",
    (state) => {
      const sandbox = row({ state });
      sources.sandboxes = [sandbox];

      expect(stateOf(false)).toEqual({ kind: "moving", sandbox, state });
    },
  );

  it("reads an unlisted host the task names as a sandbox as pending, by the task's name", () => {
    sources.task = { kind: "sandbox", name: "e2e-sbx-p1" };

    expect(stateOf(false)).toEqual({ kind: "pending", name: "e2e-sbx-p1" });
  });

  it("reads an unlisted host the directory knows as a sandbox as pending, by its directory label", () => {
    sources.entry = remoteEntry(HOST, sandboxFacts(null));

    expect(stateOf(false)).toEqual({ kind: "pending", name: `label-${HOST}` });
  });

  it("reads a host nothing names as a sandbox as not one, even when the list read failed", () => {
    expect(stateOf(false)).toEqual({ kind: "none" });

    sources.sandboxes = null;
    expect(stateOf(false)).toEqual({ kind: "none" });
  });

  it("reads a host the directory knows as a person's as not a sandbox, without waiting on the task", () => {
    sources.sandboxes = null;
    sources.entry = remoteEntry(HOST, null);

    expect(stateOf(false)).toEqual({ kind: "none" });
  });

  it("reads an awake sandbox the transport cannot reach as unreachable, with when its host last reported", () => {
    sources.sandboxes = [
      row({
        state: "awake",
        lastActivityAt: NOW - 7 * 60_000 - 20_000,
      }),
    ];
    sources.entry = remoteEntry(HOST, null);

    expect(stateOf(false)).toMatchObject({
      kind: "unreachable",
      lastContactAt: NOW - 7 * 60_000 - 20_000,
    });
  });

  it("says no last contact when the host answered but never reported, whatever the directory last saw", () => {
    sources.sandboxes = [row({ state: "awake" })];
    const base = remoteEntry(HOST, null);
    const seen: RemoteHostDirectoryEntry = {
      ...base,
      remoteStatus: {
        ...base.remoteStatus,
        lastSeenAt: new Date(NOW - 7 * 60_000 - 20_000).toISOString(),
      },
    };
    sources.entry = seen;
    // A session this device saw answer: the first-hand word that ends the wait.
    sources.readySession = true;
    const transport = { reachable: true };
    const view = renderHook(() =>
      useChatSandboxState("epic-1", HOST, transport.reachable),
    );
    expect(view.result.current).toEqual({ kind: "none" });

    sources.readySession = false;
    transport.reachable = false;
    view.rerender();

    expect(view.result.current).toMatchObject({
      kind: "unreachable",
      lastContactAt: null,
    });
  });

  it("says a team wake changes the payer only when another member paid for the last wake", () => {
    const resting = (wakePayer: SandboxSummary["wakePayer"]) =>
      row({ state: "suspended", environmentId: TEAM_ENV, wakePayer });

    sources.sandboxes = [resting({ userId: OTHER, displayName: "Other" })];
    expect(stateOf(false)).toMatchObject({ wakeChangesPayer: true });

    sources.sandboxes = [resting({ userId: VIEWER, displayName: "V" })];
    expect(stateOf(false)).toMatchObject({ wakeChangesPayer: false });

    sources.sandboxes = [resting(null)];
    expect(stateOf(false)).toMatchObject({ wakeChangesPayer: false });
  });

  it("never says a personal sandbox changes the payer, whoever the row names", () => {
    sources.sandboxes = [
      row({
        state: "suspended",
        wakePayer: { userId: OTHER, displayName: "Other" },
      }),
    ];

    expect(stateOf(false)).toMatchObject({
      kind: "resting",
      configuration: { kind: "personal" },
      wakeChangesPayer: false,
    });
  });
});

describe("an awake sandbox until its host first reports", () => {
  const WAKE = 1_791_000_010_000;
  const offline = (lastSeenAt: number | null): RemoteHostDirectoryEntry => {
    const base = remoteEntry(HOST, null);
    return {
      ...base,
      remoteStatus: {
        ...base.remoteStatus,
        connectivity: "offline",
        lastSeenAt:
          lastSeenAt === null ? null : new Date(lastSeenAt).toISOString(),
      },
    };
  };
  const resumed = (overrides: Partial<SandboxSummary>): SandboxSummary =>
    row({
      state: "awake",
      lastTransitionAt: WAKE,
      operation: sandboxOperationFixture({
        fromState: "suspended",
        state: "awake",
        cause: "wake",
      }),
      ...overrides,
    });

  /** The chat's view of the row, kept mounted across list and directory moves. */
  function mountChat(transport: { reachable: boolean }) {
    const view = renderHook(() => {
      const state = useChatSandboxState("epic-1", HOST, transport.reachable);
      return {
        state,
        view: resolveChatSandbox(state, {
          reachable: transport.reachable,
          canEdit: true,
          ownedByViewer: true,
          environmentOwned: false,
        }),
      };
    });
    return view;
  }

  it("reads Resuming · pending, not unreachable, with no sign the host ever reported", () => {
    sources.sandboxes = [resumed({})];
    sources.entry = offline(null);

    const { result } = mountChat({ reachable: false });

    expect(result.current.state).toMatchObject({
      kind: "moving",
      state: "resuming",
    });
    expect(result.current.view.composer.kind).toBe("line");
    expect(result.current.view.line).toMatchObject({
      place: "slot",
      text: "Resuming e2e-sbx · pending",
    });
  });

  it.each([
    [
      "a Start",
      sandboxOperationFixture({
        fromState: "stopped",
        state: "awake",
        cause: "wake",
      }),
    ],
    ["a first create", null],
  ] as const)("reads Starting · pending after %s", (_name, operation) => {
    sources.sandboxes = [resumed({ operation })];
    sources.entry = offline(null);

    const { result } = mountChat({ reachable: false });

    expect(result.current.state).toMatchObject({
      kind: "moving",
      state: "starting",
    });
    expect(result.current.view.line?.text).toBe("Starting e2e-sbx · pending");
  });

  it("keeps the move it watched when the row turns awake with no operation", () => {
    sources.sandboxes = [row({ state: "resuming", lastTransitionAt: WAKE })];
    sources.entry = offline(null);
    const { result, rerender } = mountChat({ reachable: false });
    expect(result.current.view.line?.text).toBe("Resuming e2e-sbx · pending");

    sources.sandboxes = [
      row({ state: "awake", lastTransitionAt: WAKE + 1, operation: null }),
    ];
    rerender();

    expect(result.current.state).toMatchObject({
      kind: "moving",
      state: "resuming",
    });
    expect(result.current.view.line?.text).toBe("Resuming e2e-sbx · pending");
  });

  it("reads can't connect when the host answered in this wake and then stopped", () => {
    sources.sandboxes = [resumed({})];
    sources.entry = offline(null);
    sources.readySession = true;
    const transport = { reachable: true };
    const { result, rerender } = mountChat(transport);
    expect(result.current.state).toMatchObject({ kind: "none" });

    sources.readySession = false;
    transport.reachable = false;
    rerender();

    expect(result.current.state).toMatchObject({ kind: "unreachable" });
    expect(result.current.view.line?.text).toBe(
      "e2e-sbx is running, but Traycer can’t connect",
    );
  });

  it("forgets the previous wake's answer when the row wakes again", () => {
    sources.sandboxes = [resumed({})];
    sources.entry = offline(null);
    sources.readySession = true;
    const transport = { reachable: true };
    const { result, rerender } = mountChat(transport);
    sources.readySession = false;
    transport.reachable = false;
    rerender();
    expect(result.current.state.kind).toBe("unreachable");

    sources.sandboxes = [
      resumed({
        lastTransitionAt: WAKE + 60_000,
        operation: sandboxOperationFixture({
          at: WAKE + 60_000,
          fromState: "suspended",
          state: "awake",
          cause: "wake",
        }),
      }),
    ];
    rerender();

    expect(result.current.state).toMatchObject({
      kind: "moving",
      state: "resuming",
    });
  });

  describe("on a device that never watched the wake", () => {
    it("reads unreachable when the host reported activity after the wake", () => {
      sources.sandboxes = [resumed({ lastActivityAt: WAKE + 1 })];
      sources.entry = offline(null);

      expect(
        mountChat({ reachable: false }).result.current.state,
      ).toMatchObject({ kind: "unreachable", lastContactAt: WAKE + 1 });
    });

    it.each([
      ["no report at all", {}],
      ["only a report from before the wake", { lastActivityAt: WAKE - 1 }],
    ] as const)(
      "waits on %s, a later directory sighting changing nothing",
      (_name, overrides) => {
        sources.sandboxes = [resumed(overrides)];
        sources.entry = offline(WAKE + 60_000);

        expect(
          mountChat({ reachable: false }).result.current.state,
        ).toMatchObject({
          kind: "moving",
          state: "resuming",
        });
      },
    );
  });

  it.each([
    ["a failed guest configuration", { guestConfigured: false }, "unreachable"],
    ["a frozen sandbox", { frozen: true }, "resting"],
    ["an Automations pod", { kind: "automation" }, "unreachable"],
  ] as const)("never waits for %s", (_name, overrides, kind) => {
    sources.sandboxes = [resumed(overrides)];
    sources.entry = offline(null);

    expect(mountChat({ reachable: false }).result.current.state.kind).toBe(
      kind,
    );
  });
});

describe("an awake wait across wake identity, rollback and surfaces", () => {
  const WAKE = 1_791_000_010_000;
  const woke = (overrides: Partial<SandboxSummary>): SandboxSummary =>
    row({
      state: "awake",
      lastTransitionAt: WAKE,
      lastActivityAt: WAKE,
      operation: sandboxOperationFixture({
        at: WAKE,
        fromState: "suspended",
        state: "awake",
        cause: "wake",
      }),
      ...overrides,
    });
  const view = (transport: { reachable: boolean }) =>
    renderHook(() => useChatSandboxState("epic-1", HOST, transport.reachable));

  it("preserves a witnessed answer through an aborted busy suspend", () => {
    const rollback = WAKE + 60_000;
    sources.sandboxes = [
      row({ state: "awake", lastTransitionAt: WAKE, lastActivityAt: WAKE }),
    ];
    sources.readySession = true;
    const transport = { reachable: true };
    const mounted = view(transport);
    expect(mounted.result.current.kind).toBe("none");

    sources.sandboxes = [
      row({
        state: "suspending",
        lastTransitionAt: rollback - 1,
        lastActivityAt: WAKE,
      }),
    ];
    mounted.rerender();
    // The guest answers busy: the row returns to awake, stamping activity and
    // transition alike, and the session then goes away.
    sources.readySession = false;
    transport.reachable = false;
    sources.sandboxes = [
      row({
        state: "awake",
        lastTransitionAt: rollback,
        lastActivityAt: rollback,
        operation: sandboxOperationFixture({
          fromState: "awake",
          state: "awake",
          cause: "idle",
        }),
      }),
    ];
    mounted.rerender();

    expect(mounted.result.current.kind).toBe("unreachable");
  });

  it("does not latch a previous wake's cached directory connectivity", () => {
    const cached = remoteEntry(HOST, null);
    sources.entry = cached;
    sources.sandboxes = [woke({})];
    const mounted = renderHook(() => {
      const state = useChatSandboxState("epic-1", HOST, false);
      return resolveChatSandbox(state, {
        reachable: false,
        canEdit: true,
        ownedByViewer: true,
        environmentOwned: false,
      }).line?.text;
    });
    const refreshed: RemoteHostDirectoryEntry = {
      ...cached,
      remoteStatus: { ...cached.remoteStatus, connectivity: "offline" },
    };
    sources.entry = refreshed;
    mounted.rerender();

    expect(mounted.result.current).toBe("Resuming e2e-sbx · pending");
  });

  it("releases a passive published surface when its healthy owner becomes connectable", () => {
    sources.entry = null;
    sources.sandboxes = [
      row({ state: "resuming", lastTransitionAt: WAKE - 1 }),
    ];
    const transport = { reachable: false };
    const mounted = view(transport);
    sources.sandboxes = [
      row({ state: "awake", lastTransitionAt: WAKE, lastActivityAt: WAKE }),
    ];
    mounted.rerender();
    // This copy is served by another host and does not dial the owner.
    sources.entry = remoteEntry(HOST, null);
    transport.reachable = true;
    mounted.rerender();

    expect(mounted.result.current.kind).toBe("none");
  });

  it("remembers a ready session observed before the awake list answer", () => {
    // One wake keeps one identity from `resuming` through `awake`.
    sources.sandboxes = [
      row({
        state: "resuming",
        lastTransitionAt: WAKE - 1,
        operation: sandboxOperationFixture({
          at: WAKE,
          fromState: "suspended",
          state: "resuming",
          cause: "wake",
        }),
      }),
    ];
    const transport = { reachable: false };
    const mounted = view(transport);
    sources.readySession = true;
    transport.reachable = true;
    mounted.rerender();
    sources.readySession = false;
    transport.reachable = false;
    sources.sandboxes = [woke({})];
    mounted.rerender();

    expect(mounted.result.current.kind).toBe("unreachable");
  });

  it("keeps an answer witnessed while the list still says creating", () => {
    const landed = WAKE + 60_000;
    // A first create records no operation until it lands.
    sources.sandboxes = [
      row({ state: "creating", lastTransitionAt: WAKE, operation: null }),
    ];
    const transport = { reachable: false };
    const mounted = view(transport);
    sources.readySession = true;
    transport.reachable = true;
    mounted.rerender();
    sources.readySession = false;
    transport.reachable = false;
    sources.sandboxes = [
      row({
        state: "awake",
        lastTransitionAt: landed,
        lastActivityAt: landed,
        operation: sandboxOperationFixture({
          at: landed,
          fromState: "creating",
          state: "awake",
          cause: "verb",
        }),
      }),
    ];
    mounted.rerender();

    expect(mounted.result.current.kind).toBe("unreachable");
  });
});

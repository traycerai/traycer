import { renderHook } from "@testing-library/react";
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
import { taskSandboxEndLine } from "@/lib/sandboxes/task-sandbox-end";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  recordEndedSandboxHost,
  recordListedDestroys,
  useEndedSandboxHostsStore,
} from "@/stores/sandboxes/ended-sandbox-hosts-store";

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
  } => ({
    task: { kind: "other" },
    sandboxes: [],
    configurations: {
      configurations: [{ kind: "personal" }],
      teamEnvironmentIds: new Set(),
      complete: true,
    },
    entry: null,
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
  useEndedSandboxHostsStore.setState({ byHostId: {} });
  useAuthStore.setState({
    status: "signed-in",
    profile: { userId: VIEWER, userName: "V", email: "v@example.com" },
    contextMetadata: { userId: VIEWER, username: "V" },
  });
});

afterEach(() => {
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

  it("reads an awake sandbox the transport cannot reach as unreachable, with when the directory last saw it", () => {
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

    expect(stateOf(false)).toMatchObject({
      kind: "unreachable",
      lastSeenAt: NOW - 7 * 60_000 - 20_000,
    });
  });

  it("says no last sighting when the directory has none, and nothing at all while reachable", () => {
    sources.sandboxes = [row({ state: "awake" })];
    sources.entry = remoteEntry(HOST, null);

    expect(stateOf(false)).toMatchObject({
      kind: "unreachable",
      lastSeenAt: null,
    });
    expect(stateOf(true)).toEqual({ kind: "none" });
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

describe("useChatSandboxState for a destroy this device saw", () => {
  // Local time, as every sandbox row states it.
  const AT = new Date(2026, 9, 28, 1, 27).getTime();
  const SENTENCE_END = "Its files are gone; this chat stays readable.";

  /** The one sentence the destroyed state gives the chat. */
  function sentence(): string {
    const state = stateOf(false);
    if (state.kind !== "destroyed") {
      throw new Error(`expected a destroyed state, got ${state.kind}`);
    }
    return taskSandboxEndLine(state.ended.name, state.ended.end);
  }

  function destroying(
    operation: Parameters<typeof sandboxOperationFixture>[0],
    rowOverrides: Partial<SandboxSummary>,
  ): SandboxSummary {
    return row({
      operation: sandboxOperationFixture({ at: AT, ...operation }),
      ...rowOverrides,
    });
  }

  it("says a destroy the viewer started was by you, before the server answers", () => {
    recordEndedSandboxHost(HOST, {
      name: "e2e-sbx",
      at: AT,
      cause: "verb",
      actor: { userId: VIEWER, displayName: null },
      idleMinutes: null,
    });

    expect(sentence()).toBe(
      `e2e-sbx was destroyed on Oct 28 at 01:27 by you. ${SENTENCE_END}`,
    );
  });

  it.each([
    [
      "a teammate's destroy by their name",
      { cause: "verb", actor: { userId: OTHER, displayName: "Dana" } },
      {},
      "by Dana",
    ],
    [
      "a destroy by a member the server does not name",
      { cause: "verb", actor: null },
      {},
      "by a member",
    ],
    [
      "the resting pass",
      { cause: "resting", actor: null },
      {},
      "after resting",
    ],
    [
      "a burst sandbox's idle pass with the row's idle minutes",
      { cause: "burst-idle", actor: null },
      { idleMinutes: 12 },
      "after 12 idle minutes",
    ],
    [
      "a payer's lapse",
      { cause: "day-30", actor: null },
      {},
      "after 30 days frozen",
    ],
  ] as const)(
    "says %s from the listed row",
    (_name, operation, rowFields, cause) => {
      recordListedDestroys([destroying(operation, rowFields)]);

      expect(sentence()).toBe(
        `e2e-sbx was destroyed on Oct 28 at 01:27 ${cause}. ${SENTENCE_END}`,
      );
    },
  );

  it("is destroyed whether or not the transport reaches the host, and over a row still listed as destroying", () => {
    recordEndedSandboxHost(HOST, {
      name: "e2e-sbx",
      at: AT,
      cause: "resting",
      actor: null,
      idleMinutes: null,
    });
    sources.sandboxes = [row({ state: "destroying" })];

    expect(stateOf(false).kind).toBe("destroyed");
    expect(stateOf(true).kind).toBe("destroyed");
  });

  it("gives way to the task's record when it lands, with the same single state", () => {
    recordEndedSandboxHost(HOST, {
      name: "e2e-sbx",
      at: AT,
      cause: "verb",
      actor: { userId: VIEWER, displayName: null },
      idleMinutes: null,
    });
    const ended = {
      name: "e2e-sbx",
      end: {
        state: "destroyed",
        destroyedAt: AT + 60_000,
        cause: "verb",
        actor: "Agent Smith",
        idleMinutes: null,
      },
    } as const;
    sources.task = { kind: "ended", ended };

    expect(stateOf(false)).toEqual({ kind: "destroyed", ended });
  });
});

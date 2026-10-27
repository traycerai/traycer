import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { remoteEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import type { TaskSandboxEndedHost } from "@/hooks/epic/use-task-sandbox-end";
import type { SandboxConfigurations } from "@/hooks/sandboxes/use-sandbox-configurations";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * The classification a chat's footer and send path read, over the real hook.
 * Only its data sources are replaced: the task's projected hosts, the viewer's
 * sandbox list and configurations, the host directory row and the clock.
 */

const NOW = Date.UTC(2026, 9, 27, 12, 0);

const sources = vi.hoisted(
  (): {
    ended: TaskSandboxEndedHost | null;
    sandboxes: SandboxSummary[];
    configurations: SandboxConfigurations;
    entry: HostDirectoryEntry | null;
    now: number;
  } => ({
    ended: null,
    sandboxes: [],
    configurations: {
      configurations: [{ kind: "personal" }],
      teamEnvironmentIds: new Set(),
      complete: true,
    },
    entry: null,
    now: 0,
  }),
);

vi.mock("@/hooks/epic/use-task-sandbox-end", () => ({
  useTaskSandboxEnd: () => sources.ended,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-list-query", () => ({
  useSandboxList: () => ({ data: { sandboxes: sources.sandboxes } }),
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
vi.mock("@/lib/relative-time", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relative-time")>()),
  useSampledNow: () => sources.now,
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
  sources.ended = null;
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
  sources.now = NOW;
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
    const ended: TaskSandboxEndedHost = {
      name: "e2e-sbx",
      end: {
        state: "destroyed",
        destroyedAt: Date.UTC(2026, 9, 27, 6, 21),
        cause: "resting",
        actor: null,
      },
    };
    sources.ended = ended;
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

  it("knows nothing of a resting team sandbox whose configuration is not among the viewer's", () => {
    sources.sandboxes = [
      row({
        state: "suspended",
        environmentId: "env-elsewhere",
        createdBy: { userId: OTHER, displayName: "Other" },
      }),
    ];

    expect(stateOf(false)).toEqual({ kind: "none" });
  });

  it("reads an awake sandbox the transport cannot reach as unreachable, with the minutes since the directory last saw it", () => {
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
      lastContactMinutes: 7,
    });
  });

  it("says no last contact when the directory has none, and nothing at all while reachable", () => {
    sources.sandboxes = [row({ state: "awake" })];
    sources.entry = remoteEntry(HOST, null);

    expect(stateOf(false)).toMatchObject({
      kind: "unreachable",
      lastContactMinutes: null,
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

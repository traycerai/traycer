import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ListGuiAgentCommandsResponse } from "@traycer/protocol/host/index";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { useSlashCommands } from "../use-slash-commands";
import type { HostRpcRegistry } from "@/lib/host";
import type { LocalSlashCommand } from "@/lib/composer/types";

const mockState = vi.hoisted(() => ({
  calls: [] as Array<{
    harnessId: string;
    workingDirectories: ReadonlyArray<string>;
    profileId: string | null;
    enabled: boolean;
    subscribed: boolean;
  }>,
  data: null as ListGuiAgentCommandsResponse | null,
  isPending: false,
  isFetching: false,
  error: null as Error | null,
}));

// `importOriginal` rather than a bare factory: this module also exports the
// profile-scoping choke point this hook reads, and a wholesale replacement
// would make that "not a function" the moment anything below it imports one -
// the trap the picker suite already hit once. Only the QUERY is faked.
vi.mock(
  "@/hooks/harnesses/use-gui-harness-catalog",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/harnesses/use-gui-harness-catalog")
    >()),
    useGuiHarnessCommandsQuery: (
      hostClient: unknown,
      target: {
        harnessId: string;
        workingDirectories: ReadonlyArray<string>;
        profileId: string | null;
      },
      activity: { enabled: boolean; subscribed: boolean },
    ) => {
      void hostClient;
      mockState.calls.push({
        harnessId: target.harnessId,
        workingDirectories: target.workingDirectories,
        profileId: target.profileId,
        enabled: activity.enabled,
        subscribed: activity.subscribed,
      });
      return {
        data: mockState.data,
        isPending: mockState.isPending,
        isFetching: mockState.isFetching,
        error: mockState.error,
        refetch: () => Promise.resolve(),
      };
    },
  }),
);

const HOST_ID = "host-1";

/**
 * A real requester rather than a `getActiveHostId` stand-in: the hook resolves
 * the profile-scoping verdict from the client's own host id, and a cast-down
 * partial would stop compiling honestly the moment it reads anything else.
 * No RPC reaches this messenger - the commands query itself is faked above.
 */
function hostClientFor(hostId: string): HostClient<HostRpcRegistry> {
  const entry = {
    hostId,
    label: hostId,
    kind: "local" as const,
    websocketUrl: `ws://127.0.0.1:0/${hostId}`,
    version: "0.0.0-mock",
    transportDialability: "dialable" as const,
  };
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    findHostById: (id) => (id === entry.hostId ? entry : null),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `req-${hostId}`,
      handlers: {},
    }),
  });
  return spine.createRequester(entry);
}

function recordCatalogManifest(major: number): void {
  recordNegotiatedHostManifest(HOST_ID, {
    "agent.gui.listModels": { major, minor: 0 },
    "agent.gui.listCommands": { major, minor: 0 },
  });
}

describe("useSlashCommands", () => {
  afterEach(() => {
    resetNegotiatedManifests();
  });

  beforeEach(() => {
    resetNegotiatedManifests();
    recordCatalogManifest(2);
    mockState.calls = [];
    mockState.data = {
      harnessId: "codex",
      commands: [
        {
          harnessId: "codex",
          name: "review",
          description: "Review current changes",
          argumentHint: null,
          kind: "slash-command",
          metadata: {},
        },
        {
          harnessId: "codex",
          name: "frontend-design",
          description: "Build polished frontend interfaces",
          argumentHint: "<component>",
          kind: "skill",
          metadata: { path: "/repo/.agents/skills/frontend-design/SKILL.md" },
        },
        {
          harnessId: "codex",
          name: "plan",
          description: "Run the prompt in plan mode",
          argumentHint: null,
          kind: "slash-command",
          metadata: {},
        },
      ],
    };
    mockState.isPending = false;
    mockState.isFetching = false;
    mockState.error = null;
  });

  it("queries the selected provider and returns provider commands", () => {
    const { result } = renderHook(() =>
      useSlashCommands("", {
        hostClient: hostClientFor(HOST_ID),
        harnessId: "codex",
        profileId: null,
        workingDirectories: ["/repo", "/repo/packages/app"],
        enabled: true,
        localCommands: [],
      }),
    );

    expect(mockState.calls.at(-1)).toEqual({
      harnessId: "codex",
      workingDirectories: ["/repo", "/repo/packages/app"],
      profileId: null,
      enabled: true,
      subscribed: true,
    });
    expect(result.current.data.map((command) => command.name)).toEqual([
      "frontend-design",
      "plan",
      "review",
    ]);
    expect(result.current.data[0]).toMatchObject({
      source: "provider",
      description: "Build polished frontend interfaces",
    });
  });

  it("ranks the best fuzzy match first and exposes loading state", () => {
    mockState.isPending = true;

    const { result } = renderHook(() =>
      useSlashCommands("front", {
        hostClient: hostClientFor(HOST_ID),
        harnessId: "codex",
        profileId: null,
        workingDirectories: ["/repo"],
        enabled: true,
        localCommands: [],
      }),
    );

    expect(result.current.isLoading).toBe(true);
    expect(result.current.data[0]).toMatchObject({
      source: "provider",
      name: "frontend-design",
      kind: "skill",
    });
    expect(result.current.data.map((cmd) => cmd.name)).not.toContain("plan");
  });

  it("lists localCommands and lets a local row shadow a same-named provider row", () => {
    mockState.data = {
      harnessId: "claude",
      commands: [
        {
          harnessId: "claude",
          name: "btw",
          description: "Provider's own btw command",
          argumentHint: null,
          kind: "slash-command",
          metadata: {},
        },
        {
          harnessId: "claude",
          name: "review",
          description: "Review current changes",
          argumentHint: null,
          kind: "slash-command",
          metadata: {},
        },
      ],
    };

    const localBtw: LocalSlashCommand = {
      source: "local",
      harnessId: "claude",
      name: "btw",
      description: "Ask a side question in a forked copy of this chat",
      argumentHint: "<question>",
      kind: "slash-command",
      metadata: {},
      preview: {
        kind: "text",
        primary: "Ask a side question <question>",
        secondary: null,
        mono: false,
      },
    };

    const { result } = renderHook(() =>
      useSlashCommands("", {
        hostClient: hostClientFor(HOST_ID),
        harnessId: "claude",
        profileId: null,
        workingDirectories: ["/repo"],
        enabled: true,
        localCommands: [localBtw],
      }),
    );

    const btwRows = result.current.data.filter(
      (command) => command.name.toLowerCase() === "btw",
    );
    expect(btwRows).toHaveLength(1);
    expect(btwRows[0]).toMatchObject({
      source: "local",
      description: "Ask a side question in a forked copy of this chat",
    });
    expect(result.current.data.map((command) => command.name)).toContain(
      "review",
    );
  });

  // W3-T6: a managed profile's skill roots hang off that profile's home, so
  // the palette must ask `agent.gui.listCommands` for the composer's own
  // selected profile - never silently fall back to the default account.
  it("forwards the composer's selected profile to the commands query", () => {
    renderHook(() =>
      useSlashCommands("", {
        hostClient: hostClientFor(HOST_ID),
        harnessId: "codex",
        profileId: "work-profile",
        workingDirectories: ["/repo"],
        enabled: true,
        localCommands: [],
      }),
    );

    expect(mockState.calls.at(-1)).toEqual({
      harnessId: "codex",
      workingDirectories: ["/repo"],
      profileId: "work-profile",
      enabled: true,
      subscribed: true,
    });
  });

  // D17/D21: on a host below `agent.gui.listCommands@2.0` a managed profile
  // cannot be asked about at all. The request is held by the query hook's own
  // gate; what this hook owns is not LYING about it - no eternal spinner, no
  // failed-fetch error with a retry that cannot help, and no substitution of
  // the default account's profile id into the cache key.
  it("reports an unsupported profile without spinning, without an error, and without substituting the default account", () => {
    recordCatalogManifest(1);
    mockState.isPending = true;

    const { result } = renderHook(() =>
      useSlashCommands("", {
        hostClient: hostClientFor(HOST_ID),
        harnessId: "codex",
        profileId: "work-profile",
        workingDirectories: ["/repo"],
        enabled: true,
        localCommands: [],
      }),
    );

    expect(result.current.profileUnsupported).toBe(true);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isFetching).toBe(false);
    expect(result.current.error).toBeNull();
    expect(mockState.calls.at(-1)?.profileId).toBe("work-profile");
  });

  // The other half of the same rule: degradation is per PROFILE, not per
  // host. The default account is answerable on every released line.
  it("keeps the default account working on that same old host", () => {
    recordCatalogManifest(1);

    const { result } = renderHook(() =>
      useSlashCommands("", {
        hostClient: hostClientFor(HOST_ID),
        harnessId: "codex",
        profileId: null,
        workingDirectories: ["/repo"],
        enabled: true,
        localCommands: [],
      }),
    );

    expect(result.current.profileUnsupported).toBe(false);
    expect(result.current.data.map((command) => command.name)).toEqual([
      "frontend-design",
      "plan",
      "review",
    ]);
  });

  // No handshake recorded yet is NOT "the host is too old": the verdict lands
  // with the manifest and the query starts on that render, so the surface
  // waits rather than declaring the profile unanswerable.
  it("reads as loading - never unsupported - while no handshake with the host is recorded", () => {
    resetNegotiatedManifests();

    const { result } = renderHook(() =>
      useSlashCommands("", {
        hostClient: hostClientFor(HOST_ID),
        harnessId: "codex",
        profileId: "work-profile",
        workingDirectories: ["/repo"],
        enabled: true,
        localCommands: [],
      }),
    );

    expect(result.current.profileUnsupported).toBe(false);
    expect(result.current.isLoading).toBe(true);
  });
});

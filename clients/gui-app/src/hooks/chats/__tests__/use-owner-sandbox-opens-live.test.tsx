import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSandboxState } from "@traycer/protocol/host/host-status";
import {
  installHostConnectionRegistrySource,
  resetHostConnectionRegistryForTest,
} from "@traycer-clients/shared/host-client/host-connection-registry";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { poolEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import type { HostReachabilityStatus } from "@/hooks/agent/use-host-reachability";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

/**
 * The chat-open decision for an owner SANDBOX AT REST, driven through the two
 * real hooks that mint the open ref (`useChatRowOpenRef`, the Agents tree and
 * strip; `useEpicAgentOpenRef`, the agent reference chip) over a real
 * connection registry. A sandbox the pool serves while suspended reads
 * "unreachable" to `useHostReachability`, which is correct for every consumer
 * that dials; only the chat-open decision opens it live, because the live tile
 * shows the Resume state.
 *
 * `useHostReachability` is the one stubbed seam, pinned to "unreachable": that
 * is the verdict a sleeping sandbox gets, and the whole point is that the
 * directory row, not that verdict, decides these cases.
 *
 * The serving boundary is the second seam: only a TEAM sandbox in a build with
 * a server pool is served at rest, so the process tier plan is stubbed with a
 * pool by default and switched off for the no-pool cases.
 */

const OWNER_HOST_ID = "host-team-sandbox";
const SESSION_HOST_ID = "host-session";
const OWNER_USER_ID = "env-team-1";

const reachability: { status: HostReachabilityStatus } = {
  status: "unreachable",
};

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => ({
    status: reachability.status,
    hostLabel: "Team sandbox",
  }),
}));

const tier = vi.hoisted(() => ({ pool: true }));

vi.mock(
  "@traycer-clients/shared/host-client/host-rpc-routing",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-client/host-rpc-routing")
      >();
    return {
      ...actual,
      readProcessHostRpcTierPlan: () =>
        tier.pool
          ? actual.createHostRpcTierPlan(poolEntry)
          : actual.NO_POOL_HOST_RPC_TIER_PLAN,
    };
  },
);

vi.mock("@/hooks/epic/use-epic-session-host-id", () => ({
  useEpicSessionHostId: () => SESSION_HOST_ID,
}));

vi.mock("@/lib/epic-selectors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/epic-selectors")>()),
  useEpicNodeHostId: () => OWNER_HOST_ID,
  useEpicNodeOwnerUserId: () => OWNER_USER_ID,
}));

import {
  ownerSandboxOpensLive,
  useOwnerSandboxOpensLive,
} from "@/hooks/chats/use-owner-sandbox-opens-live";
import { useChatRowOpenRef } from "@/components/epic-canvas/sidebar/use-chat-row-open-ref";
import { useEpicAgentOpenRef } from "@/hooks/epic/use-epic-agent-open-ref";

function sandboxEntryOwnedBy(
  hostId: string,
  sandbox: { state: HostSandboxState | null; frozen: boolean } | null,
  ownerTeamId: string | null,
): RemoteHostDirectoryEntry {
  return {
    hostId,
    label: "Team sandbox",
    kind: "remote",
    websocketUrl: "wss://sandbox.traycer.invalid/rpc",
    version: "0.0.0-mock",
    transportDialability: "dialable",
    publicKey: "public-key",
    relayFuseGrace: false,
    sandbox:
      sandbox === null
        ? null
        : {
            ...sandbox,
            profile: null,
            ownerTeamName: ownerTeamId === null ? null : "acme",
            ownerTeamId,
          },
    remoteStatus: {
      connectivity: "offline",
      viewerReachability: "ok",
      clientCloud: "ok",
      updateState: "current",
      appVersion: null,
      lastSeenAt: null,
    },
  };
}

/** A team's sandbox row. */
function sandboxEntry(
  hostId: string,
  sandbox: { state: HostSandboxState | null; frozen: boolean } | null,
): RemoteHostDirectoryEntry {
  return sandboxEntryOwnedBy(hostId, sandbox, OWNER_USER_ID);
}

/** A person's own sandbox row: no owning team. */
function personalSandboxEntry(
  hostId: string,
  state: HostSandboxState,
): RemoteHostDirectoryEntry {
  return sandboxEntryOwnedBy(hostId, { state, frozen: false }, null);
}

/** A one-row directory installed as the registry's source. */
class FakeDirectory {
  private entry: HostDirectoryEntry | null = null;
  private readonly listeners = new Set<() => void>();

  constructor() {
    installHostConnectionRegistrySource({
      directory: {
        // A fresh object per read, like production's per-snapshot rebuild.
        findById: (hostId) =>
          this.entry !== null && this.entry.hostId === hostId
            ? { ...this.entry }
            : null,
        onDirectoryChanged: (listener) => {
          this.listeners.add(listener);
          return { dispose: () => this.listeners.delete(listener) };
        },
      },
      leases: null,
    });
  }

  publish(entry: HostDirectoryEntry | null): void {
    this.entry = entry;
    for (const listener of [...this.listeners]) listener();
  }
}

afterEach(() => {
  cleanup();
  resetHostConnectionRegistryForTest();
  reachability.status = "unreachable";
  tier.pool = true;
});

const SLEEPING_STATES = ["suspended", "stopped"] as const;

const PUBLISHED_COPY_OWNERS: readonly {
  readonly name: string;
  readonly row: HostDirectoryEntry | null;
}[] = [
  {
    name: "a failed sandbox",
    row: sandboxEntry(OWNER_HOST_ID, { state: "failed", frozen: false }),
  },
  {
    name: "a destroying sandbox",
    row: sandboxEntry(OWNER_HOST_ID, { state: "destroying", frozen: false }),
  },
  {
    name: "a suspended sandbox frozen for credits",
    row: sandboxEntry(OWNER_HOST_ID, { state: "suspended", frozen: true }),
  },
  {
    name: "a remote host that is not a sandbox",
    row: sandboxEntry(OWNER_HOST_ID, null),
  },
  { name: "an owner with no directory row", row: null },
];

function renderChatRowRef(): {
  readonly current: () => EpicCanvasTileRef;
} {
  return renderHook(() =>
    useChatRowOpenRef({
      epicId: "epic-1",
      nodeId: "chat-1",
      nodeName: "Team chat",
      openableType: "chat",
      ownerHostId: OWNER_HOST_ID,
      ownerUserId: OWNER_USER_ID,
      sessionHostId: SESSION_HOST_ID,
    }),
  ).result;
}

describe("a chat row whose owner host reads unreachable", () => {
  it.each(SLEEPING_STATES)(
    "opens a LIVE chat ref bound to the owner when the owner is a %s sandbox",
    (state) => {
      new FakeDirectory().publish(
        sandboxEntry(OWNER_HOST_ID, { state, frozen: false }),
      );

      expect(renderChatRowRef().current()).toMatchObject({
        type: "chat",
        id: "chat-1",
        hostId: OWNER_HOST_ID,
      });
    },
  );

  it.each(PUBLISHED_COPY_OWNERS)(
    "still opens the published copy for $name",
    ({ row }) => {
      new FakeDirectory().publish(row);

      expect(renderChatRowRef().current()).toMatchObject({
        type: "published-chat",
        hostId: SESSION_HOST_ID,
        ownerHostId: OWNER_HOST_ID,
        ownerUserId: OWNER_USER_ID,
      });
    },
  );

  it.each(SLEEPING_STATES)(
    "opens the published copy when the owner is a %s PERSONAL sandbox",
    (state) => {
      new FakeDirectory().publish(personalSandboxEntry(OWNER_HOST_ID, state));

      expect(renderChatRowRef().current()).toMatchObject({
        type: "published-chat",
        hostId: SESSION_HOST_ID,
        ownerHostId: OWNER_HOST_ID,
      });
    },
  );

  it.each(SLEEPING_STATES)(
    "opens the published copy when the owner is a %s team sandbox in a build with no pool",
    (state) => {
      tier.pool = false;
      new FakeDirectory().publish(
        sandboxEntry(OWNER_HOST_ID, { state, frozen: false }),
      );

      expect(renderChatRowRef().current()).toMatchObject({
        type: "published-chat",
        hostId: SESSION_HOST_ID,
        ownerHostId: OWNER_HOST_ID,
      });
    },
  );

  it("follows the owner's row: failed opens the published copy, then suspended opens live", () => {
    const directory = new FakeDirectory();
    directory.publish(
      sandboxEntry(OWNER_HOST_ID, { state: "failed", frozen: false }),
    );
    const result = renderChatRowRef();
    expect(result.current()).toMatchObject({ type: "published-chat" });

    act(() => {
      directory.publish(
        sandboxEntry(OWNER_HOST_ID, { state: "suspended", frozen: false }),
      );
    });

    expect(result.current()).toMatchObject({
      type: "chat",
      hostId: OWNER_HOST_ID,
    });
  });
});

describe("an agent reference whose owner host reads unreachable", () => {
  function renderAgentRef() {
    return renderHook(() =>
      useEpicAgentOpenRef({
        epicId: "epic-1",
        nodeId: "chat-1",
        name: "Team chat",
        type: "chat",
      }),
    ).result;
  }

  it("opens a LIVE chat ref bound to the owner when the owner is a suspended sandbox", () => {
    new FakeDirectory().publish(
      sandboxEntry(OWNER_HOST_ID, { state: "suspended", frozen: false }),
    );

    expect(renderAgentRef().current()).toMatchObject({
      type: "chat",
      hostId: OWNER_HOST_ID,
    });
  });

  it("opens the published copy when the owner is a suspended personal sandbox", () => {
    new FakeDirectory().publish(
      personalSandboxEntry(OWNER_HOST_ID, "suspended"),
    );

    expect(renderAgentRef().current()).toMatchObject({
      type: "published-chat",
      hostId: SESSION_HOST_ID,
    });
  });

  it("opens the published copy when the owner is a suspended team sandbox and the build has no pool", () => {
    tier.pool = false;
    new FakeDirectory().publish(
      sandboxEntry(OWNER_HOST_ID, { state: "suspended", frozen: false }),
    );

    expect(renderAgentRef().current()).toMatchObject({
      type: "published-chat",
      hostId: SESSION_HOST_ID,
    });
  });

  it("opens the published copy when the owner is a failed sandbox", () => {
    new FakeDirectory().publish(
      sandboxEntry(OWNER_HOST_ID, { state: "failed", frozen: false }),
    );

    expect(renderAgentRef().current()).toMatchObject({
      type: "published-chat",
      hostId: SESSION_HOST_ID,
    });
  });
});

describe("ownerSandboxOpensLive", () => {
  it.each([
    "suspending",
    "suspended",
    "stopping",
    "stopped",
    "released",
    "resuming",
    "starting",
  ] as const)("is true for a %s sandbox", (state) => {
    expect(
      ownerSandboxOpensLive(sandboxEntry("h", { state, frozen: false }), true),
    ).toBe(true);
  });

  it.each([
    "creating",
    "awake",
    "destroying",
    "destroyed",
    "failed",
    null,
  ] as const)("is false for a sandbox in state %s", (state) => {
    expect(
      ownerSandboxOpensLive(sandboxEntry("h", { state, frozen: false }), true),
    ).toBe(false);
  });

  it.each(["suspended", "stopped", "resuming"] as const)(
    "is false for a %s personal sandbox, which the pool does not serve at rest",
    (state) => {
      expect(
        ownerSandboxOpensLive(personalSandboxEntry("h", state), true),
      ).toBe(false);
    },
  );

  it.each(["suspended", "stopped", "resuming"] as const)(
    "is false for a %s team sandbox when the build has no pool",
    (state) => {
      expect(
        ownerSandboxOpensLive(
          sandboxEntry("h", { state, frozen: false }),
          false,
        ),
      ).toBe(false);
    },
  );

  it("is false for a local host row and for a missing row", () => {
    const local: HostDirectoryEntry = {
      hostId: "h",
      label: "This machine",
      kind: "local",
      websocketUrl: null,
      version: "0.0.0-mock",
      transportDialability: "dialable",
    };
    expect(ownerSandboxOpensLive(local, true)).toBe(false);
    expect(ownerSandboxOpensLive(null, true)).toBe(false);
  });
});

describe("useOwnerSandboxOpensLive", () => {
  it("is false with no owner host id, whatever the directory holds", () => {
    new FakeDirectory().publish(
      sandboxEntry(OWNER_HOST_ID, { state: "suspended", frozen: false }),
    );

    const { result } = renderHook(() => useOwnerSandboxOpensLive(null));

    expect(result.current).toBe(false);
  });
});

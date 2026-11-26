import type { ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { HostSandboxState } from "@traycer/protocol/host/host-status";
import {
  installHostConnectionRegistrySource,
  resetHostConnectionRegistryForTest,
} from "@traycer-clients/shared/host-client/host-connection-registry";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { poolEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import type { HostReachabilityStatus } from "@/hooks/agent/use-host-reachability";
import { ChatServingWitnessContext } from "@/lib/chats/chat-serving-witness";
import type { RetainingChatServingWitness } from "@/lib/chats/pool-chat-serving-witness";
import {
  SELECTION_AUTHORITY_CONTRACT_VERSION,
  type SelectionEvidenceReport,
  type SelectionAuthoritySnapshot,
} from "@traycer-clients/shared/host-selection/selection-authority-contract";
import {
  createFakeAuthorityClock,
  createTestAuthority,
  fleetHost,
} from "@traycer-clients/shared/host-selection/__tests__/selection-authority-harness";
import { CONFIRMED_DEATH_REFUSAL_STREAK } from "@traycer-clients/shared/host-selection/selection-authority-engine";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";
import { chatRecordKey } from "@/stores/epics/open-epic/chat-record-head";
import type { ChatRecordHeadStamp } from "@traycer/protocol/host/epic/chat-records";
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
 * The serving boundary is the second seam: only a TEAM sandbox with a serving
 * WITNESS is served at rest. The process tier plan is stubbed with a pool
 * throughout, so a no-witness case is the negotiated absence (a pool whose
 * handshake lacks `chat.serving.subscribe`) and the provider's no-pool answer
 * alike: both are a `null` witness context. The hooks render inside a
 * witness, or inside a null one.
 */

const OWNER_HOST_ID = "host-team-sandbox";
const SESSION_HOST_ID = "host-session";
const OWNER_USER_ID = "env-team-1";

const reachability: { status: HostReachabilityStatus } = {
  status: "unreachable",
};
const poolRouting = vi.hoisted(() => ({ configured: true }));
interface RoutingDirectory {
  readonly findById: (hostId: string) => HostDirectoryEntry | null;
  readonly onChange: (listener: () => void) => { dispose: () => void };
  readonly hasConcludedDiscovery: () => boolean;
  readonly hasFailedDiscovery: () => boolean;
}
const poolDirectoryBinding = vi.hoisted<{
  current: RoutingDirectory | null;
}>(() => ({ current: null }));
const activeEpicSession = vi.hoisted<{
  current: OpenedStoreForTest | null;
}>(() => ({ current: null }));

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => ({
    status: reachability.status,
    hostLabel: "Team sandbox",
  }),
}));

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
        poolRouting.configured
          ? actual.createHostRpcTierPlan(poolEntry)
          : actual.NO_POOL_HOST_RPC_TIER_PLAN,
    };
  },
);

vi.mock("@/hooks/epic/use-epic-session-host-id", () => ({
  useEpicSessionHostId: () => SESSION_HOST_ID,
}));

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostBinding: () => {
      const directory = poolDirectoryBinding.current;
      return directory === null ? null : { directory };
    },
  };
});

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
    owner: null,
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

/** A witness that has heard nothing: its presence is all the hooks read. */
const WITNESS: RetainingChatServingWitness = {
  verdictFor: () => "unknown",
  subscribe: () => () => undefined,
  retain: () => () => undefined,
  reopen: () => undefined,
  servingFor: () => null,
};

interface WrapperProps {
  readonly children: ReactNode;
}

function WithWitness({ children }: WrapperProps): ReactNode {
  return (
    <EpicSessionContext value={activeEpicSession.current}>
      <ChatServingWitnessContext value={WITNESS}>
        {children}
      </ChatServingWitnessContext>
    </EpicSessionContext>
  );
}

/**
 * What the app provides when there is no pool, and when the pool's handshake
 * does not serve `chat.serving.subscribe`.
 */
function WithoutWitness({ children }: WrapperProps): ReactNode {
  return (
    <EpicSessionContext value={activeEpicSession.current}>
      <ChatServingWitnessContext value={null}>
        {children}
      </ChatServingWitnessContext>
    </EpicSessionContext>
  );
}

/** A one-row directory installed as the registry's source. */
class FakeDirectory {
  private entry: HostDirectoryEntry | null = null;
  private readonly listeners = new Set<() => void>();
  private discoveryConcluded: boolean;
  readonly routingDirectory: RoutingDirectory = {
    findById: (hostId) =>
      this.entry !== null && this.entry.hostId === hostId
        ? { ...this.entry }
        : null,
    onChange: (listener) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    },
    hasConcludedDiscovery: () => this.discoveryConcluded,
    hasFailedDiscovery: () => false,
  };

  constructor(discoveryConcluded: boolean) {
    this.discoveryConcluded = discoveryConcluded;
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

  concludeDiscovery(concluded: boolean): void {
    this.discoveryConcluded = concluded;
    for (const listener of [...this.listeners]) listener();
  }
}

function publishReadyOwnerLeaseFromAuthority(ownerHostId: string): void {
  const authority = createTestAuthority({
    initialFleet: {
      identityGeneration: 0,
      localHostId: null,
      hosts: [fleetHost(ownerHostId, "remote")],
    },
    initialIdentityKey: "account-owner-chat-open-test",
    clock: createFakeAuthorityClock(0),
    poolConfigured: true,
  });
  const reporterId = "owner-chat-open-window";
  const attach = authority.engine.attach(reporterId, {
    attachSeq: authority.engine.allocateAttachSeq(reporterId),
    callerContractVersion: SELECTION_AUTHORITY_CONTRACT_VERSION,
    liveSessions: [
      {
        hostId: ownerHostId,
        sessionId: "owner-chat-open-session",
        transportKind: "remote-relay",
      },
    ],
  });
  if (!attach.ok) throw new Error("selection authority attach failed");
  const snapshot = authority.engine.snapshot();
  if (
    snapshot.leases.find((lease) => lease.hostId === ownerHostId)?.status !==
    "ready"
  ) {
    throw new Error("expected the authority to publish a ready owner lease");
  }
  publishAuthoritySnapshot(snapshot);
  onTestFinished(() => authority.dispose());
}

function publishDeadOwnerLeaseFromAuthority(ownerHostId: string): void {
  const clock = createFakeAuthorityClock(0);
  const authority = createTestAuthority({
    initialFleet: {
      identityGeneration: 0,
      localHostId: null,
      hosts: [fleetHost(ownerHostId, "remote")],
    },
    initialIdentityKey: "account-owner-chat-open-dead-test",
    clock,
    poolConfigured: true,
  });
  const reporterId = "owner-chat-open-dead-window";
  const sessionId = "owner-chat-open-dead-session";
  const attach = authority.engine.attach(reporterId, {
    attachSeq: authority.engine.allocateAttachSeq(reporterId),
    callerContractVersion: SELECTION_AUTHORITY_CONTRACT_VERSION,
    liveSessions: [
      { hostId: ownerHostId, sessionId, transportKind: "remote-relay" },
    ],
  });
  if (!attach.ok) throw new Error("selection authority attach failed");
  const report = (evidence: SelectionEvidenceReport): void =>
    authority.engine.ingestEvidence(reporterId, attach.incarnationId, evidence);
  report({
    kind: "session",
    hostId: ownerHostId,
    sessionId,
    transition: "lost",
    transportKind: "remote-relay",
    at: clock.now(),
  });
  for (
    let attempt = 0;
    attempt < CONFIRMED_DEATH_REFUSAL_STREAK;
    attempt += 1
  ) {
    report({
      kind: "dial",
      hostId: ownerHostId,
      attemptId: `owner-chat-open-refusal-${attempt}`,
      outcome: "confirmed-refusal",
      transportKind: "remote-relay",
      at: clock.now(),
    });
  }
  const snapshot = authority.engine.snapshot();
  if (
    snapshot.leases.find((lease) => lease.hostId === ownerHostId)?.status !==
    "dead"
  ) {
    throw new Error("expected the authority to damp the owner lease dead");
  }
  publishAuthoritySnapshot(snapshot);
  onTestFinished(() => authority.dispose());
}

function publishAuthoritySnapshot(snapshot: SelectionAuthoritySnapshot): void {
  useSelectionAuthorityStore.getState().applyKernelSnapshot({
    attached: true,
    preferredHostId: snapshot.preferredHostId,
    targetHostId: snapshot.targetHostId,
    effectiveHostId: snapshot.effectiveHostId,
    servingPeer: snapshot.servingPeer,
    noPeerPresentation: snapshot.noPeerPresentation,
    leases: snapshot.leases,
    selectionRevision: snapshot.revision,
  });
}

function openEpicSessionWithPublishedHead(): OpenedStoreForTest {
  const session = openStoreForTest({
    epicId: "epic-1",
    userId: "viewer-1",
    factories: {
      streamClientFactory: () => ({
        applyUpdate: () => undefined,
        awareness: () => undefined,
        applyArtifactRoomUpdate: () => undefined,
        artifactRoomAwareness: () => undefined,
        retryMigration: () => undefined,
        close: () => undefined,
      }),
      laneSelection: null,
    },
    writeCommand: null,
  });
  const head: ChatRecordHeadStamp = {
    headSha256: "a".repeat(64),
    publishedAt: 10,
    throughRecordSeq: 1,
  };
  session.store.setState({
    chatRecordHeads: {
      [chatRecordKey(OWNER_USER_ID, "chat-1")]: head,
    },
  });
  activeEpicSession.current = session;
  return session;
}

afterEach(() => {
  cleanup();
  activeEpicSession.current?.dispose();
  activeEpicSession.current = null;
  poolDirectoryBinding.current = null;
  resetHostConnectionRegistryForTest();
  useSelectionAuthorityStore.setState(
    useSelectionAuthorityStore.getInitialState(),
    true,
  );
  reachability.status = "unreachable";
  poolRouting.configured = true;
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

function renderChatRowRef(wrapper: typeof WithWitness): {
  readonly current: () => EpicCanvasTileRef;
} {
  return renderHook(
    () =>
      useChatRowOpenRef({
        epicId: "epic-1",
        nodeId: "chat-1",
        nodeName: "Team chat",
        openableType: "chat",
        ownerHostId: OWNER_HOST_ID,
        ownerUserId: OWNER_USER_ID,
        sessionHostId: SESSION_HOST_ID,
      }),
    { wrapper },
  ).result;
}

describe("a chat row whose owner host reads unreachable", () => {
  it.each(SLEEPING_STATES)(
    "opens a LIVE chat ref bound to the owner when the owner is a %s sandbox",
    (state) => {
      new FakeDirectory(true).publish(
        sandboxEntry(OWNER_HOST_ID, { state, frozen: false }),
      );

      expect(renderChatRowRef(WithWitness).current()).toMatchObject({
        type: "chat",
        id: "chat-1",
        hostId: OWNER_HOST_ID,
      });
    },
  );

  it.each(PUBLISHED_COPY_OWNERS)(
    "still opens the published copy for $name",
    ({ row }) => {
      new FakeDirectory(true).publish(row);

      expect(renderChatRowRef(WithWitness).current()).toMatchObject({
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
      new FakeDirectory(true).publish(
        personalSandboxEntry(OWNER_HOST_ID, state),
      );

      expect(renderChatRowRef(WithWitness).current()).toMatchObject({
        type: "published-chat",
        hostId: SESSION_HOST_ID,
        ownerHostId: OWNER_HOST_ID,
      });
    },
  );

  it.each(SLEEPING_STATES)(
    "opens the published copy when the owner is a %s team sandbox and no serving witness is provided",
    (state) => {
      // The pool is configured (the tier plan above carries one): the witness
      // is absent because the handshake did not negotiate it, and the chat
      // stays on its owner, so a live tile would show no Resume overlay.
      new FakeDirectory(true).publish(
        sandboxEntry(OWNER_HOST_ID, { state, frozen: false }),
      );

      expect(renderChatRowRef(WithoutWitness).current()).toMatchObject({
        type: "published-chat",
        hostId: SESSION_HOST_ID,
        ownerHostId: OWNER_HOST_ID,
      });
    },
  );

  it("follows the owner's row: failed opens the published copy, then suspended opens live", () => {
    const directory = new FakeDirectory(true);
    directory.publish(
      sandboxEntry(OWNER_HOST_ID, { state: "failed", frozen: false }),
    );
    const result = renderChatRowRef(WithWitness);
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

  it("keeps the legacy unreachable copy from the sidebar row when no pool is configured", () => {
    poolRouting.configured = false;
    new FakeDirectory(true).publish(
      sandboxEntry(OWNER_HOST_ID, { state: "suspended", frozen: false }),
    );

    expect(renderChatRowRef(WithoutWitness).current()).toMatchObject({
      type: "published-chat",
      hostId: SESSION_HOST_ID,
      ownerHostId: OWNER_HOST_ID,
      ownerUserId: OWNER_USER_ID,
    });
  });

  it("keeps sidebar and agent opens live across a raw reachability change under a ready owner lease", () => {
    const directory = new FakeDirectory(true);
    directory.publish(sandboxEntry(OWNER_HOST_ID, null));
    poolDirectoryBinding.current = directory.routingDirectory;
    openEpicSessionWithPublishedHead();
    publishReadyOwnerLeaseFromAuthority(OWNER_HOST_ID);
    reachability.status = "reachable";

    const sidebar = renderHook(
      () =>
        useChatRowOpenRef({
          epicId: "epic-1",
          nodeId: "chat-1",
          nodeName: "Team chat",
          openableType: "chat",
          ownerHostId: OWNER_HOST_ID,
          ownerUserId: OWNER_USER_ID,
          sessionHostId: SESSION_HOST_ID,
        }),
      { wrapper: WithWitness },
    );
    const agent = renderHook(
      () =>
        useEpicAgentOpenRef({
          epicId: "epic-1",
          nodeId: "chat-1",
          name: "Team chat",
          type: "chat",
        }),
      { wrapper: WithWitness },
    );

    expect(sidebar.result.current()).toMatchObject({
      type: "chat",
      hostId: OWNER_HOST_ID,
    });
    expect(agent.result.current()).toMatchObject({
      type: "chat",
      hostId: OWNER_HOST_ID,
    });

    reachability.status = "unreachable";
    sidebar.rerender();
    agent.rerender();

    expect(sidebar.result.current()).toMatchObject({
      type: "chat",
      hostId: OWNER_HOST_ID,
    });
    expect(agent.result.current()).toMatchObject({
      type: "chat",
      hostId: OWNER_HOST_ID,
    });
  });

  it("waits for conclusive owner discovery before a dead lease changes the first-open route", () => {
    const directory = new FakeDirectory(false);
    directory.publish(sandboxEntry(OWNER_HOST_ID, null));
    poolDirectoryBinding.current = directory.routingDirectory;
    openEpicSessionWithPublishedHead();
    publishDeadOwnerLeaseFromAuthority(OWNER_HOST_ID);

    const rendered = renderHook(
      () =>
        useChatRowOpenRef({
          epicId: "epic-1",
          nodeId: "chat-1",
          nodeName: "Team chat",
          openableType: "chat",
          ownerHostId: OWNER_HOST_ID,
          ownerUserId: OWNER_USER_ID,
          sessionHostId: SESSION_HOST_ID,
        }),
      { wrapper: WithWitness },
    );

    expect(rendered.result.current()).toMatchObject({
      type: "published-chat",
      hostId: SESSION_HOST_ID,
      ownerHostId: OWNER_HOST_ID,
      ownerUserId: OWNER_USER_ID,
    });

    act(() => directory.concludeDiscovery(true));

    expect(rendered.result.current()).toMatchObject({
      type: "chat",
      hostId: OWNER_HOST_ID,
      ownerUserId: OWNER_USER_ID,
    });
  });
});

describe("an agent reference whose owner host reads unreachable", () => {
  function renderAgentRef(wrapper: typeof WithWitness) {
    return renderHook(
      () =>
        useEpicAgentOpenRef({
          epicId: "epic-1",
          nodeId: "chat-1",
          name: "Team chat",
          type: "chat",
        }),
      { wrapper },
    ).result;
  }

  it("opens a LIVE chat ref bound to the owner when the owner is a suspended sandbox", () => {
    new FakeDirectory(true).publish(
      sandboxEntry(OWNER_HOST_ID, { state: "suspended", frozen: false }),
    );

    expect(renderAgentRef(WithWitness).current()).toMatchObject({
      type: "chat",
      hostId: OWNER_HOST_ID,
    });
  });

  it("opens the published copy when the owner is a suspended personal sandbox", () => {
    new FakeDirectory(true).publish(
      personalSandboxEntry(OWNER_HOST_ID, "suspended"),
    );

    expect(renderAgentRef(WithWitness).current()).toMatchObject({
      type: "published-chat",
      hostId: SESSION_HOST_ID,
    });
  });

  it("opens the published copy when the owner is a suspended team sandbox and no serving witness is provided", () => {
    new FakeDirectory(true).publish(
      sandboxEntry(OWNER_HOST_ID, { state: "suspended", frozen: false }),
    );

    expect(renderAgentRef(WithoutWitness).current()).toMatchObject({
      type: "published-chat",
      hostId: SESSION_HOST_ID,
    });
  });

  it("opens the published copy when the owner is a failed sandbox", () => {
    new FakeDirectory(true).publish(
      sandboxEntry(OWNER_HOST_ID, { state: "failed", frozen: false }),
    );

    expect(renderAgentRef(WithWitness).current()).toMatchObject({
      type: "published-chat",
      hostId: SESSION_HOST_ID,
    });
  });

  it("keeps the legacy unreachable copy from the agent ref when no pool is configured", () => {
    poolRouting.configured = false;
    new FakeDirectory(true).publish(
      sandboxEntry(OWNER_HOST_ID, { state: "suspended", frozen: false }),
    );

    expect(renderAgentRef(WithoutWitness).current()).toMatchObject({
      type: "published-chat",
      hostId: SESSION_HOST_ID,
      ownerHostId: OWNER_HOST_ID,
      ownerUserId: OWNER_USER_ID,
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
    "is false for a %s team sandbox when there is no serving witness",
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
  it("is true for a suspended team sandbox inside a serving witness, false inside a null one", () => {
    new FakeDirectory(true).publish(
      sandboxEntry(OWNER_HOST_ID, { state: "suspended", frozen: false }),
    );

    expect(
      renderHook(() => useOwnerSandboxOpensLive(OWNER_HOST_ID), {
        wrapper: WithWitness,
      }).result.current,
    ).toBe(true);
    expect(
      renderHook(() => useOwnerSandboxOpensLive(OWNER_HOST_ID), {
        wrapper: WithoutWitness,
      }).result.current,
    ).toBe(false);
  });

  it("is false with no owner host id, whatever the directory holds", () => {
    new FakeDirectory(true).publish(
      sandboxEntry(OWNER_HOST_ID, { state: "suspended", frozen: false }),
    );

    const { result } = renderHook(() => useOwnerSandboxOpensLive(null), {
      wrapper: WithWitness,
    });

    expect(result.current).toBe(false);
  });
});

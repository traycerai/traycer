import { use, useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type {
  ListTasksResponse,
  TaskLight,
} from "@traycer/protocol/host/epic/unary-schemas";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  installHostConnectionRegistrySource,
  resetHostConnectionRegistryForTest,
} from "@traycer-clients/shared/host-client/host-connection-registry";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";

// `attached` is the authority's "has anyone answered yet" flag, and it is a
// SEPARATE axis from `id`: the pair (attached: false, id: null) is bootstrap,
// while (attached: true, id: null) is the real ∅. Defaults to attached so every
// pre-existing case here reads exactly as it did before that axis existed.
const hostState = vi.hoisted((): { id: string | null; attached: boolean } => ({
  id: "host-a",
  attached: true,
}));
const authServiceStub = vi.hoisted(() => ({
  revalidateCurrentContext: () => Promise.resolve({ kind: "valid" as const }),
}));
const navigateMock = vi.hoisted(() => vi.fn());
// Real (non-null) `useHostBinding()` for the R-1 owner-identity rotation test
// below - every other test in this file relies on the default `null` (no
// `HostClient` needed to drive `sessionKey`, which is `activeHostId` +
// `sessionUserId` only), so this stays `null` until that test opts in.
const hostBindingRef = vi.hoisted(
  (): {
    value: { readonly hostClient: HostClient<HostRpcRegistry> } | null;
  } => ({
    value: null,
  }),
);
/**
 * The rows `useHostClientForHostId` resolves against, keyed by host id.
 *
 * The provider reads its owner-identity discriminator off THE SESSION'S client
 * (redesign P4.2), so a rotation is now expressed the way production expresses
 * it - the host's directory row changes - rather than by binding a new entry
 * into a slot that no longer exists.
 */
const sessionHostRows = vi.hoisted(
  (): { byHostId: Map<string, unknown>; userId: string | null } => ({
    byHostId: new Map(),
    userId: null,
  }),
);
interface StubSessionHostClient {
  readonly request: Mock;
  readonly getActiveHost: () => unknown;
  readonly getRequestContextUserId: () => string | null;
}
const sessionHostClients = vi.hoisted(
  (): { byHostId: Map<string, StubSessionHostClient> } => ({
    byHostId: new Map(),
  }),
);
/**
 * One stable client object per host id - stable because a consumer-identity
 * assertion below ("shares one resolved host client") is about the resolver
 * handing every consumer the SAME object, and a fresh stub per call would
 * pass that test for the wrong reason.
 */
const resolveSessionHostClient = vi.hoisted(
  () =>
    (hostId: string | null): unknown => {
      if (hostId === null) return null;
      const existing = sessionHostClients.byHostId.get(hostId);
      if (existing !== undefined) return existing;
      const created = {
        request: vi.fn(),
        getActiveHost: () => sessionHostRows.byHostId.get(hostId) ?? null,
        getRequestContextUserId: () => sessionHostRows.userId,
      };
      sessionHostClients.byHostId.set(hostId, created);
      return created;
    },
);

// The provider now opens its own durable transport via this factory, but every
// test installs an `__setEpicStreamClientFactoryForTests` override that
// short-circuits before `openTransport` is ever called - so a stub factory that
// is never invoked is all the provider needs to render in jsdom. The real hook
// returns a referentially-STABLE opener; the stub mirrors that with a single
// hoisted instance so the acquire effect's `openTransport` dep never churns.
const transportState = vi.hoisted((): { opener: () => never } => ({
  opener: () => {
    throw new Error(
      "openTransport must not be called when the factory is overridden",
    );
  },
}));
vi.mock("@/lib/host/use-durable-stream-transport", () => ({
  useDurableStreamTransportFactory: () => transportState.opener,
}));

vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => hostState.id,
}));

vi.mock("@/hooks/host/use-selection-authority-attached", () => ({
  useSelectionAuthorityAttached: () => hostState.attached,
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    resolveSessionHostClient(hostId),
}));

vi.mock("@/lib/host", () => ({
  useHostBinding: () => hostBindingRef.value,
  useAuthService: () => authServiceStub,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

import { EpicSessionProvider } from "@/providers/epic-session-provider";
import {
  __getOpenEpicRegistryForTests,
  __setEpicStreamClientFactoryForTests,
  EpicSessionPresentationContext,
  getEpicSessionHandleHostId,
  type EpicSessionPresentation,
} from "@/lib/registries/epic-session-registry";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { setDesktopEpicOwnershipBridge } from "@/lib/windows/desktop-epic-ownership";
import { useAuthStore } from "@/stores/auth/auth-store";
import { openEpicKey } from "@/lib/persist";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import {
  LIST_CLOUD_TASKS_REQUEST,
  cloudEpicTasksQueryKey,
} from "@/lib/cloud-epic-tasks-query";
import type {
  DesktopOwnershipClaimResult,
  DesktopPerWindowStatePatch,
  DesktopWindowsBridge,
} from "@/lib/windows/types";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";

interface ControlledStream {
  closeCount: number;
}

interface ControlledEpicStream extends ControlledStream {
  readonly callbacks: EpicStreamCallbacks;
}

function snapshotMeta(roomId: string): SnapshotMetaEpic {
  return {
    schemaVersion: "2.0.0",
    roomId,
    epicLight: null,
    permissionRole: "editor",
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64: "AA==",
  };
}

function deliverSnapshot(stream: ControlledEpicStream, roomId: string): void {
  stream.callbacks.onSnapshot(snapshotMeta(roomId), new Uint8Array([0, 0]));
}

type DesktopOwnershipClaimForTests =
  | DesktopOwnershipClaimResult
  | ((
      tabId: string,
      epicId: string,
      ownership: Map<string, string>,
    ) => Promise<DesktopOwnershipClaimResult>);

function resetAuth(
  status: "signed-out" | "signing-in" | "signed-in",
  email: string | null,
): void {
  if (status === "signed-in" && email !== null) {
    useAuthStore.setState({
      status,
      profile: { userId: email, userName: email, email },
      contextMetadata: { userId: email, username: email },
    });
    return;
  }
  useAuthStore.setState({
    status,
    profile: null,
    contextMetadata: null,
  });
}

function HandleProbe(props: {
  onHandle: (handle: OpenEpicStoreHandle) => void;
}) {
  const { onHandle } = props;
  const handle = useMaybeOpenEpicHandle();
  useEffect(() => {
    if (handle === null) return;
    onHandle(handle);
  }, [handle, onHandle]);
  return (
    <div
      data-testid="handle-probe"
      data-ready={handle === null ? "false" : "true"}
    />
  );
}

function SessionHostClientProbe(props: {
  onClient: (client: unknown) => void;
}) {
  const { onClient } = props;
  const client = useEpicSessionHostClient();
  useEffect(() => {
    onClient(client);
  }, [client, onClient]);
  return null;
}

function PresentationProbe(props: {
  onPresentation: (presentation: EpicSessionPresentation | null) => void;
}) {
  const { onPresentation } = props;
  const presentation = use(EpicSessionPresentationContext);
  useEffect(() => {
    onPresentation(presentation);
  }, [onPresentation, presentation]);
  return null;
}

function createDesktopWindowsBridgeForTests(
  calls: {
    readonly claims: string[];
    readonly releases: string[];
    readonly focusRequests: string[];
    readonly perWindowUpdates: DesktopPerWindowStatePatch[];
  },
  claimForTests: DesktopOwnershipClaimForTests,
): DesktopWindowsBridge {
  const ownership = new Map<string, string>();
  return {
    windowId: "window-a",
    list: () => Promise.resolve([]),
    onChange: (_handler) => ({ dispose: () => undefined }),
    requestNew: () => Promise.resolve(),
    requestFocus: (windowId) => {
      calls.focusRequests.push(windowId);
      return Promise.resolve();
    },
    requestClose: () => Promise.resolve(),
    requestOpenEpicInNewWindow: () =>
      Promise.resolve({
        result: "moved" as const,
        windowId: "window-b",
      }),
    ownership: {
      snapshot: () =>
        Promise.resolve(
          Array.from(ownership.entries()).map(([tabId, epicId]) => ({
            tabId,
            epicId,
            windowId: "window-a",
          })),
        ),
      claim: (tabId, epicId) => {
        calls.claims.push(`${tabId}:${epicId}`);
        const claim =
          typeof claimForTests === "function"
            ? claimForTests(tabId, epicId, ownership)
            : Promise.resolve(claimForTests);
        return claim.then((result) => {
          if (result.ok) {
            ownership.set(tabId, epicId);
          }
          return result;
        });
      },
      release: (tabId) => {
        ownership.delete(tabId);
        calls.releases.push(tabId);
        return Promise.resolve();
      },
      onChange: (_handler) => ({ dispose: () => undefined }),
    },
    perWindowState: {
      get: () =>
        Promise.resolve({
          epicTabs: [],
          activeTabId: null,
          canvasByTabId: {},
          landingDrafts: [],
          activeLandingDraftId: null,
        }),
      update: (patch) => {
        calls.perWindowUpdates.push(patch);
        return Promise.resolve();
      },
      onChange: (_handler) => ({ dispose: () => undefined }),
    },
    authSession: {
      get: () =>
        Promise.resolve({
          status: "signed-out" as const,
          token: null,
          profile: null,
        }),
      set: () => Promise.resolve(),
      onChange: (_handler) => ({ dispose: () => undefined }),
    },
  };
}

function resetCanvasStore(): void {
  useEpicCanvasStore.setState({
    tabsById: {},
    openTabOrder: [],
    activeTabId: null,
    mostRecentTabIdByEpicId: {},
    artifactTreeByEpicId: {},
  });
}

function makeHistoryTask(
  id: string,
  title: string,
  createdBy: string,
): TaskLight {
  return {
    epic: {
      light: {
        id,
        title,
        initialUserPrompt: "Investigate the title update bug",
        ticketCount: 0,
        specCount: 0,
        storyCount: 0,
        reviewCount: 0,
        status: "draft",
        createdAt: 1,
        updatedAt: 1,
        createdBy,
        version: "1",
      },
      permission: null,
      repos: [],
      workspaces: [],
      roomInfo: null,
    },
  };
}

/** Matches `createRequestContextFixture`'s default identity. */
const OWNER_IDENTITY_FIXTURE_USER_ID = "user-fixture-1";
const OWNER_IDENTITY_RELAY_URL = "wss://relay.test/attach";
const OWNER_IDENTITY_HOST_ID = "epic-session-test-remote-host";

function buildOwnerIdentityHostClient(): HostClient<HostRpcRegistry> {
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {},
    }),
  });
  client.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "tok-1",
    }),
  );
  return client;
}

// Every field but `publicKey` is held byte-identical across the two calls the
// rotation test makes with this - the isolation the R-1 discriminator depends
// on (a coincident URL/version/status move would mask the gap it closes).
function ownerIdentityRemoteTarget(
  publicKey: string,
): RemoteHostDirectoryEntry {
  return {
    hostId: OWNER_IDENTITY_HOST_ID,
    label: OWNER_IDENTITY_HOST_ID,
    kind: "remote",
    websocketUrl: OWNER_IDENTITY_RELAY_URL,
    version: "1.0.0",
    transportDialability: "dialable",
    publicKey,
    relayFuseGrace: false,
    recentHostCheckIn: false,
    planAllowsRemote: true,
    remoteStatus: {
      connectivity: "connectable",
      viewerReachability: "ok",
      clientCloud: "ok",
      updateState: "current",
      appVersion: null,
      lastSeenAt: null,
    },
  };
}

/**
 * Publishes `hostId`'s directory row and returns a rotate function.
 *
 * The connection registry is installed for real rather than mocked, because
 * the wake path is the subject: `useReactiveOwnerIdentityKey` subscribes to
 * `subscribeAnyHostRowChanged`, and a rotation that changed the row without
 * emitting would leave the projection reading a stale key and every assertion
 * below would pass for the wrong reason (or fail for an unrelated one). The
 * emit is what `bind()` used to do and what the registry does now.
 */
function installOwnerIdentityRows(): (
  hostId: string,
  publicKey: string | null,
) => void {
  const listeners = new Set<() => void>();
  sessionHostRows.userId = OWNER_IDENTITY_FIXTURE_USER_ID;
  installHostConnectionRegistrySource({
    directory: {
      findById: (candidate) =>
        (sessionHostRows.byHostId.get(candidate) ?? null) as never,
      onDirectoryChanged: (listener) => {
        listeners.add(listener);
        return {
          dispose: () => {
            listeners.delete(listener);
          },
        };
      },
    },
    leases: null,
  });
  return (hostId, publicKey) => {
    // `null` removes the row - a deregistration, after which the owner
    // reading for that host is absent rather than rotated.
    if (publicKey === null) {
      sessionHostRows.byHostId.delete(hostId);
    } else {
      sessionHostRows.byHostId.set(hostId, {
        ...ownerIdentityRemoteTarget(publicKey),
        hostId,
        label: hostId,
      });
    }
    for (const listener of [...listeners]) {
      listener();
    }
  };
}

describe("<EpicSessionProvider />", () => {
  beforeEach(() => {
    window.localStorage.clear();
    hostState.id = "host-a";
    hostState.attached = true;
    hostBindingRef.value = null;
    sessionHostRows.byHostId.clear();
    sessionHostRows.userId = null;
    sessionHostClients.byHostId.clear();
    resetHostConnectionRegistryForTest();
    navigateMock.mockClear();
    resetCanvasStore();
    __getOpenEpicRegistryForTests().disposeAll();
    __setEpicStreamClientFactoryForTests(null);
    setDesktopEpicOwnershipBridge(null);
    resetAuth("signed-in", "alice@example.com");
  });

  afterEach(() => {
    cleanup();
    __getOpenEpicRegistryForTests().disposeAll();
    __setEpicStreamClientFactoryForTests(null);
    setDesktopEpicOwnershipBridge(null);
    resetCanvasStore();
    resetAuth("signed-out", null);
    hostBindingRef.value = null;
    resetHostConnectionRegistryForTest();
  });

  it("shares one resolved host client with every session consumer", async () => {
    const seenClients: unknown[] = [];
    __setEpicStreamClientFactoryForTests(() => ({
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => undefined,
    }));

    render(
      <EpicSessionProvider epicId="epic-session-test" tabId="epic-session-test">
        <SessionHostClientProbe
          onClient={(client) => {
            seenClients.push(client);
          }}
        />
        <SessionHostClientProbe
          onClient={(client) => {
            seenClients.push(client);
          }}
        />
      </EpicSessionProvider>,
    );

    await waitFor(() => {
      // The SAME object, not merely two truthy clients: the point of the
      // shared resolver is that every consumer addresses one client for one
      // host, so an identity compare is the only assertion that can fail when
      // the resolver starts minting per-consumer clients.
      const resolved = resolveSessionHostClient(hostState.id);
      expect(seenClients.filter((client) => client === resolved)).toHaveLength(
        2,
      );
    });
  });

  it("reacquires a fresh handle when the signed-in identity changes", async () => {
    const streams: ControlledStream[] = [];
    const seenHandles: OpenEpicStoreHandle[] = [];
    __setEpicStreamClientFactoryForTests((_epicId, _callbacks) => {
      const stream: ControlledStream = { closeCount: 0 };
      streams.push(stream);
      return {
        applyUpdate: () => undefined,
        awareness: () => undefined,
        applyArtifactRoomUpdate: () => undefined,
        artifactRoomAwareness: () => undefined,
        retryMigration: () => undefined,
        close: () => {
          stream.closeCount += 1;
        },
      };
    });

    render(
      <EpicSessionProvider epicId="epic-session-test" tabId="epic-session-test">
        <HandleProbe
          onHandle={(handle) => {
            seenHandles.push(handle);
          }}
        />
      </EpicSessionProvider>,
    );

    await waitFor(() => {
      expect(seenHandles.at(-1)?.userId).toBe("alice@example.com");
    });

    const firstHandle = seenHandles.at(-1);
    if (firstHandle === undefined) {
      throw new Error("expected initial handle");
    }

    act(() => {
      resetAuth("signed-in", "bob@example.com");
    });

    await waitFor(() => {
      expect(seenHandles.at(-1)?.userId).toBe("bob@example.com");
    });

    const secondHandle = seenHandles.at(-1);
    if (secondHandle === undefined) {
      throw new Error("expected second handle");
    }

    expect(secondHandle).not.toBe(firstHandle);
    expect(streams).toHaveLength(2);
    expect(streams[0].closeCount).toBe(1);
    expect(__getOpenEpicRegistryForTests().size()).toBe(1);
  });

  it("keys the session identity on the canonical user id, so two accounts sharing an email do NOT share a session", async () => {
    // Codex #1243 T-66. The arm above seeds `userId: email`, so it is green
    // whether the provider reads the id or the address - it cannot tell them
    // apart. This one seeds DIFFERENT canonical ids behind ONE address, which
    // is the real-world shape: keyed on the email the identity comparison saw
    // no change, the previous user's handle stayed mounted, and the incoming
    // account inherited the outgoing account's persisted focus state and
    // retained unsynced `Y.Doc`.
    const SHARED_EMAIL = "shared@example.com";
    const signInAs = (userId: string): void => {
      useAuthStore.setState({
        status: "signed-in",
        profile: { userId, userName: SHARED_EMAIL, email: SHARED_EMAIL },
        contextMetadata: { userId, username: SHARED_EMAIL },
      });
    };
    const streams: ControlledStream[] = [];
    const seenHandles: OpenEpicStoreHandle[] = [];
    __setEpicStreamClientFactoryForTests((_epicId, _callbacks) => {
      const stream: ControlledStream = { closeCount: 0 };
      streams.push(stream);
      return {
        applyUpdate: () => undefined,
        awareness: () => undefined,
        applyArtifactRoomUpdate: () => undefined,
        artifactRoomAwareness: () => undefined,
        retryMigration: () => undefined,
        close: () => {
          stream.closeCount += 1;
        },
      };
    });
    signInAs("user-alice");

    render(
      <EpicSessionProvider epicId="epic-session-test" tabId="epic-session-test">
        <HandleProbe
          onHandle={(handle) => {
            seenHandles.push(handle);
          }}
        />
      </EpicSessionProvider>,
    );

    await waitFor(() => {
      expect(seenHandles.at(-1)?.userId).toBe("user-alice");
    });
    const firstHandle = seenHandles.at(-1);
    if (firstHandle === undefined) {
      throw new Error("expected initial handle");
    }
    // The stamp is the id, not the address it signed in with.
    expect(firstHandle.userId).not.toBe(SHARED_EMAIL);

    // Same address, different account: the switch the email could not see.
    act(() => {
      signInAs("user-bob");
    });

    await waitFor(() => {
      expect(seenHandles.at(-1)?.userId).toBe("user-bob");
    });
    const secondHandle = seenHandles.at(-1);
    if (secondHandle === undefined) {
      throw new Error("expected second handle");
    }
    expect(secondHandle).not.toBe(firstHandle);
    expect(streams).toHaveLength(2);
    expect(streams[0].closeCount).toBe(1);
    expect(__getOpenEpicRegistryForTests().size()).toBe(1);
  });

  it("adopts a legacy email-keyed persisted blob onto the canonical userId key on first acquire", async () => {
    // Pins `adoptLegacyOpenEpicKey` (epic-session-provider.tsx), which has no
    // coverage of its own: it runs once, inside `createHandle()`, BEFORE the
    // per-Epic store is constructed - because `persist` reads its key at
    // construction time, moving a pre-userId-scoping bucket onto the new one
    // is silent by construction. A broken adoption looks exactly like a fresh
    // install (empty `lastFocusedArtifactId`), so the only way to catch a
    // regression here is to seed the legacy key and assert the NEW key ends
    // up holding it - a green "nothing there" tells you nothing.
    const EPIC_ID = "epic-session-test";
    const LEGACY_EMAIL = "shared@example.com";
    const CANONICAL_USER_ID = "user-alice";
    const legacyKey = openEpicKey(LEGACY_EMAIL, EPIC_ID);
    const canonicalKey = openEpicKey(CANONICAL_USER_ID, EPIC_ID);
    const persistedBlob = JSON.stringify({
      state: { lastFocusedArtifactId: "art-1", lastFocusedThreadId: null },
      version: 1,
    });
    window.localStorage.setItem(legacyKey, persistedBlob);

    __setEpicStreamClientFactoryForTests(() => ({
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => undefined,
    }));
    useAuthStore.setState({
      status: "signed-in",
      profile: {
        userId: CANONICAL_USER_ID,
        userName: LEGACY_EMAIL,
        email: LEGACY_EMAIL,
      },
      contextMetadata: { userId: CANONICAL_USER_ID, username: LEGACY_EMAIL },
    });

    const seenHandles: OpenEpicStoreHandle[] = [];
    render(
      <EpicSessionProvider epicId={EPIC_ID} tabId={EPIC_ID}>
        <HandleProbe
          onHandle={(handle) => {
            seenHandles.push(handle);
          }}
        />
      </EpicSessionProvider>,
    );

    await waitFor(() => {
      expect(seenHandles.at(-1)?.userId).toBe(CANONICAL_USER_ID);
    });

    // The blob moved: it now lives under the canonical key...
    expect(window.localStorage.getItem(canonicalKey)).toBe(persistedBlob);
    // ...and the legacy key is gone, or a second sign-in sharing this email
    // would re-adopt the same stale blob into ITS OWN account.
    expect(window.localStorage.getItem(legacyKey)).toBeNull();
    // The VALUE actually rehydrated into the live store, not just the key -
    // a copy that never got read back by `persist` would pass the two
    // assertions above for the wrong reason.
    const handle = seenHandles.at(-1);
    if (handle === undefined) throw new Error("expected a handle");
    expect(handle.store.getState().lastFocusedArtifactId).toBe("art-1");
  });

  it("never overwrites an existing canonical-key blob with a legacy one", async () => {
    // The control for the arm above: adoption must be a one-shot claim, not a
    // standing sync. Two accounts can share the legacy email bucket - the
    // FIRST to sign in adopts it, and every later sign-in (this account's own
    // second launch, or a different account sharing the same address) must
    // see its own already-adopted state win rather than being clobbered back
    // to the shared legacy blob.
    const EPIC_ID = "epic-session-test";
    const LEGACY_EMAIL = "shared@example.com";
    const CANONICAL_USER_ID = "user-alice";
    const legacyKey = openEpicKey(LEGACY_EMAIL, EPIC_ID);
    const canonicalKey = openEpicKey(CANONICAL_USER_ID, EPIC_ID);
    const legacyBlob = JSON.stringify({
      state: { lastFocusedArtifactId: "legacy-art", lastFocusedThreadId: null },
      version: 1,
    });
    const canonicalBlob = JSON.stringify({
      state: { lastFocusedArtifactId: "own-art", lastFocusedThreadId: null },
      version: 1,
    });
    window.localStorage.setItem(legacyKey, legacyBlob);
    window.localStorage.setItem(canonicalKey, canonicalBlob);

    __setEpicStreamClientFactoryForTests(() => ({
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => undefined,
    }));
    useAuthStore.setState({
      status: "signed-in",
      profile: {
        userId: CANONICAL_USER_ID,
        userName: LEGACY_EMAIL,
        email: LEGACY_EMAIL,
      },
      contextMetadata: { userId: CANONICAL_USER_ID, username: LEGACY_EMAIL },
    });

    const seenHandles: OpenEpicStoreHandle[] = [];
    render(
      <EpicSessionProvider epicId={EPIC_ID} tabId={EPIC_ID}>
        <HandleProbe
          onHandle={(handle) => {
            seenHandles.push(handle);
          }}
        />
      </EpicSessionProvider>,
    );

    await waitFor(() => {
      expect(seenHandles.at(-1)?.userId).toBe(CANONICAL_USER_ID);
    });

    // This account's own blob is untouched...
    expect(window.localStorage.getItem(canonicalKey)).toBe(canonicalBlob);
    // ...and so, per `adoptLegacyPersistedKey`, is the legacy one: adoption
    // returned before ever reading or clearing it, so another account still
    // racing for the same shared bucket sees it exactly as it was.
    expect(window.localStorage.getItem(legacyKey)).toBe(legacyBlob);
    const handle = seenHandles.at(-1);
    if (handle === undefined) throw new Error("expected a handle");
    expect(handle.store.getState().lastFocusedArtifactId).toBe("own-art");
  });

  it("keeps the old handle mounted, then CRDT-merges it after an equal-room re-point", async () => {
    const streams: ControlledEpicStream[] = [];
    const seenHandles: OpenEpicStoreHandle[] = [];
    __setEpicStreamClientFactoryForTests((_epicId, callbacks) => {
      const stream: ControlledEpicStream = { closeCount: 0, callbacks };
      streams.push(stream);
      return {
        applyUpdate: () => undefined,
        awareness: () => undefined,
        applyArtifactRoomUpdate: () => undefined,
        artifactRoomAwareness: () => undefined,
        retryMigration: () => undefined,
        close: () => {
          stream.closeCount += 1;
        },
      };
    });

    const view = render(
      <EpicSessionProvider epicId="epic-session-test" tabId="epic-session-test">
        <HandleProbe
          onHandle={(handle) => {
            seenHandles.push(handle);
          }}
        />
      </EpicSessionProvider>,
    );

    await waitFor(() => {
      expect(seenHandles).toHaveLength(1);
    });

    const firstHandle = seenHandles.at(-1);
    if (firstHandle === undefined) {
      throw new Error("expected initial handle");
    }
    act(() => {
      deliverSnapshot(streams[0], "room-a");
      firstHandle.doc.getMap("epic").set("local-repoint-edit", "pending");
    });

    act(() => {
      hostState.id = "host-b";
      view.rerender(
        <EpicSessionProvider
          epicId="epic-session-test"
          tabId="epic-session-test"
        >
          <HandleProbe
            onHandle={(handle) => {
              seenHandles.push(handle);
            }}
          />
        </EpicSessionProvider>,
      );
    });

    await waitFor(() => {
      expect(streams).toHaveLength(2);
    });
    expect(seenHandles.at(-1)).toBe(firstHandle);
    expect(streams[0].closeCount).toBe(0);

    act(() => {
      deliverSnapshot(streams[1], "room-a");
    });
    await waitFor(() => {
      expect(seenHandles.at(-1)).not.toBe(firstHandle);
    });

    expect(streams).toHaveLength(2);
    expect(streams[0].closeCount).toBe(1);
    expect(__getOpenEpicRegistryForTests().size()).toBe(1);
    expect(
      seenHandles.at(-1)?.doc.getMap("epic").get("local-repoint-edit"),
    ).toBe("pending");
  });

  it("uses a plain swap when the replacement reports a different room", async () => {
    const streams: ControlledEpicStream[] = [];
    const seenHandles: OpenEpicStoreHandle[] = [];
    __setEpicStreamClientFactoryForTests((_epicId, callbacks) => {
      const stream: ControlledEpicStream = { closeCount: 0, callbacks };
      streams.push(stream);
      return {
        applyUpdate: () => undefined,
        awareness: () => undefined,
        applyArtifactRoomUpdate: () => undefined,
        artifactRoomAwareness: () => undefined,
        retryMigration: () => undefined,
        close: () => {
          stream.closeCount += 1;
        },
      };
    });
    const view = render(
      <EpicSessionProvider epicId="epic-session-test" tabId="epic-session-test">
        <HandleProbe onHandle={(handle) => seenHandles.push(handle)} />
      </EpicSessionProvider>,
    );

    await waitFor(() => expect(seenHandles).toHaveLength(1));
    const firstHandle = seenHandles[0];
    act(() => {
      deliverSnapshot(streams[0], "room-a");
      firstHandle.doc.getMap("epic").set("local-repoint-edit", "pending");
      hostState.id = "host-b";
      view.rerender(
        <EpicSessionProvider
          epicId="epic-session-test"
          tabId="epic-session-test"
        >
          <HandleProbe onHandle={(handle) => seenHandles.push(handle)} />
        </EpicSessionProvider>,
      );
    });

    await waitFor(() => expect(streams).toHaveLength(2));
    act(() => {
      deliverSnapshot(streams[1], "room-b");
    });
    await waitFor(() => expect(seenHandles.at(-1)).not.toBe(firstHandle));
    expect(
      seenHandles.at(-1)?.doc.getMap("epic").get("local-repoint-edit"),
    ).toBeUndefined();
  });

  it("two mounted tabs of ONE epic re-point once: the loser adopts the winner's handle instead of parking in establishing", async () => {
    // A duplicated tab mounts a second provider for the same epic; both share
    // the registry's mounted handle, so both start the A -> B re-point with
    // their own candidate. `replaceMounted` lets exactly one win. The loser
    // used to dispose its candidate and return - past a deadline `settled`
    // had already disarmed - and present `establishing` forever on the old
    // handle the winner had just disposed.
    const streams: ControlledEpicStream[] = [];
    const handlesA: OpenEpicStoreHandle[] = [];
    const handlesB: OpenEpicStoreHandle[] = [];
    const presentationsA: Array<EpicSessionPresentation | null> = [];
    const presentationsB: Array<EpicSessionPresentation | null> = [];
    __setEpicStreamClientFactoryForTests((_epicId, callbacks) => {
      const stream: ControlledEpicStream = { closeCount: 0, callbacks };
      streams.push(stream);
      return {
        applyUpdate: () => undefined,
        awareness: () => undefined,
        applyArtifactRoomUpdate: () => undefined,
        artifactRoomAwareness: () => undefined,
        retryMigration: () => undefined,
        close: () => {
          stream.closeCount += 1;
        },
      };
    });
    const body = (): React.JSX.Element => (
      <>
        <EpicSessionProvider epicId="epic-session-test" tabId="tab-a">
          <HandleProbe onHandle={(handle) => handlesA.push(handle)} />
          <PresentationProbe onPresentation={(p) => presentationsA.push(p)} />
        </EpicSessionProvider>
        <EpicSessionProvider epicId="epic-session-test" tabId="tab-b">
          <HandleProbe onHandle={(handle) => handlesB.push(handle)} />
          <PresentationProbe onPresentation={(p) => presentationsB.push(p)} />
        </EpicSessionProvider>
      </>
    );
    const view = render(body());
    await waitFor(() => {
      expect(handlesA).toHaveLength(1);
      expect(handlesB).toHaveLength(1);
    });
    // One shared handle, one stream, two mounted refs.
    expect(handlesB[0]).toBe(handlesA[0]);
    expect(streams).toHaveLength(1);
    act(() => {
      deliverSnapshot(streams[0], "room-a");
    });

    act(() => {
      hostState.id = "host-b";
      view.rerender(body());
    });
    // Both providers start a candidate toward host-b.
    await waitFor(() => expect(streams).toHaveLength(3));

    // The first candidate to load its snapshot wins the atomic replacement.
    act(() => {
      deliverSnapshot(streams[1], "room-a");
    });
    await waitFor(() => {
      expect(handlesA.at(-1)).not.toBe(handlesA[0]);
      expect(handlesB.at(-1)).not.toBe(handlesB[0]);
    });
    // Both providers publish the SAME replacement, the losing candidate is
    // disposed, and the registry holds exactly one entry.
    expect(handlesB.at(-1)).toBe(handlesA.at(-1));
    expect(streams[2].closeCount).toBe(1);
    expect(__getOpenEpicRegistryForTests().size()).toBe(1);
    await waitFor(() => {
      expect(presentationsA.at(-1)?.kind).toBe("ready");
      expect(presentationsB.at(-1)?.kind).toBe("ready");
    });
    // The losing candidate's snapshot arriving later changes nothing.
    act(() => {
      deliverSnapshot(streams[2], "room-a");
    });
    await act(() => Promise.resolve());
    expect(handlesB.at(-1)).toBe(handlesA.at(-1));
    expect(__getOpenEpicRegistryForTests().size()).toBe(1);
  });

  it("bounds a re-point that never snapshots and returns to the original host", async () => {
    vi.useFakeTimers();
    try {
      const streams: ControlledEpicStream[] = [];
      const presentations: Array<EpicSessionPresentation | null> = [];
      __setEpicStreamClientFactoryForTests((_epicId, callbacks) => {
        const stream: ControlledEpicStream = { closeCount: 0, callbacks };
        streams.push(stream);
        return {
          applyUpdate: () => undefined,
          awareness: () => undefined,
          applyArtifactRoomUpdate: () => undefined,
          artifactRoomAwareness: () => undefined,
          retryMigration: () => undefined,
          close: () => {
            stream.closeCount += 1;
          },
        };
      });
      const view = render(
        <EpicSessionProvider
          epicId="epic-session-test"
          tabId="epic-session-test"
        >
          <PresentationProbe
            onPresentation={(presentation) => presentations.push(presentation)}
          />
        </EpicSessionProvider>,
      );

      await act(() => Promise.resolve());
      expect(streams).toHaveLength(1);
      act(() => {
        hostState.id = "host-b";
        view.rerender(
          <EpicSessionProvider
            epicId="epic-session-test"
            tabId="epic-session-test"
          >
            <PresentationProbe
              onPresentation={(presentation) =>
                presentations.push(presentation)
              }
            />
          </EpicSessionProvider>,
        );
      });
      expect(streams).toHaveLength(2);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      const failed = presentations.at(-1);
      expect(failed?.kind).toBe("failed");
      expect(failed?.targetHostId).toBe("host-b");
      expect(failed?.originalHostId).toBe("host-a");
      expect(streams[0].closeCount).toBe(0);
      expect(streams[1].closeCount).toBe(1);

      act(() => {
        failed?.openOnOriginalHost();
      });
      expect(presentations.at(-1)?.kind).toBe("ready");
    } finally {
      vi.useRealTimers();
    }
  });

  it("(R-1, PINNED) keys owner identity on the SESSION's host, not the effective one", async () => {
    // THE DISCRIMINATOR for reading `ownerIdentityKey` off
    // `resolvedSessionHostClient` instead of the app-wide client (redesign
    // P4.2). Every other R-1 case leaves the session UNPINNED, where the two
    // hosts coincide and both readings pass - so this is the only case that
    // can tell them apart, and without it the change would be uncovered.
    //
    // Both directions are asserted, because the old reading was wrong in both:
    // a rotation on the session's own host was invisible (the one thing this
    // discriminator exists to catch), and a rotation on an unrelated effective
    // host tore a live session down.
    vi.useFakeTimers();
    try {
      const streams: ControlledEpicStream[] = [];
      const seenHandles: OpenEpicStoreHandle[] = [];
      const presentations: Array<EpicSessionPresentation | null> = [];
      __setEpicStreamClientFactoryForTests((_epicId, callbacks) => {
        const stream: ControlledEpicStream = { closeCount: 0, callbacks };
        streams.push(stream);
        return {
          applyUpdate: () => undefined,
          awareness: () => undefined,
          applyArtifactRoomUpdate: () => undefined,
          artifactRoomAwareness: () => undefined,
          retryMigration: () => undefined,
          close: () => {
            stream.closeCount += 1;
          },
        };
      });
      const rotateRow = installOwnerIdentityRows();
      rotateRow("host-a", "pubkey-a0");
      rotateRow("host-b", "pubkey-b0");

      const body = () => (
        <EpicSessionProvider
          epicId="epic-session-test"
          tabId="epic-session-test"
        >
          <HandleProbe onHandle={(handle) => seenHandles.push(handle)} />
          <PresentationProbe
            onPresentation={(presentation) => presentations.push(presentation)}
          />
        </EpicSessionProvider>
      );
      const view = render(body());
      await act(() => Promise.resolve());
      expect(streams).toHaveLength(1);

      // PIN the session to host-a while the effective host moves to host-b:
      // the re-point never snapshots, fails at the deadline, and
      // `openOnOriginalHost()` sets `requestedHostId` back to host-a.
      act(() => {
        hostState.id = "host-b";
        view.rerender(body());
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      const failed = presentations.at(-1);
      expect(failed?.kind).toBe("failed");
      act(() => {
        failed?.openOnOriginalHost();
      });
      // Synchronous, NOT `waitFor`: this block runs under fake timers, and
      // `waitFor` polls on a real timer that never advances here - it hangs to
      // its timeout instead of failing, which reports as nothing at all.
      expect(presentations.at(-1)?.kind).toBe("ready");
      await act(() => Promise.resolve());
      const pinnedHandle = seenHandles.at(-1);
      expect(pinnedHandle).toBeDefined();
      const streamsWhilePinned = streams.length;

      // DIRECTION 1: the EFFECTIVE host rotates. It is not this session's
      // host, so nothing may be torn down. Under the old reading this
      // discarded a live stream.
      act(() => {
        rotateRow("host-b", "pubkey-b1");
      });
      await act(() => Promise.resolve());
      expect(seenHandles.at(-1)).toBe(pinnedHandle);
      expect(streams).toHaveLength(streamsWhilePinned);

      // DIRECTION 2: the SESSION's own host rotates. Same hostId, same user -
      // only the key moved, which is exactly the re-enrollment this
      // discriminator exists for. Under the old reading this was invisible.
      act(() => {
        rotateRow("host-a", "pubkey-a1");
      });
      await act(() => Promise.resolve());
      expect(seenHandles.at(-1)).not.toBe(pinnedHandle);
      expect(__getOpenEpicRegistryForTests().size()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("absorbs a churning effect dependency instead of re-presenting", async () => {
    const presentations: Array<EpicSessionPresentation | null> = [];
    __setEpicStreamClientFactoryForTests(() => ({
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => undefined,
    }));
    // STABLE callback: `PresentationProbe` re-fires when EITHER its callback or
    // the presentation changes, so an inline arrow would record a churn of its
    // own making. A FRESH element per render, though - `rerender` with an
    // identical element reference lets React bail out of the subtree, and the
    // provider would never re-read the churned dependency at all. Both mistakes
    // were made writing this pin; the mutation probe caught the first.
    const record = (presentation: EpicSessionPresentation | null): void => {
      presentations.push(presentation);
    };
    const tree = () => (
      <EpicSessionProvider epicId="epic-session-test" tabId="epic-session-test">
        <PresentationProbe onPresentation={record} />
      </EpicSessionProvider>
    );
    const view = render(tree());

    await act(() => Promise.resolve());
    const settled = presentations.length;

    // The REAL transport hook returns a referentially stable opener, and the
    // acquire effect depends on it. Nothing enforces that stability, so the
    // provider must absorb a churning identity rather than store a fresh
    // presentation per commit: an unconditional write here re-renders, which
    // churns the dependency again, which writes again - an infinite render
    // loop, not a wasted render. `epic-surface-isolation` hung on exactly this.
    act(() => {
      transportState.opener = () => {
        throw new Error("openTransport must not be called after the churn");
      };
      view.rerender(tree());
    });

    expect(presentations).toHaveLength(settled);
    expect(presentations.at(-1)?.kind).toBe("ready");
  });

  it("holds a null host in establishing while the selection authority has not attached", async () => {
    vi.useFakeTimers();
    try {
      const presentations: Array<EpicSessionPresentation | null> = [];
      hostState.id = null;
      hostState.attached = false;
      render(
        <EpicSessionProvider
          epicId="epic-session-test"
          tabId="epic-session-test"
        >
          <PresentationProbe
            onPresentation={(presentation) => presentations.push(presentation)}
          />
        </EpicSessionProvider>,
      );

      await act(() => Promise.resolve());
      expect(presentations.at(-1)?.kind).toBe("establishing");
      // Short of the deadline it must STILL be establishing. A window whose
      // kernel has not published yet has not been told anything about hosts,
      // and "couldn't load this task" is a claim about hosts.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(14_000);
      });
      expect(presentations.at(-1)?.kind).toBe("establishing");
      expect(presentations.some((entry) => entry?.kind === "failed")).toBe(
        false,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("presents the selection gap at once when the authority IS attached and names no host", async () => {
    const presentations: Array<EpicSessionPresentation | null> = [];
    hostState.id = null;
    hostState.attached = true;
    render(
      <EpicSessionProvider epicId="epic-session-test" tabId="epic-session-test">
        <PresentationProbe
          onPresentation={(presentation) => presentations.push(presentation)}
        />
      </EpicSessionProvider>,
    );

    // No timer advance anywhere in this case: the authority has spoken, so the
    // gap is a fact, not something to wait out.
    await waitFor(() => {
      expect(presentations.at(-1)?.kind).toBe("failed");
    });
    expect(presentations.at(-1)?.targetHostId).toBeNull();
    expect(__getOpenEpicRegistryForTests().size()).toBe(0);
  });

  it("bounds an authority that never attaches at the establishing deadline", async () => {
    vi.useFakeTimers();
    try {
      const presentations: Array<EpicSessionPresentation | null> = [];
      hostState.id = null;
      hostState.attached = false;
      render(
        <EpicSessionProvider
          epicId="epic-session-test"
          tabId="epic-session-test"
        >
          <PresentationProbe
            onPresentation={(presentation) => presentations.push(presentation)}
          />
        </EpicSessionProvider>,
      );

      await act(() => Promise.resolve());
      // Invariant 6 does not exempt a bridge that never attaches: an unbounded
      // hold here is the infinite skeleton this ticket exists to delete.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      const failed = presentations.at(-1);
      expect(failed?.kind).toBe("failed");
      expect(failed?.targetHostId).toBeNull();
      expect(__getOpenEpicRegistryForTests().size()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("(R-1) reacquires a fresh handle on a same-host remote public-key rotation, isolated from every other field", async () => {
    const streams: ControlledStream[] = [];
    const seenHandles: OpenEpicStoreHandle[] = [];
    __setEpicStreamClientFactoryForTests((_epicId, _callbacks) => {
      const stream: ControlledStream = { closeCount: 0 };
      streams.push(stream);
      return {
        applyUpdate: () => undefined,
        awareness: () => undefined,
        applyArtifactRoomUpdate: () => undefined,
        artifactRoomAwareness: () => undefined,
        retryMigration: () => undefined,
        close: () => {
          stream.closeCount += 1;
        },
      };
    });

    const hostClient = buildOwnerIdentityHostClient();
    expect(hostClient.getRequestContextUserId()).toBe(
      OWNER_IDENTITY_FIXTURE_USER_ID,
    );
    hostBindingRef.value = { hostClient };
    hostState.id = OWNER_IDENTITY_HOST_ID;
    const rotateRow = installOwnerIdentityRows();
    rotateRow(OWNER_IDENTITY_HOST_ID, "pubkey-a");

    render(
      <EpicSessionProvider epicId="epic-session-test" tabId="epic-session-test">
        <HandleProbe
          onHandle={(handle) => {
            seenHandles.push(handle);
          }}
        />
      </EpicSessionProvider>,
    );

    await waitFor(() => {
      expect(seenHandles).toHaveLength(1);
    });
    const firstHandle = seenHandles.at(-1);
    if (firstHandle === undefined) {
      throw new Error("expected initial handle");
    }

    // Same hostId (`activeHostId` never changes), same signed-in user, same
    // websocketUrl/version/status - ONLY the remote host's public key rotates
    // (re-enrollment / corruption recovery). `sessionKey` is unaffected by
    // this, so a pass here proves `ownerIdentityKey` alone drives the
    // release+reacquire, not a coincident `sessionKey`/hostId churn.
    act(() => {
      rotateRow(OWNER_IDENTITY_HOST_ID, "pubkey-b");
    });

    await waitFor(() => {
      expect(seenHandles.at(-1)).not.toBe(firstHandle);
    });

    expect(streams).toHaveLength(2);
    expect(streams[0].closeCount).toBe(1);
    expect(__getOpenEpicRegistryForTests().size()).toBe(1);
  });

  it("defers acquisition without crashing while the active host is null, then acquires when it binds", async () => {
    const streams: ControlledStream[] = [];
    const seenHandles: OpenEpicStoreHandle[] = [];
    __setEpicStreamClientFactoryForTests((_epicId, _callbacks) => {
      const stream: ControlledStream = { closeCount: 0 };
      streams.push(stream);
      return {
        applyUpdate: () => undefined,
        awareness: () => undefined,
        applyArtifactRoomUpdate: () => undefined,
        artifactRoomAwareness: () => undefined,
        retryMigration: () => undefined,
        close: () => {
          stream.closeCount += 1;
        },
      };
    });

    // The directory has not bound a default host yet: the factory would throw
    // "without an active host id" - escaping the acquire effect to the root
    // error boundary - if the effect did not gate on a non-null host. Mounting
    // must NOT crash and must NOT create a session.
    hostState.id = null;
    const view = render(
      <EpicSessionProvider epicId="epic-session-test" tabId="epic-session-test">
        <HandleProbe
          onHandle={(handle) => {
            seenHandles.push(handle);
          }}
        />
      </EpicSessionProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("handle-probe").dataset.ready).toBe("false");
    });
    expect(seenHandles).toEqual([]);
    expect(streams).toHaveLength(0);
    expect(__getOpenEpicRegistryForTests().size()).toBe(0);

    // The host binds: the effect re-runs (activeHostId is a dependency) and the
    // real session is acquired - no provider-driven retry needed.
    act(() => {
      hostState.id = "host-a";
      view.rerender(
        <EpicSessionProvider
          epicId="epic-session-test"
          tabId="epic-session-test"
        >
          <HandleProbe
            onHandle={(handle) => {
              seenHandles.push(handle);
            }}
          />
        </EpicSessionProvider>,
      );
    });

    await waitFor(() => {
      expect(seenHandles).toHaveLength(1);
    });
    expect(streams).toHaveLength(1);
    expect(__getOpenEpicRegistryForTests().size()).toBe(1);
  });

  it("patches cached history titles when a generated epic title lands", async () => {
    const queryClient = new QueryClient();
    const sessionUserId = "alice@example.com";
    const cloudTasksUserId = "cloud-user-1";
    useAuthStore.setState({
      contextMetadata: { userId: cloudTasksUserId, username: sessionUserId },
    });
    const queryKey = cloudEpicTasksQueryKey(
      "host-a",
      cloudTasksUserId,
      LIST_CLOUD_TASKS_REQUEST,
    );
    queryClient.setQueryData<ListTasksResponse>(queryKey, {
      tasks: [makeHistoryTask("epic-session-test", "", cloudTasksUserId)],
      hasMore: false,
    });
    const seenHandles: OpenEpicStoreHandle[] = [];
    __setEpicStreamClientFactoryForTests((_epicId, _callbacks) => ({
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => undefined,
    }));

    render(
      <QueryClientProvider client={queryClient}>
        <EpicSessionProvider
          epicId="epic-session-test"
          tabId="epic-session-test"
        >
          <HandleProbe
            onHandle={(handle) => {
              seenHandles.push(handle);
            }}
          />
        </EpicSessionProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(seenHandles).toHaveLength(1);
    });
    expect(seenHandles[0].userId).toBe(sessionUserId);

    act(() => {
      seenHandles[0].store.getState().setEpicTitle("Generated history title");
    });

    await waitFor(() => {
      expect(
        queryClient.getQueryData<ListTasksResponse>(queryKey)?.tasks[0]?.epic
          ?.light?.title,
      ).toBe("Generated history title");
    });
  });

  it("claims desktop epic ownership before acquiring a renderer session", async () => {
    const streams: ControlledStream[] = [];
    const calls = {
      claims: [] as string[],
      releases: [] as string[],
      focusRequests: [] as string[],
      perWindowUpdates: [] as DesktopPerWindowStatePatch[],
    };
    const seenHandles: OpenEpicStoreHandle[] = [];
    let resolveClaim: (result: DesktopOwnershipClaimResult) => void = () =>
      undefined;
    const claim = new Promise<DesktopOwnershipClaimResult>((resolve) => {
      resolveClaim = resolve;
    });
    setDesktopEpicOwnershipBridge(
      createDesktopWindowsBridgeForTests(calls, () => claim),
    );
    __setEpicStreamClientFactoryForTests((_epicId, _callbacks) => {
      const stream: ControlledStream = { closeCount: 0 };
      streams.push(stream);
      return {
        applyUpdate: () => undefined,
        awareness: () => undefined,
        applyArtifactRoomUpdate: () => undefined,
        artifactRoomAwareness: () => undefined,
        retryMigration: () => undefined,
        close: () => {
          stream.closeCount += 1;
        },
      };
    });

    render(
      <EpicSessionProvider epicId="epic-session-test" tabId="epic-session-test">
        <HandleProbe
          onHandle={(handle) => {
            seenHandles.push(handle);
          }}
        />
      </EpicSessionProvider>,
    );

    await waitFor(() => {
      expect(calls.claims).toEqual(["epic-session-test:epic-session-test"]);
    });

    expect(screen.getByTestId("handle-probe").dataset.ready).toBe("false");
    expect(seenHandles).toEqual([]);
    expect(streams).toHaveLength(0);

    await act(async () => {
      resolveClaim({ ok: true });
      await claim;
    });

    await waitFor(() => {
      expect(seenHandles).toHaveLength(1);
    });
    expect(streams).toHaveLength(1);

    act(() => {
      __getOpenEpicRegistryForTests().release(
        "epic-session-test",
        "discard",
        null,
      );
    });
    await waitFor(() => {
      expect(calls.releases).toEqual(["epic-session-test"]);
    });
  });

  it("releases desktop epic ownership when the provider unmounts", async () => {
    const calls: {
      readonly claims: string[];
      readonly releases: string[];
      readonly focusRequests: string[];
      readonly perWindowUpdates: DesktopPerWindowStatePatch[];
    } = {
      claims: [],
      releases: [],
      focusRequests: [],
      perWindowUpdates: [],
    };
    const seenHandles: OpenEpicStoreHandle[] = [];
    setDesktopEpicOwnershipBridge(
      createDesktopWindowsBridgeForTests(calls, { ok: true }),
    );
    __setEpicStreamClientFactoryForTests((_epicId, _callbacks) => ({
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => undefined,
    }));

    const view = render(
      <EpicSessionProvider epicId="epic-session-test" tabId="tab-cleanup">
        <HandleProbe
          onHandle={(handle) => {
            seenHandles.push(handle);
          }}
        />
      </EpicSessionProvider>,
    );

    await waitFor(() => {
      expect(seenHandles).toHaveLength(1);
    });
    expect(calls.claims).toEqual(["tab-cleanup:epic-session-test"]);

    view.unmount();

    await waitFor(() => {
      expect(calls.releases).toEqual(["tab-cleanup"]);
    });
  });

  it("cleans up optimistic desktop tab state when ownership is rejected", async () => {
    const calls = {
      claims: [] as string[],
      releases: [] as string[],
      focusRequests: [] as string[],
      perWindowUpdates: [] as DesktopPerWindowStatePatch[],
    };
    const seenHandles: OpenEpicStoreHandle[] = [];
    setDesktopEpicOwnershipBridge(
      createDesktopWindowsBridgeForTests(calls, {
        ok: false,
        currentOwner: "window-owner",
      }),
    );
    useEpicCanvasStore.getState().openEpicTab("epic-owned", "Owned");
    const conflictTabId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-conflict", "Conflict");
    useEpicCanvasStore.getState().openTileInTab(conflictTabId, {
      id: "chat-conflict",
      instanceId: "inst-chat-conflict",
      type: "chat",
      name: "Conflict Chat",
      hostId: "test-host",
    });

    render(
      <EpicSessionProvider epicId="epic-conflict" tabId={conflictTabId}>
        <HandleProbe
          onHandle={(handle) => {
            seenHandles.push(handle);
          }}
        />
      </EpicSessionProvider>,
    );

    await waitFor(() => {
      expect(calls.focusRequests).toEqual(["window-owner"]);
    });

    const state = useEpicCanvasStore.getState();
    expect(calls.claims).toEqual([`${conflictTabId}:epic-conflict`]);
    expect(calls.perWindowUpdates).toHaveLength(1);
    const cleanupPatch = calls.perWindowUpdates[0];
    expect(Array.isArray(cleanupPatch.epicTabs)).toBe(true);
    expect(typeof cleanupPatch.activeTabId).toBe("string");
    expect(cleanupPatch.canvasByTabId).toEqual({ [conflictTabId]: null });
    expect(state.openTabOrder).toHaveLength(1);
    expect(state.activeTabId).not.toBeNull();
    expect(state.artifactTreeByEpicId["epic-conflict"]).toEqual([]);
    expect(seenHandles).toEqual([]);
    expect(__getOpenEpicRegistryForTests().size()).toBe(0);
    expect(navigateMock).toHaveBeenCalledWith({ to: "/epics", replace: true });
  });

  describe("a completed re-point keeps the document it merged (B5)", () => {
    function installControlledFactory(streams: ControlledEpicStream[]): void {
      __setEpicStreamClientFactoryForTests((_epicId, callbacks) => {
        const stream: ControlledEpicStream = { closeCount: 0, callbacks };
        streams.push(stream);
        return {
          applyUpdate: () => undefined,
          awareness: () => undefined,
          applyArtifactRoomUpdate: () => undefined,
          artifactRoomAwareness: () => undefined,
          retryMigration: () => undefined,
          close: () => {
            stream.closeCount += 1;
          },
        };
      });
    }

    function providerBody(
      onHandle: (handle: OpenEpicStoreHandle) => void,
    ): React.JSX.Element {
      return (
        <EpicSessionProvider
          epicId="epic-session-test"
          tabId="epic-session-test"
        >
          <HandleProbe onHandle={onHandle} />
        </EpicSessionProvider>
      );
    }

    /**
     * The production path, and the one cell the shipped suite never ran: a
     * re-point that SUCCEEDS while directory rows exist for both hosts.
     *
     * The pre-existing merge test publishes no rows, so `ownerIdentityKey` is
     * a constant `null` for both hosts and the identity branch is unreachable
     * in the only test that would exercise it. Publishing rows is the whole
     * difference - it is what lets the tuple carry a key at all, and so what
     * lets a key recorded for host-a be compared against one read from
     * host-b.
     */
    it("does not rebuild after the merge commits, with rows published for both hosts", async () => {
      const streams: ControlledEpicStream[] = [];
      installControlledFactory(streams);
      const rotateRow = installOwnerIdentityRows();
      rotateRow("host-a", "pubkey-a0");
      rotateRow("host-b", "pubkey-b0");

      const seenHandles: OpenEpicStoreHandle[] = [];
      const view = render(providerBody((handle) => seenHandles.push(handle)));
      await waitFor(() => expect(seenHandles).toHaveLength(1));
      const firstHandle = seenHandles[0];
      act(() => {
        deliverSnapshot(streams[0], "room-a");
        firstHandle.doc.getMap("epic").set("local-repoint-edit", "pending");
      });

      act(() => {
        hostState.id = "host-b";
        view.rerender(providerBody((handle) => seenHandles.push(handle)));
      });
      await waitFor(() => expect(streams).toHaveLength(2));

      // Same room on both sides, so the merge arm runs and the unacknowledged
      // edit is carried into the replacement.
      act(() => {
        deliverSnapshot(streams[1], "room-a");
      });
      await waitFor(() => expect(seenHandles.at(-1)).not.toBe(firstHandle));
      await act(() => Promise.resolve());

      // The merged edit must SURVIVE the commit. Today the tuple written at
      // commit pairs host-b's handle with host-a's key, the next render reads
      // host-b's key, and the mismatch takes the hard-rebuild arm - disposing
      // the handle that is holding the merge.
      expect(
        seenHandles.at(-1)?.doc.getMap("epic").get("local-repoint-edit"),
      ).toBe("pending");
      expect(streams).toHaveLength(2);
      expect(__getOpenEpicRegistryForTests().size()).toBe(1);
    });

    /**
     * The control arm: identical to the catch except the signed-in user is
     * cleared, so the key is `null` on BOTH sides and nothing else moves.
     * Must pass before AND after the fix - if it fails, the cause is the rows
     * or the registry emit, not the identity discriminator.
     */
    it("survives a re-point when no owner identity is readable at all", async () => {
      const streams: ControlledEpicStream[] = [];
      installControlledFactory(streams);
      const rotateRow = installOwnerIdentityRows();
      rotateRow("host-a", "pubkey-a0");
      rotateRow("host-b", "pubkey-b0");
      sessionHostRows.userId = null; // ← THE ONLY DIFFERENCE

      const seenHandles: OpenEpicStoreHandle[] = [];
      const view = render(providerBody((handle) => seenHandles.push(handle)));
      await waitFor(() => expect(seenHandles).toHaveLength(1));
      const firstHandle = seenHandles[0];
      act(() => {
        deliverSnapshot(streams[0], "room-a");
        firstHandle.doc.getMap("epic").set("local-repoint-edit", "pending");
      });

      act(() => {
        hostState.id = "host-b";
        view.rerender(providerBody((handle) => seenHandles.push(handle)));
      });
      await waitFor(() => expect(streams).toHaveLength(2));
      act(() => {
        deliverSnapshot(streams[1], "room-a");
      });
      await waitFor(() => expect(seenHandles.at(-1)).not.toBe(firstHandle));
      await act(() => Promise.resolve());

      expect(
        seenHandles.at(-1)?.doc.getMap("epic").get("local-repoint-edit"),
      ).toBe("pending");
      expect(streams).toHaveLength(2);
      expect(__getOpenEpicRegistryForTests().size()).toBe(1);
    });

    /**
     * The failover shape. A transport-death failover reaches this provider
     * with input BYTE-IDENTICAL to a manual Activate, so the ∅ transit is not
     * a mitigation - and it is the worse case, because the host that would
     * have acknowledged the pending edits is the one that died.
     */
    it("keeps the merged document across an A -> null -> B transit", async () => {
      const streams: ControlledEpicStream[] = [];
      installControlledFactory(streams);
      const rotateRow = installOwnerIdentityRows();
      rotateRow("host-a", "pubkey-a0");
      rotateRow("host-b", "pubkey-b0");

      const seenHandles: OpenEpicStoreHandle[] = [];
      const view = render(providerBody((handle) => seenHandles.push(handle)));
      await waitFor(() => expect(seenHandles).toHaveLength(1));
      const firstHandle = seenHandles[0];
      act(() => {
        deliverSnapshot(streams[0], "room-a");
        firstHandle.doc.getMap("epic").set("local-repoint-edit", "pending");
      });

      act(() => {
        hostState.id = null;
        view.rerender(providerBody((handle) => seenHandles.push(handle)));
      });
      await act(() => Promise.resolve());
      act(() => {
        hostState.id = "host-b";
        view.rerender(providerBody((handle) => seenHandles.push(handle)));
      });
      await waitFor(() => expect(streams).toHaveLength(2));
      act(() => {
        deliverSnapshot(streams[1], "room-a");
      });
      await waitFor(() => expect(seenHandles.at(-1)).not.toBe(firstHandle));
      await act(() => Promise.resolve());

      expect(
        seenHandles.at(-1)?.doc.getMap("epic").get("local-repoint-edit"),
      ).toBe("pending");
      expect(streams).toHaveLength(2);
    });

    /**
     * The null-at-commit arm. host-b's directory row is deliberately absent
     * when the replacement commits, so the honest record is "not read yet",
     * and the row lands afterwards.
     *
     * This is NOT covered by the control arm above, which holds the key at
     * `null` on both sides and so never performs a `null -> key` transition.
     * Without this fixture the null-tolerance half ships unproven.
     */
    it("does not rebuild when the new host's row lands after the commit", async () => {
      const streams: ControlledEpicStream[] = [];
      installControlledFactory(streams);
      const rotateRow = installOwnerIdentityRows();
      rotateRow("host-a", "pubkey-a0");
      // host-b's row is deliberately ABSENT at commit, so its key reads null.

      const seenHandles: OpenEpicStoreHandle[] = [];
      const view = render(providerBody((handle) => seenHandles.push(handle)));
      await waitFor(() => expect(seenHandles).toHaveLength(1));
      const firstHandle = seenHandles[0];
      act(() => {
        deliverSnapshot(streams[0], "room-a");
        firstHandle.doc.getMap("epic").set("local-repoint-edit", "pending");
      });

      act(() => {
        hostState.id = "host-b";
        view.rerender(providerBody((handle) => seenHandles.push(handle)));
      });
      await waitFor(() => expect(streams).toHaveLength(2));
      act(() => {
        deliverSnapshot(streams[1], "room-a");
      });
      await waitFor(() => expect(seenHandles.at(-1)).not.toBe(firstHandle));
      const mergedHandle = seenHandles.at(-1);

      // The row lands late. An absent reading is not a rotation, so this must
      // complete the tuple in place rather than tear the session down.
      act(() => {
        rotateRow("host-b", "pubkey-b0");
      });
      await act(() => Promise.resolve());

      expect(seenHandles.at(-1)).toBe(mergedHandle);
      expect(
        seenHandles.at(-1)?.doc.getMap("epic").get("local-repoint-edit"),
      ).toBe("pending");
      expect(streams).toHaveLength(2);
      expect(__getOpenEpicRegistryForTests().size()).toBe(1);

      // The survival above pins the null TOLERANCE, and tolerance alone is
      // satisfied by doing nothing at all - so it cannot see whether the late
      // row was actually RECORDED. This arm is what proves the completion
      // fired on the re-point path: a genuine rotation on the new host must
      // now tear down. Without it the R-1 boundary would be dead for every
      // re-pointed session and every assertion above would still be green.
      act(() => {
        rotateRow("host-b", "pubkey-b1");
      });
      await waitFor(() => {
        expect(seenHandles.at(-1)).not.toBe(mergedHandle);
      });
      expect(streams).toHaveLength(3);
    });
  });

  describe("warm-handle adoption after a provider remount (F1)", () => {
    function installControlledFactory(streams: ControlledEpicStream[]): void {
      __setEpicStreamClientFactoryForTests((_epicId, callbacks) => {
        const stream: ControlledEpicStream = { closeCount: 0, callbacks };
        streams.push(stream);
        return {
          applyUpdate: () => undefined,
          awareness: () => undefined,
          applyArtifactRoomUpdate: () => undefined,
          artifactRoomAwareness: () => undefined,
          retryMigration: () => undefined,
          close: () => {
            stream.closeCount += 1;
          },
        };
      });
    }

    function providerBody(
      onHandle: (handle: OpenEpicStoreHandle) => void,
    ): React.JSX.Element {
      return (
        <EpicSessionProvider
          epicId="epic-session-test"
          tabId="epic-session-test"
        >
          <HandleProbe onHandle={onHandle} />
        </EpicSessionProvider>
      );
    }

    it("records the warm handle's true binding and re-points instead of relabelling it", async () => {
      const streams: ControlledEpicStream[] = [];
      installControlledFactory(streams);
      const rotateRow = installOwnerIdentityRows();
      rotateRow("host-a", "pubkey-a0");
      rotateRow("host-b", "pubkey-b0");

      const firstMountHandles: OpenEpicStoreHandle[] = [];
      const view = render(
        providerBody((handle) => firstMountHandles.push(handle)),
      );
      await waitFor(() => expect(firstMountHandles).toHaveLength(1));
      const warmHandle = firstMountHandles[0];
      act(() => {
        deliverSnapshot(streams[0], "room-a");
        warmHandle.doc.getMap("epic").set("local-repoint-edit", "pending");
      });

      // Tab closes; the MRU registry keeps the session warm (mounted refs
      // drop to 0, the entry survives below the cap) - the stream keeps
      // running against host-a the whole time.
      view.unmount();
      expect(__getOpenEpicRegistryForTests().size()).toBe(1);
      expect(streams[0].closeCount).toBe(0);

      // The effective host moves while nothing is mounted.
      hostState.id = "host-b";

      // Remount: the registry hands back the WARM handle still streaming
      // from host-a; the factory is not called for the adoption itself.
      const remountHandles: OpenEpicStoreHandle[] = [];
      render(providerBody((handle) => remountHandles.push(handle)));
      await waitFor(() => expect(remountHandles).toHaveLength(1));
      expect(remountHandles[0]).toBe(warmHandle);

      // The stamp names the host the handle is actually bound to - the six
      // stamp consumers (chat-backup RPC, capability gates, artifact image
      // ops, tab model) must route to the machine that owns the stream, not
      // the one the window moved to while the tab was closed.
      expect(getEpicSessionHandleHostId(warmHandle)).toBe("host-a");

      // And the provider takes the SAFE RE-POINT arm toward host-b: a second
      // stream client is constructed while the warm handle stays mounted and
      // its stream stays open. (Relabelling the warm handle instead leaves
      // one stream and a stamp that lies "host-b".)
      await waitFor(() => expect(streams).toHaveLength(2));
      expect(streams[0].closeCount).toBe(0);
      expect(getEpicSessionHandleHostId(warmHandle)).toBe("host-a");
      // End-to-end merge survival across the replacement commit is step 2's
      // (B5) fixture, deliberately not asserted here - see the remediation
      // tracker's partition note.
    });

    it("adopts a warm handle bound to the target as a no-op (control arm)", async () => {
      const streams: ControlledEpicStream[] = [];
      installControlledFactory(streams);
      const rotateRow = installOwnerIdentityRows();
      rotateRow("host-a", "pubkey-a0");

      const firstMountHandles: OpenEpicStoreHandle[] = [];
      const view = render(
        providerBody((handle) => firstMountHandles.push(handle)),
      );
      await waitFor(() => expect(firstMountHandles).toHaveLength(1));
      const warmHandle = firstMountHandles[0];
      view.unmount();
      expect(__getOpenEpicRegistryForTests().size()).toBe(1);

      // Same remount, host unmoved: adoption must stay a silent no-op. This
      // arm passes before AND after the F1 fix - it pins the fix against
      // over-widening (an adoption that rebuilds or re-points here would
      // churn every tab reopen).
      const remountHandles: OpenEpicStoreHandle[] = [];
      render(providerBody((handle) => remountHandles.push(handle)));
      await waitFor(() => expect(remountHandles).toHaveLength(1));
      expect(remountHandles[0]).toBe(warmHandle);
      expect(getEpicSessionHandleHostId(warmHandle)).toBe("host-a");
      await act(() => Promise.resolve());
      expect(streams).toHaveLength(1);
      expect(streams[0].closeCount).toBe(0);
      expect(__getOpenEpicRegistryForTests().size()).toBe(1);
    });

    it("completes an absent owner reading in place, and still rebuilds on a real rotation", async () => {
      const streams: ControlledEpicStream[] = [];
      installControlledFactory(streams);
      // The registry source installs with NO row published for host-a, so
      // the owner-identity reading is absent (null) at acquisition and the
      // tuple records "not yet read".
      const rotateRow = installOwnerIdentityRows();

      const seenHandles: OpenEpicStoreHandle[] = [];
      render(providerBody((handle) => seenHandles.push(handle)));
      await waitFor(() => expect(seenHandles).toHaveLength(1));
      const firstHandle = seenHandles[0];

      // The first real reading for the session's own host lands late. An
      // absent reading is NOT a rotation: the tuple is completed IN PLACE -
      // no rebuild, no second stream, the handle survives. (A refresh loop
      // here fails as "Maximum update depth exceeded"; a rebuild fails the
      // stream count.)
      act(() => {
        rotateRow("host-a", "pubkey-a0");
      });
      await act(() => Promise.resolve());
      expect(streams).toHaveLength(1);
      expect(streams[0].closeCount).toBe(0);
      // Reference identity, not just "a handle is still there": a completion
      // implemented as a rebuild produces correct-looking state, no loop and
      // no red anywhere else - while discarding the Y.Doc, which is the class
      // this remediation exists to close. Only an identity compare forbids it.
      expect(seenHandles.at(-1)).toBe(firstHandle);
      expect(__getOpenEpicRegistryForTests().peek("epic-session-test")).toBe(
        firstHandle,
      );

      // The completion must KEEP the R-1 boundary armed: a genuine same-host
      // public-key rotation after it still tears down and rebuilds. If this
      // arm fails, the in-place completion recorded nothing and rotation
      // detection died with it - the security boundary the discriminator
      // exists for.
      act(() => {
        rotateRow("host-a", "pubkey-a1");
      });
      await waitFor(() => {
        expect(seenHandles.at(-1)).not.toBe(firstHandle);
      });
      expect(streams).toHaveLength(2);
      expect(streams[0].closeCount).toBe(1);
      expect(__getOpenEpicRegistryForTests().size()).toBe(1);
    });

    it("does not treat a vanished owner reading as a rotation", async () => {
      const streams: ControlledEpicStream[] = [];
      installControlledFactory(streams);
      const rotateRow = installOwnerIdentityRows();
      rotateRow("host-a", "pubkey-a0");

      const seenHandles: OpenEpicStoreHandle[] = [];
      render(providerBody((handle) => seenHandles.push(handle)));
      await waitFor(() => expect(seenHandles).toHaveLength(1));
      const firstHandle = seenHandles[0];

      // The serving host is deregistered: its row is removed and the owner
      // reading goes null while the session is mounted. An absent reading is
      // not a rotation - tearing down the live session (and its unsynced
      // edits) on a directory removal would be the discard path by another
      // door.
      act(() => {
        rotateRow("host-a", null);
      });
      await act(() => Promise.resolve());
      expect(streams).toHaveLength(1);
      expect(streams[0].closeCount).toBe(0);
      expect(seenHandles.at(-1)).toBe(firstHandle);
    });
  });
});

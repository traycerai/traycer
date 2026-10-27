import "fake-indexeddb/auto";
import "../../../../__tests__/test-browser-apis";
import { act, cleanup, render, screen } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  FakeStreamClient,
  type FakeStreamSession,
} from "@traycer-clients/shared/host-transport/__testing__/fake-stream-client";
import type { BrowserOwnerInventoryEvidence } from "@traycer/protocol/host/browser/catalog-contracts";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import {
  acquireBrowserSessionsCoordinator,
  browserSessionsCoordinatorKey,
  type BrowserSessionsCoordinatorRuntime,
  type BrowserSessionsState,
} from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import { browserCatalogInventory } from "@/lib/browser-view/sessions/browser-catalog-inventory";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  epicScope,
  sessionInfo,
  tabInfo,
} from "@/lib/browser-view/sessions/__tests__/browser-session-test-kit";
import { BrowserTabTile } from "../browser-tab-tile";

const HOST = "host-b";
const SESSION = "session-1";
const GONE_TAB = "tab-gone";
const KEPT_TAB = "tab-kept";
const capability = {
  catalogVersion: 1,
  durableInventoryRevisions: true,
  revisionedMutationAcks: true,
} as const;

const ctx = vi.hoisted(() => ({ key: null as string | null }));

vi.mock(
  "@/components/epic-canvas/renderers/browser-sessions-context",
  async () => {
    const react = await import("react");
    const coordinator =
      await import("@/lib/browser-view/sessions/browser-sessions-coordinator");
    return {
      useMaybeBrowserSessionsCoordinatorKey: () => ctx.key,
      useBrowserSessionsContext: (): BrowserSessionsState => {
        const key = ctx.key;
        const subscribe = react.useCallback(
          (listener: () => void) =>
            coordinator.subscribeToBrowserSessionsCoordinator(key, listener),
          [key],
        );
        const state = react.useSyncExternalStore(subscribe, () =>
          coordinator.browserSessionsCoordinatorState(key),
        );
        if (state === null) throw new Error("expected coordinator state");
        return state;
      },
    };
  },
);
vi.mock("../agent-browser-tile", () => ({
  ElectronTabSurface: () => <div data-testid="electron-surface" />,
}));
vi.mock("../browser-peek-tile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../browser-peek-tile")>()),
  BrowserPeekTile: () => <div data-testid="peek-surface" />,
}));
vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => ({
    status: "reachable",
    hostLabel: "host-b",
    unavailability: null,
    basis: "directory",
  }),
}));
vi.mock("@/lib/windows/desktop-window-id", () => ({
  useDesktopWindowId: () => null,
  readDesktopWindowId: () => null,
}));

let epicCounter = 0;
let epicId = "";

function evidence(
  rev: number,
  tabs: readonly string[],
): BrowserOwnerInventoryEvidence {
  return {
    kind: "live",
    record: {
      epicId,
      hostId: HOST,
      sessionId: SESSION,
      inventoryRevision: rev,
      lastActivityAt: 1,
      tabs: tabs.map((tabId) => ({
        tabId,
        title: null,
        url: "https://example.test",
      })),
    },
  };
}

function deletion(rev: number): BrowserOwnerInventoryEvidence {
  return {
    kind: "deleted",
    deletion: {
      epicId,
      hostId: HOST,
      sessionId: SESSION,
      inventoryRevision: rev,
    },
  };
}

function runtimeSession(tabs: readonly string[]) {
  return sessionInfo({
    sessionId: SESSION,
    hostId: HOST,
    scope: epicScope(epicId),
    tabs: tabs.map((tabId) => tabInfo({ tabId, status: "ready" })),
  });
}

interface Fixture {
  readonly session: () => FakeStreamSession;
  readonly onRequestClose: Mock<() => void>;
}

function mount(): Fixture {
  const clients: FakeStreamClient[] = [];
  const runtime: BrowserSessionsCoordinatorRuntime = {
    browserView: null,
    userId: "user-1",
    localHostId: null,
    presentation: null,
    navigateNested: () => null,
    openTransport: (): DurableStreamTransport => {
      const client = new FakeStreamClient(true);
      clients.push(client);
      return { wsStreamClient: client, close: () => undefined };
    },
  };
  const scope = epicScope(epicId);
  const key = browserSessionsCoordinatorKey(scope, {
    hostId: HOST,
    identityKey: "identity-b",
  });
  ctx.key = key;
  const release = acquireBrowserSessionsCoordinator({
    key,
    consumerId: Symbol("tile"),
    scope,
    owner: { hostId: HOST, identityKey: "identity-b" },
    runtime,
    createIfMissing: true,
  });
  releases.push(release);
  const session = (): FakeStreamSession => {
    const found = clients.flatMap((client) => client.sessions).at(-1);
    if (found === undefined) throw new Error("expected a subscribed session");
    found.negotiatedSchemaVersion = { major: 2, minor: 3 };
    return found;
  };
  const onRequestClose = vi.fn<() => void>();
  render(
    <BrowserTabTile
      placement={{
        kind: "canvas",
        epicId,
        viewTabId: "view-1",
        paneId: "pane-1",
      }}
      node={{
        instanceId: "instance-1",
        hostId: HOST,
        sessionId: SESSION,
        tabId: GONE_TAB,
        viewportPreset: "responsive",
      }}
      visible
      pageSessionId="page-1"
      onRequestClose={onRequestClose}
      persistViewportPreset={null}
      onOpenLinkInNewTile={null}
      onRequestNewTab={null}
      onNativeTileFocused={null}
      onConvertToPip={null}
    />,
  );
  return { session, onRequestClose };
}

const releases: Array<() => void> = [];

interface RuntimeFrame {
  readonly kind: string;
  readonly [field: string]: unknown;
}

function emitRuntime(session: FakeStreamSession, frame: RuntimeFrame): void {
  act(() => {
    session.emit({ ...frame, hasBinaryPayload: false }, null);
  });
}

function emitOwnerSnapshot(
  session: FakeStreamSession,
  sessions: BrowserOwnerInventoryEvidence[],
): void {
  emitRuntime(session, {
    kind: "ownerInventorySnapshot",
    capability,
    inventory: { epicId, hostId: HOST, sessions },
  });
}

/** Lets a settled journal write and its store notification reach the tile. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe("BrowserTabTile automatic retirement against a durable owner", () => {
  const realOwner = browserCatalogInventory.owner.bind(browserCatalogInventory);

  beforeEach(() => {
    epicCounter += 1;
    epicId = `epic-tile-${epicCounter}`;
    useAuthStore.setState({
      contextMetadata: { userId: "user-1", username: "user-1" },
    });
  });

  afterEach(() => {
    cleanup();
    for (const release of releases.splice(0)) release();
    vi.restoreAllMocks();
    useAuthStore.setState({ contextMetadata: null });
  });

  it("keeps the tile when the first runtime snapshot omits it before any owner metadata", async () => {
    const { session, onRequestClose } = mount();
    emitRuntime(session(), { kind: "snapshot", sessions: [] });
    await settle();

    expect(onRequestClose).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("does not retire on runtime removal while the owner evidence write is held, even with an older cached row that omits the tab, then retires after the commit", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const staleCatalog = evidence(11, [KEPT_TAB]);
    if (staleCatalog.kind !== "live") throw new Error("expected live evidence");
    const cacheScope = { userId: "user-1", epicId };
    await browserCatalogInventory.load(cacheScope);
    await browserCatalogInventory.accept(
      cacheScope,
      {
        kind: "available",
        snapshot: {
          kind: "snapshot",
          version: 5,
          records: [staleCatalog.record],
          fences: [],
          readiness: [],
          revokedHostIds: [],
        },
      },
      browserCatalogInventory.epoch(cacheScope),
    );
    vi.spyOn(browserCatalogInventory, "owner").mockImplementation(
      async (...args) => {
        await gate;
        return realOwner(...args);
      },
    );
    const { session, onRequestClose } = mount();
    emitOwnerSnapshot(session(), []);
    emitRuntime(session(), {
      kind: "snapshot",
      sessions: [runtimeSession([GONE_TAB, KEPT_TAB])],
    });

    // The cached revision-11 row already omits the tab, but it predates the owner's newer removal.
    emitRuntime(session(), {
      kind: "ownerInventoryUpdated",
      evidence: evidence(12, [KEPT_TAB]),
    });
    emitRuntime(session(), {
      kind: "sessionUpdated",
      session: runtimeSession([KEPT_TAB]),
    });
    await settle();
    expect(onRequestClose).not.toHaveBeenCalled();

    release();
    await settle();
    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });

  it("never retires when the owner evidence cannot be saved", async () => {
    vi.spyOn(browserCatalogInventory, "owner").mockRejectedValue(
      new Error("disk full"),
    );
    const { session, onRequestClose } = mount();
    emitOwnerSnapshot(session(), []);
    emitRuntime(session(), {
      kind: "snapshot",
      sessions: [runtimeSession([GONE_TAB, KEPT_TAB])],
    });

    emitRuntime(session(), {
      kind: "ownerInventoryUpdated",
      evidence: evidence(12, [KEPT_TAB]),
    });
    emitRuntime(session(), {
      kind: "sessionUpdated",
      session: runtimeSession([KEPT_TAB]),
    });
    await settle();

    expect(onRequestClose).not.toHaveBeenCalled();
    expect(
      screen.getByText("Couldn't confirm whether this tab is closed."),
    ).toBeTruthy();
  });

  it("retires a tile whose session is closed only after the final deletion evidence is saved", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(browserCatalogInventory, "owner").mockImplementation(
      async (...args) => {
        await gate;
        return realOwner(...args);
      },
    );
    const { session, onRequestClose } = mount();
    emitOwnerSnapshot(session(), []);
    emitRuntime(session(), {
      kind: "snapshot",
      sessions: [runtimeSession([GONE_TAB])],
    });

    emitRuntime(session(), {
      kind: "ownerInventoryUpdated",
      evidence: deletion(13),
    });
    emitRuntime(session(), {
      kind: "sessionClosed",
      sessionId: SESSION,
      reason: "completed",
    });
    await settle();
    expect(onRequestClose).not.toHaveBeenCalled();

    release();
    await settle();
    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the tile when the saved evidence still lists the tab", async () => {
    const { session, onRequestClose } = mount();
    emitOwnerSnapshot(session(), []);
    emitRuntime(session(), {
      kind: "snapshot",
      sessions: [runtimeSession([GONE_TAB, KEPT_TAB])],
    });
    emitRuntime(session(), {
      kind: "ownerInventoryUpdated",
      evidence: evidence(12, [GONE_TAB, KEPT_TAB]),
    });
    emitRuntime(session(), {
      kind: "sessionUpdated",
      session: runtimeSession([KEPT_TAB]),
    });
    await settle();

    expect(onRequestClose).not.toHaveBeenCalled();
  });
});

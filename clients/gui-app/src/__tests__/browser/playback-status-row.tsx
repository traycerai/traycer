import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { recordNegotiatedHostManifest } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  MockRunnerHost,
  MockTraycerCli,
} from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { createRendererContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { EpicConnectionPill } from "@/components/epic-canvas/panels/epic-connection-pill";
import { EpicDurabilityRemedies } from "@/components/epic-canvas/panels/epic-durability-remedies";
import { useEpicDurabilityPlane } from "@/components/epic-canvas/panels/epic-durability-plane";
import { EpicStatusRow } from "@/components/epic-canvas/panels/epic-status-row";
import { EpicSweepAction } from "@/components/epic-canvas/panels/epic-sweep-action";
import { EpicUsageEntryPoint } from "@/components/epic-canvas/panels/epic-usage-entry-point";
import { EpicWriteCommandsEntryPoint } from "@/components/epic-canvas/panels/epic-write-commands-entry-point";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  HostRuntimeProvider,
  hostRpcRegistry,
  useHostBinding,
  useHostClient,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import {
  EpicSessionContext,
  EpicSessionHostClientContext,
  __getOpenEpicRegistryForTests,
  handleHostIds,
} from "@/lib/registries/epic-session-registry";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { WindowsBridgeContext } from "@/providers/windows-bridge-context";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import { playbackTrack } from "@/lib/soundtrack/__tests__/playback-track";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useSoundtrackStore } from "@/stores/soundtrack/soundtrack-store";
import "@/lib/theme-applier";
import "@/index.css";

/**
 * A task's status row, with the real row and every item in it real: the
 * connection pill at its longest label ("Offline — new edits not backed up",
 * the `unprotected` state, reached through the real store's own fields and the
 * real derivation), the write-commands entry (a refused write), "Export
 * artifacts" (a durability pause for revoked access), the sweep action and the
 * usage entry. Where the buttons stop fitting is real layout, which jsdom
 * cannot decide, so nothing the claim rests on is a stand-in.
 *
 * What is faked is only the outside: the host answers over `MockHostMessenger`
 * (an empty worktree list, and a recorded handshake that advertises
 * `host.usage.summary`, which the usage entry waits for), the epic's runtime
 * has no stream behind it, and the store's fields are set the way the host's
 * frames would set them. The harness is `bot-activity-tab.tsx`'s.
 *
 * The row's parent is the column the row sits in: `__playbackRowProbe.setColumnWidth`
 * narrows it, and the window is left alone. The build here has no tracks, so the
 * page gives `globalThis.runnerHost` the bridge a desktop build has, which is what
 * `soundtrackOffered()` reads, and turns Music and the option on.
 */
const HOST_ID = "playback-status-row-host";
const EPIC_ID = "playback-status-row-epic";

declare global {
  interface Window {
    __playbackRowProbe?: {
      readonly setColumnWidth: (pixels: number) => void;
    };
  }
}

Object.defineProperty(globalThis, "runnerHost", {
  configurable: true,
  value: {
    soundtrackSourceAvailable: true,
    readSoundtrackSet: () => Promise.resolve({ kind: "unavailable" }),
  },
});
useSettingsStore.setState({
  soundtrackEnabled: true,
  soundtrackPlaybackControls: true,
});

/**
 * What the buttons' label shows is the track in front, which the real session
 * sets (the Vitest suite drives that). The layout claim only needs a title too
 * long for the label, so the store's own field is seeded with a real track
 * definition: a name that is not the title, and a title that must be cut.
 */
useSoundtrackStore.setState({
  soundingTrack: {
    ...playbackTrack("internal-track-name", 60),
    title:
      "A very long track title that cannot fit the label beside the buttons",
  },
});

const localHost = {
  hostId: HOST_ID,
  websocketUrl: "ws://127.0.0.1:9/rpc",
  version: "1.2.3",
  pid: 4546,
  systemHostName: "playback-status-row-fixture",
  displayName: "playback-status-row-fixture",
  availability: "available",
} as const;

const runnerHost = new MockRunnerHost({
  signInUrl: "http://127.0.0.1:9/sign-in",
  authnBaseUrl: "http://127.0.0.1:9",
  localHost,
  hosts: [],
  workspaceFolderPickerPaths: undefined,
  hasLocalHost: undefined,
  traycerCli: new MockTraycerCli(),
});

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});
const windowsBridgeValue = { bridge: null, hasHydrated: true } as const;

let requestCounter = 0;
const messengerFactory: MessengerFactory<HostRpcRegistry> = ({ registry }) =>
  new MockHostMessenger<HostRpcRegistry>({
    registry,
    requestId: () => `playback-status-row-${String(++requestCounter)}`,
    handlers: {
      "host.status": () => ({
        ready: true,
        hostVersion: "1.2.3",
        protocolVersion: { major: 1, minor: 2 },
        busy: false,
        busySessionCount: 0,
        updateProgress: null,
        busyBreakdown: null,
        updateOperation: null,
        updateTransaction: null,
        storeFormats: null,
        install: null,
        processMemory: null,
        crossHostMessaging: null,
        sessions: null,
        updatesExternallyManaged: null,
        previousExit: null,
      }),
      "worktree.listAllForHost": () => ({ worktrees: [], nextCursor: null }),
    },
  });

// A real handshake records what the host advertises; the mock messenger has
// none, and the usage entry shows only once the host has advertised its method.
recordNegotiatedHostManifest(HOST_ID, {
  "host.usage.summary": { major: 1, minor: 0 },
});

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

/**
 * The epic's real store, in the state that makes each item show: the link up
 * and the cloud down with no local protection (the pill's `unprotected`), a
 * refused write (the queue entry, which does not count as divergence, so the
 * pill keeps its label), and a durability pause for revoked access ("Export
 * artifacts").
 */
const handle = __getOpenEpicRegistryForTests().acquire(EPIC_ID, () =>
  openStoreForTest({
    epicId: EPIC_ID,
    userId: null,
    factories: {
      streamClientFactory: noopStreamClientFactory,
      laneSelection: null,
    },
    writeCommand: null,
  }),
);
handleHostIds.set(handle, HOST_ID);
handle.store.setState({
  snapshotLoaded: true,
  hostTransportStatus: "open",
  hasConnectedOnce: true,
  cloudSyncStatus: "disconnected",
  hasFreshCloudSyncStatus: true,
  hasDirtySnapshotForOpenCycle: true,
  rootDirty: false,
  isDirty: false,
  localProtection: "unavailable",
  durabilityStatus: "paused",
  durabilityPauseReason: "access-revoked",
  durabilityLegsNegotiated: true,
  writeCommands: [
    {
      commandId: "playback-status-row-command",
      intent: { kind: "rename-artifact", artifactId: "a", title: "A" },
      state: "rejected",
      delivery: "settled",
      issuedAtMs: 0,
      attempts: 1,
      expectedEntityVersion: null,
      resolution: {
        kind: "rejected",
        code: "denied",
        reason: "Not allowed",
        retryable: false,
      },
    },
  ],
});

/** Holds the row back until the host client has its request context. */
export function RequestContext(props: {
  readonly children: ReactNode;
}): ReactNode {
  const binding = useHostBinding();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (ready || binding === null) return;
    const unsubscribe = binding.hostClient.onChange(() => setReady(true));
    binding.hostClient.setRequestContext(
      createRendererContextFixture({ bearerToken: "fixture" }),
    );
    return unsubscribe;
  }, [binding, ready]);
  return ready ? props.children : null;
}

export function SignedIn(props: {
  readonly children: ReactNode;
}): ReactElement {
  const authStatus = useAuthStore((state) => state.status);
  useEffect(() => {
    if (authStatus === "signed-in") return;
    useAuthStore.getState().setSignedIn(
      {
        userId: "playback-status-row-user",
        userName: "Status Row User",
        email: "status-row@example.invalid",
      },
      {
        userId: "playback-status-row-user",
        username: "Status Row User",
      },
      [],
    );
  }, [authStatus]);
  return <>{props.children}</>;
}

/** The session's pieces, as `EpicSessionProvider` gives them to its subtree. */
export function Session(props: { readonly children: ReactNode }): ReactNode {
  const hostClient = useHostClient();
  return (
    <EpicSessionContext.Provider value={handle}>
      <EpicSessionHostClientContext.Provider value={hostClient}>
        {props.children}
      </EpicSessionHostClientContext.Provider>
    </EpicSessionContext.Provider>
  );
}

/** The row's items in the order `EpicShellStatusRow` draws them. */
export function RowItems(): ReactNode {
  const durability = useEpicDurabilityPlane();
  return (
    <>
      <EpicConnectionPill epicId={EPIC_ID} durability={durability} />
      <EpicWriteCommandsEntryPoint />
      <EpicUsageEntryPoint epicId={EPIC_ID} />
      <EpicDurabilityRemedies />
      <EpicSweepAction epicId={EPIC_ID} tabId="playback-status-row-tab" />
    </>
  );
}

export function Fixture(): ReactNode {
  const [width, setWidth] = useState(1200);
  useEffect(() => {
    window.__playbackRowProbe = { setColumnWidth: setWidth };
  }, []);
  return (
    <div data-testid="column" style={{ width }}>
      <EpicStatusRow>
        <RowItems />
      </EpicStatusRow>
    </div>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("no root element");
createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <RunnerHostProvider runnerHost={runnerHost}>
      <HostRuntimeProvider
        registry={hostRpcRegistry}
        messengerFactory={messengerFactory}
        invalidator={null}
        requestId={null}
        remoteFetcher={() => Promise.resolve({ kind: "hosts", entries: [] })}
        fallback={<div data-testid="playback-status-row-fallback" />}
      >
        <WindowsBridgeContext.Provider value={windowsBridgeValue}>
          <TooltipProvider>
            <SignedIn>
              <RequestContext>
                <Session>
                  <Fixture />
                </Session>
              </RequestContext>
            </SignedIn>
          </TooltipProvider>
        </WindowsBridgeContext.Provider>
      </HostRuntimeProvider>
    </RunnerHostProvider>
  </QueryClientProvider>,
);

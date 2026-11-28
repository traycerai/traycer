import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import {
  createHostTokenSource,
  createMemoryHostTokenPersistence,
  type HostTokenSource,
} from "@traycer-clients/shared/auth/host-token-source";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useEffect, useRef, type ReactNode } from "react";
import { toast } from "sonner";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import type { StreamAuthRevalidator } from "@traycer-clients/shared/auth/bearer-revalidator";
import {
  CLIENT_CAPABILITY_NOBODY_SIGNED_IN_V1,
  type FatalErrorDetails,
} from "@traycer/protocol/framework/ws-protocol";
import type { StreamCloseReason } from "@traycer/protocol/host-transport/stream-session";
import { isReopenableHostStreamClose } from "@traycer-clients/shared/host-client/host-connection-reconnect-engine";
import {
  MockRunnerHost,
  MockTraycerCli,
} from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  FakeNativeWebSocket,
  liveBearer,
  newProvider,
  sentFramesOfKind,
  signIn,
  USER_A,
} from "@traycer-clients/shared/test-fixtures/dial-gate-harness";
import { HostRuntime } from "@traycer-clients/shared/host-client/host-runtime";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  isRemoteHostDirectoryEntry,
  type RemoteHostDirectoryEntry,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import { remoteEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { ITraycerCli } from "@traycer-clients/shared/platform/runner-host";
import type { HostLeaseSnapshot } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import type { HostDoorState } from "@traycer-clients/shared/host-transport/host-door-state";
import type { IHostMessenger } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  hasReadyRemoteSession,
  retireAllRemoteSessions,
} from "@traycer-clients/shared/host-transport/remote/index";
import { RemoteMuxTestPeer } from "@traycer-clients/shared/host-transport/__tests__/remote-mux-test-peer";
import type {
  IStreamWebSocketFactory,
  StreamWebSocketLike,
} from "@traycer-clients/shared/host-transport/ws-stream-factory";
import type { SelectionKernelSnapshot } from "@traycer-clients/shared/host-selection/selection-evidence-kernel";
import { AuthService } from "@/lib/auth/auth-service";
import { HostDirectoryService } from "@/lib/host/host-directory-service";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";
import {
  buildHostStreamClient,
  useHostStreamClientBindingFor,
} from "@/hooks/host/use-host-stream-client-for";
import { resetHostStreamClientCacheForTest } from "@/lib/host/host-stream-client-cache";
import { HOST_BOOT_CARD_SURFACE } from "@/components/centered-card";
import { WindowHostModalHost } from "@/components/layout/dialogs/window-host-modal-host";
import { SignOutConfirmDialog } from "@/components/auth/sign-out-confirm-dialog";
import {
  HostReadinessControllerContext,
  type DefaultHostReadinessPresentation,
  type HostReadinessController,
  type SurfaceReadiness,
} from "@/components/layout/host-readiness-controller-context";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import {
  clearHostDoorState,
  hostDoorStateFor,
  noteHostDoorState,
  useHostDoorStateStore,
} from "@/stores/host/host-door-state-store";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSignOutConfirmStore } from "@/stores/auth/sign-out-confirm-store";
import { setMobileApp } from "@/lib/mobile-app";
import { onHostDoorRetry } from "@/lib/host/host-door-retry";
import { transportEvidenceRelay } from "@/lib/host/transport-evidence";
import { appHostDoorObserver } from "@/lib/host/host-door-observer";
import { buildRuntimeHostMessenger } from "@/lib/host/host-messenger";
import { SandboxTileStateFrame } from "@/components/hosts/sandbox-tile-state-frame";
import { TabHostContext } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useHoldNobodySignedInSession } from "@/hooks/host/use-hold-nobody-signed-in-session";
import { REMOTE_SESSION_LINGER_MS } from "@traycer/protocol/host-transport/remote/config";
import { useHostReadRefusal } from "@/components/settings/host-scope/use-host-read-refusal";
import { RemoteSession } from "@traycer/protocol/host-transport/remote/session";
import type { HostDoorStateKind } from "@traycer-clients/shared/host-transport/host-door-state";
import { appLogger } from "@/lib/logger";
import { HostRuntimeContext } from "@/lib/host/runtime";
import { MINIMUM_HOST_VERSION } from "@traycer-clients/shared/host-client/minimum-host-version";
import { installAuthValidationFetch } from "../../../../../__tests__/test-browser-apis";

const signOutRound2Harness = vi.hoisted(() => ({
  signOut: vi.fn<() => Promise<boolean>>(() => Promise.resolve(false)),
}));
const narrationRound2Harness = vi.hoisted(() => ({
  teamMembershipRequired: false,
  nextInstanceId: 0,
  activeInstanceId: 0,
}));
const remoteSocketFactoryHarness = vi.hoisted(() => {
  const harness: { delegate: IStreamWebSocketFactory | null } = {
    delegate: null,
  };
  return harness;
});

vi.mock(
  "@traycer-clients/shared/host-transport/whatwg-stream-ws-factory",
  async (load) => {
    const actual =
      await load<
        typeof import("@traycer-clients/shared/host-transport/whatwg-stream-ws-factory")
      >();
    return {
      ...actual,
      createWhatwgStreamWebSocketFactory: () => {
        const original = actual.createWhatwgStreamWebSocketFactory();
        const factory: IStreamWebSocketFactory = {
          create: (url, priority) => {
            const delegate = remoteSocketFactoryHarness.delegate;
            return delegate === null
              ? original.create(url, priority)
              : delegate.create(url, priority);
          },
        };
        return factory;
      },
    };
  },
);

vi.mock("sonner", async (load) => {
  const actual = await load<typeof import("sonner")>();
  const callableToast = vi.fn(actual.toast);
  return { ...actual, toast: Object.assign(callableToast, actual.toast) };
});

vi.mock("@/lib/host/runtime", async (load) => {
  const actual = await load<typeof import("@/lib/host/runtime")>();
  return {
    ...actual,
    useHostBinding: () =>
      actual.useHostBinding() ?? {
        auth: { signOut: signOutRound2Harness.signOut },
      },
    useAuthService: () => ({ signOut: signOutRound2Harness.signOut }),
  };
});

const authErrorToastHarness = vi.hoisted(() => ({
  show: vi.fn<(error: unknown, fallback: string) => void>(),
}));
vi.mock("@/lib/auth-error-toast", async (load) => {
  const actual = await load<typeof import("@/lib/auth-error-toast")>();
  return {
    ...actual,
    toastFromAuthError: (error: unknown, fallback: string) => {
      authErrorToastHarness.show(error, fallback);
      actual.toastFromAuthError(error, fallback);
    },
  };
});

vi.mock("@/hooks/host/use-window-narration", async (load) => {
  const actual =
    await load<typeof import("@/hooks/host/use-window-narration")>();
  return {
    ...actual,
    useWindowNarration: () => {
      const instanceId = useRef<number | null>(null);
      if (instanceId.current === null) {
        narrationRound2Harness.nextInstanceId += 1;
        instanceId.current = narrationRound2Harness.nextInstanceId;
      }
      narrationRound2Harness.activeInstanceId = instanceId.current;
      const reading = actual.useWindowNarration();
      return narrationRound2Harness.teamMembershipRequired
        ? {
            ...reading,
            narration: {
              kind: "narrating" as const,
              cause: "no-usable-host" as const,
              variant: { kind: "team-membership-required" as const },
            },
          }
        : reading;
    },
  };
});

const hostStatus = vi.hoisted(() => ({
  data: undefined as
    | {
        readonly bootstrapMarkers: ReadonlyArray<{
          readonly timestamp: string;
          readonly phase: string;
          readonly fields: Readonly<Partial<Record<string, string>>>;
        }>;
        readonly bootstrapLogPath: string;
        readonly bootstrapLogTail: string;
      }
    | undefined,
}));

// The reader flags are DERIVED from `data`, never set beside it. The attempt
// panel (`LocalBootstrapAttempts`) refuses a cached snapshot and refuses the
// one a failed refetch retained, so it reads `isFetchedAfterMount` and
// `isSuccess` as well - and a seam that let a fixture assert `isSuccess` while
// `data` was `undefined` would be a state the real hook cannot produce, which
// is how a mock ends up testing itself. `success` means "there is a snapshot"
// here exactly as it does there. The fresh-read behaviour itself is exercised
// against the real hook in `local-bootstrap-attempts.test.tsx`; this seam is
// only about what the surfaces do with a snapshot once they legitimately have
// one.
vi.mock("@/hooks/runner/use-runner-traycer-host-status-query", () => ({
  useRunnerTraycerHostStatusQuery: () => ({
    data: hostStatus.data,
    isFetchedAfterMount: hostStatus.data !== undefined,
    isSuccess: hostStatus.data !== undefined,
  }),
}));

/**
 * The host controller's mutation lane, which is where ALL provisioning
 * narration comes from - never this renderer's own mutation observer.
 */
const controllerStatus = vi.hoisted(() => ({
  data: undefined as
    | {
        readonly mutation: {
          readonly kind: string;
          readonly progress: null;
          readonly startedAt: string;
        } | null;
      }
    | undefined,
}));

vi.mock("@/hooks/runner/use-runner-host-controller-status-query", () => ({
  useRunnerHostControllerStatusQuery: () => controllerStatus,
}));

// Pinned so the version-skew DIRECTION under test is a property of the
// fixture, not of whatever version this build happens to carry.
vi.mock("@/lib/app-version", () => ({
  getClientAppVersion: () => "1.5.0",
  getClientAppVersionLabel: () => "1.5.0",
}));

vi.mock(
  "@traycer-clients/shared/host-client/minimum-host-version",
  async (load) => {
    const actual =
      await load<
        typeof import("@traycer-clients/shared/host-client/minimum-host-version")
      >();
    return { ...actual, MINIMUM_HOST_VERSION: "2.0.0" };
  },
);

const LOCAL_HOST_ID = "local-host";
const REMOTE_HOST_ID = "remote-host";

function lease(overrides: Partial<HostLeaseSnapshot>): HostLeaseSnapshot {
  return {
    hostId: LOCAL_HOST_ID,
    status: "connecting",
    dead: null,
    ...overrides,
  } as HostLeaseSnapshot;
}

function deadLease(
  hostId: string,
  dead: HostLeaseSnapshot["dead"],
): HostLeaseSnapshot {
  return { hostId, status: "dead", dead } as HostLeaseSnapshot;
}

const EMPTY_PRESENTATION: DefaultHostReadinessPresentation = {
  targetKind: "unknown",
  localBootIntent: false,
  localHostState: "unknown",
  stage: "loading",
  progress: null,
  lastProgress: null,
  provisioningError: null,
  ensureFailure: null,
  provisioning: false,
  removed: false,
  hostBusy: false,
  canManageHost: false,
  retryProvisioning: () => undefined,
  forceProvisioning: () => undefined,
  reinstall: () => undefined,
  configureShell: () => undefined,
  refreshDirectory: () => undefined,
  openSettings: () => undefined,
  compatibility: {
    status: "compatible",
    degraded: false,
    unreachable: false,
    hostStatus: null,
  },
};

function controllerFor(
  presentation: DefaultHostReadinessPresentation,
  readiness: SurfaceReadiness,
): HostReadinessController {
  return {
    readinessFor: () => readiness,
    defaultHostPresentation: presentation,
    hasBeenDefaultHostReady: false,
  };
}

/**
 * The gate is OPEN: an app is mounted behind the narrator.
 *
 * `ready` makes `gateBlocksApp` false, which is what selects the narrator's
 * DIALOG presentation - the blocking form, correct only when there is a live
 * app the ∅ verdict has to stop the user driving.
 */
const GATE_OPEN: SurfaceReadiness = { kind: "ready" };

/**
 * The gate is BLOCKING: a launch, with no app behind the narrator yet.
 *
 * A narrator-owned kind, so the gate draws no card of its own and hands the
 * words over - which selects the narrator's CARD presentation. This is the
 * state every cold-start fixture below is describing, and modelling it as
 * `ready` would have them assert the launch's action precedence against the
 * post-latch surface instead.
 */
const GATE_BLOCKING: SurfaceReadiness = { kind: "loading-host" };

/**
 * The narrator's surface, whichever presentation it chose.
 *
 * For fixtures whose subject is WHETHER the narrator speaks - the served
 * latch, the ∅ re-open - rather than which form it takes. Naming one testid
 * there would couple a latch test to a presentation rule and, worse, let it
 * pass vacuously the day the other form is the one that renders.
 */
function narratorSurface(): HTMLElement | null {
  return (
    screen.queryByTestId("window-host-modal") ??
    screen.queryByTestId("window-host-startup-card")
  );
}

function applySnapshot(overrides: Partial<SelectionKernelSnapshot>): void {
  const snapshot: SelectionKernelSnapshot = {
    attached: true,
    preferredHostId: null,
    targetHostId: null,
    effectiveHostId: null,
    leases: [],
    selectionRevision: 1,
    ...overrides,
  };
  act(() => {
    useSelectionAuthorityStore.getState().applyKernelSnapshot(snapshot);
  });
}

function renderHost(
  presentation: DefaultHostReadinessPresentation,
  bypassed: boolean,
  // Required, not optional (`fn(x?: T)` is banned): every call site states
  // what it wants rather than inheriting a default that could drift. `undefined`
  // preserves the prior no-CLI shell for every existing fixture; only the
  // fixtures that specifically assert the bootstrap-log toggle pass a real one
  // - see `local-host-loading.test.tsx`'s own positive/negative control pair
  // for why a no-CLI shell can never prove that toggle's presence.
  traycerCli: ITraycerCli | null | undefined,
) {
  return renderHostWithGate(presentation, bypassed, traycerCli, GATE_OPEN);
}

function buttonsOf(surface: HTMLElement): readonly (string | null)[] {
  return within(surface)
    .getAllByRole("button")
    .map((button) => button.textContent);
}

/**
 * `renderHost` with the gate state stated explicitly. Used by the cold-start
 * fixtures, which are describing a LAUNCH and therefore need the blocking gate
 * (see {@link GATE_BLOCKING}).
 */
function renderHostWithGate(
  presentation: DefaultHostReadinessPresentation,
  bypassed: boolean,
  traycerCli: ITraycerCli | null | undefined,
  readiness: SurfaceReadiness,
) {
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli,
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rendered = render(
    <QueryClientProvider client={client}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostReadinessControllerContext.Provider
          value={controllerFor(presentation, readiness)}
        >
          <WindowHostModalHost bypassed={bypassed} />
        </HostReadinessControllerContext.Provider>
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return { ...rendered, runnerHost };
}

interface ModalHostRuntimeFixture {
  readonly auth: AuthService;
  readonly binding: HostRuntimeBinding<HostRpcRegistry>;
  readonly directory: HostDirectoryService;
  readonly rows: { current: readonly RemoteHostDirectoryEntry[] };
  readonly runnerHost: MockRunnerHost;
  readonly runtime: HostRuntime<HostRpcRegistry>;
}

type HostPolicyFetchMode = "normal" | "fail-update";

const modalHostRuntimeFixtures: ModalHostRuntimeFixture[] = [];
const runtimeFetchRestorers: Array<() => void> = [];
let hostPolicyPatchCalls = 0;

function remoteHostEntry(
  appVersion: string,
  updateState: "current" | "pending",
): RemoteHostDirectoryEntry {
  const entry = remoteEntry(REMOTE_HOST_ID, null);
  return {
    ...entry,
    version: "9.9.9",
    remoteStatus: {
      ...entry.remoteStatus,
      appVersion,
      updateState,
    },
  };
}

function installRuntimeFetch(mode: HostPolicyFetchMode): void {
  const restoreValidation = installAuthValidationFetch();
  runtimeFetchRestorers.push(restoreValidation);
  if (mode === "normal") return;

  const validationFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: (input: RequestInfo | URL, init: RequestInit | undefined) => {
      let url: string;
      if (typeof input === "string") {
        url = input;
      } else if (input instanceof URL) {
        url = input.toString();
      } else {
        url = input.url;
      }
      if (
        init?.method === "PATCH" &&
        url.includes(`/api/v3/hosts/${REMOTE_HOST_ID}`)
      ) {
        hostPolicyPatchCalls += 1;
        return Promise.resolve(new Response(null, { status: 500 }));
      }
      return validationFetch(input, init);
    },
  });
}

/** A runtime over `messenger`, on the fixture's own account, directory and runner host. */
function runtimeOver(
  parts: Pick<ModalHostRuntimeFixture, "auth" | "directory" | "runnerHost">,
  messenger: IHostMessenger<HostRpcRegistry>,
): HostRuntime<HostRpcRegistry> {
  const { auth, directory, runnerHost } = parts;
  return new HostRuntime<HostRpcRegistry>({
    runnerHost,
    onHostTokenRenewal: () => undefined,
    registry: hostRpcRegistry,
    messenger,
    singleAttemptMessenger: null,
    requestContextProvider: auth.getRequestContextProvider(),
    directory,
    invalidator: createHostQueryInvalidator(
      new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    ),
    schedulingPolicy: hostRpcSchedulingPolicy,
    connectionRegistry: null,
    authorityRegistry: null,
    requestCoordinator: null,
    selectedHostId: () => null,
  });
}

async function createModalHostRuntimeFixture(
  entry: RemoteHostDirectoryEntry,
  fetchMode: HostPolicyFetchMode,
): Promise<ModalHostRuntimeFixture> {
  installRuntimeFetch(fetchMode);
  const rows: ModalHostRuntimeFixture["rows"] = { current: [entry] };
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: false,
    traycerCli: undefined,
  });
  const auth = new AuthService({ runnerHost });
  await runnerHost.tokenStore.signIn(
    { token: "user-token", refreshToken: "user-token-refresh" },
    { id: "user-1", email: "test@example.com", name: "Test User" },
  );
  await auth.start();

  const directory = new HostDirectoryService({
    runnerHost,
    remoteFetcher: () =>
      Promise.resolve({ kind: "hosts", entries: rows.current }),
    onRegistryPollTick: null,
    authContextId: () => "user-1",
    credentialGeneration: () => 0,
    localHostIdSeeder: () => Promise.resolve(null),
  });
  await directory.start();
  await directory.refresh();

  let requestSeq = 0;
  const runtime = runtimeOver(
    { auth, directory, runnerHost },
    new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `modal-host-${++requestSeq}`,
      handlers: {},
    }),
  );
  const fixture: ModalHostRuntimeFixture = {
    auth,
    binding: {
      runtime,
      hostClient: runtime.hostClient,
      directory,
      auth,
      hostId: null,
    },
    directory,
    rows,
    runnerHost,
    runtime,
  };
  modalHostRuntimeFixtures.push(fixture);
  return fixture;
}

function renderHostWithRuntime(
  fixture: ModalHostRuntimeFixture,
  presentation: DefaultHostReadinessPresentation,
  bypassed: boolean,
  readiness: SurfaceReadiness,
): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={fixture.runnerHost}>
        <HostRuntimeContext.Provider value={fixture.binding}>
          <HostReadinessControllerContext.Provider
            value={controllerFor(presentation, readiness)}
          >
            <WindowHostModalHost bypassed={bypassed} />
          </HostReadinessControllerContext.Provider>
        </HostRuntimeContext.Provider>
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

/** A count of one event, awaited by its ordinal: no wait runs on a clock. */
interface Milestones {
  readonly count: () => number;
  readonly reach: () => void;
  readonly nth: (ordinal: number) => Promise<void>;
}

function milestones(): Milestones {
  let reached = 0;
  const waiters = new Map<number, PromiseWithResolvers<void>>();
  const waiterFor = (ordinal: number): PromiseWithResolvers<void> => {
    const waiter = waiters.get(ordinal) ?? Promise.withResolvers<void>();
    waiters.set(ordinal, waiter);
    return waiter;
  };
  return {
    count: () => reached,
    reach: () => {
      reached += 1;
      waiterFor(reached).resolve();
    },
    nth: (ordinal) => waiterFor(ordinal).promise,
  };
}

/** A surface that shows the nobody-signed-in state and holds its computer's session. */
function HoldProbe(props: { readonly hostId: string }): ReactNode {
  useHoldNobodySignedInSession(props.hostId);
  return null;
}

/**
 * What the session reports of each dial of `hostId`. A loss it has handled has
 * armed its next dial: the redial is armed before the evidence of the loss is
 * reported, so the instant is exact and no turn count stands in for it.
 */
function watchDials(hostId: string): {
  readonly lost: Milestones;
  readonly admitted: Milestones;
} {
  const lost = milestones();
  const admitted = milestones();
  const watch = (
    report:
      | "reportDialRefusal"
      | "reportDialIndeterminate"
      | "reportDialSuccess",
    milestone: Milestones,
  ): void => {
    const original = transportEvidenceRelay[report].bind(
      transportEvidenceRelay,
    );
    const spy = vi
      .spyOn(transportEvidenceRelay, report)
      .mockImplementation((reportedHostId, attemptId, transportKind) => {
        original(reportedHostId, attemptId, transportKind);
        if (reportedHostId === hostId) milestone.reach();
      });
    onTestFinished(() => {
      spy.mockRestore();
    });
  };
  watch("reportDialRefusal", lost);
  watch("reportDialIndeterminate", lost);
  watch("reportDialSuccess", admitted);
  return { lost, admitted };
}

/**
 * Waits for `event` without moving the fake clock: only timers already due run
 * (the mux writes its frames on them), and each turn lets the real crypto
 * behind the Noise transport finish. `ended` stops a case that gave up.
 */
async function reachedOnThisInstant(
  event: Promise<unknown>,
  ended: AbortSignal,
): Promise<void> {
  const wait: { reached: boolean } = { reached: false };
  void event.then(() => {
    wait.reached = true;
  });
  await turnsUntil(() => wait.reached, ended);
}

/** The same turns, until `done` holds: the clock does not move. */
async function turnsUntil(
  done: () => boolean,
  ended: AbortSignal,
): Promise<void> {
  while (!done() && !ended.aborted) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    });
  }
}

interface StreamOwnerLog {
  /** When the owner was handed each client it built. */
  readonly builtAt: number[];
  /** When each of those clients closed underneath it. */
  readonly closedAt: number[];
  readonly closeReasons: Array<StreamCloseReason | null>;
  readonly opened: Milestones;
  readonly closed: Milestones;
}

/** A tile's use of one computer's stream: the app's owner, which rebuilds a closed client. */
function StreamOwner(props: {
  readonly target: RemoteHostDirectoryEntry;
  readonly auth: StreamAuthRevalidator;
  readonly log: StreamOwnerLog;
}): ReactNode {
  const { log } = props;
  const client =
    useHostStreamClientBindingFor(props.target, props.auth)?.client ?? null;
  useEffect(() => {
    if (client === null) return;
    log.builtAt.push(Date.now());
    const stopHearingClose = client.onClosed(() => {
      log.closedAt.push(Date.now());
      log.closed.reach();
    });
    // The session's ready boundary: an open the host admitted.
    const stopHearingReady = client.subscribeAvailabilityRecovered(() => {
      log.opened.reach();
    });
    const stream = client.subscribe("epic.subscribe", { epicId: "epic-a" });
    stream.onStatusChange((status, reason) => {
      if (status === "closed") log.closeReasons.push(reason);
    });
    return () => {
      stopHearingReady();
      stopHearingClose();
      stream.close();
    };
  }, [client, log]);
  return null;
}

const BOOTSTRAP_MARKERS = {
  bootstrapMarkers: [
    {
      timestamp: "t0",
      phase: "starting",
      fields: { shell: "/bin/zsh", args: "-i -l -c traycer" },
    },
    { timestamp: "t1", phase: "crashed", fields: { code: "1" } },
  ],
  bootstrapLogPath: "/Users/me/.traycer/bootstrap.log",
  bootstrapLogTail: "",
};

beforeEach(() => {
  remoteSocketFactoryHarness.delegate = null;
  vi.mocked(toast).mockClear();
  hostStatus.data = undefined;
  controllerStatus.data = undefined;
  authErrorToastHarness.show.mockReset();
  hostPolicyPatchCalls = 0;
  // `ReportIssueAction` gates on this store, defaulting to `false` - so every
  // fixture that checks Report issue's PRESENCE needs it true first, or the
  // absence would be satisfied by the store gate rather than by
  // `showReportIssue`. Fixtures asserting Report issue's ABSENCE stay
  // meaningful either way, since they are asserting the more restrictive of
  // two independently-sufficient gates.
  useDesktopDialogStore.getState().setReportIssueAvailable(true);
  signOutRound2Harness.signOut.mockReset();
  signOutRound2Harness.signOut.mockResolvedValue(false);
  narrationRound2Harness.teamMembershipRequired = false;
  narrationRound2Harness.nextInstanceId = 0;
  narrationRound2Harness.activeInstanceId = 0;
  useSignOutConfirmStore.getState().setOpen(false);
  // SIGNED IN, because production is: this component is mounted only for a
  // signed-in user (`useWindowNarration`'s latch doc leans on exactly that -
  // signing out unmounts it). It matters now that the narrator picks its
  // presentation from `gateBlocksApp`, whose first clause is `signedIn` - a
  // signed-out harness reports "the gate is not blocking", i.e. models a
  // window with a mounted app behind it, which is the opposite of the launch
  // every cold-start fixture below is describing.
  //
  // Only `status` is set: it is the sole field this tree reads, and the
  // store's profile invariant is about surfaces none of these fixtures mount.
  useAuthStore.setState({ status: "signed-in" });
});

afterEach(() => {
  remoteSocketFactoryHarness.delegate = null;
  retireAllRemoteSessions();
  for (const socket of FakeNativeWebSocket.instances) {
    socket.fireClose(1006, "test teardown");
  }
  FakeNativeWebSocket.instances.length = 0;
  vi.unstubAllGlobals();
  cleanup();
  for (const fixture of modalHostRuntimeFixtures.splice(0)) {
    fixture.runtime.dispose();
    fixture.directory.dispose();
    fixture.auth.dispose();
  }
  for (const restoreFetch of runtimeFetchRestorers.splice(0)) {
    restoreFetch();
  }
  useSelectionAuthorityStore.getState().reset();
  useHostDoorStateStore.setState({ byHost: new Map() });
  useDesktopDialogStore.getState().setReportIssueAvailable(false);
  useAuthStore.setState({ status: "signed-out", contextMetadata: null });
  vi.restoreAllMocks();
  useSignOutConfirmStore.getState().setOpen(false);
  setMobileApp(false);
});

describe("<WindowHostModalHost />", () => {
  it("opens the shared sign-out question when Switch account cannot delete credentials", async () => {
    narrationRound2Harness.teamMembershipRequired = true;
    const runnerHost = new MockRunnerHost({
      signInUrl: "https://auth.traycer.invalid/sign-in",
      authnBaseUrl: "http://localhost:5005",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
    });
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    render(
      <QueryClientProvider client={client}>
        <RunnerHostProvider runnerHost={runnerHost}>
          <HostReadinessControllerContext.Provider
            value={controllerFor(EMPTY_PRESENTATION, GATE_OPEN)}
          >
            <>
              <WindowHostModalHost bypassed={false} />
              <SignOutConfirmDialog />
            </>
          </HostReadinessControllerContext.Provider>
        </RunnerHostProvider>
      </QueryClientProvider>,
    );

    expect(screen.getByText("This computer belongs to a team")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Switch account" }));

    const alert = await screen.findByRole("alert");
    expect(signOutRound2Harness.signOut).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("confirm-destructive-dialog")).toBeTruthy();
    expect(alert.textContent).toBe("Couldn't sign out. Please try again.");
    expect(screen.queryByText("This computer belongs to a team")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("This computer belongs to a team")).toBeTruthy();
  });

  const NOT_PROVISIONED_HOST_SENTENCE =
    "Host is not provisioned - run `traycer login` on the host machine to authorize it";
  const HOST_ONLY_TOKEN = "host-only-token";
  const SIGN_IN_TOKEN_OF_PERSON = "sign-in-token";
  const bareRefusalFrame = JSON.stringify({
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason: "refused at the host door",
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  });

  /** A rendered local stream whose first socket has written its open with the host-only token. */
  async function openLocalStreamOnHostOnlyToken(
    hostId: string,
    owner: {
      readonly kind: "team";
      readonly id: string;
      readonly name: string;
    } | null,
  ): Promise<{
    readonly socket: FakeNativeWebSocket;
    readonly hostTokens: HostTokenSource;
    readonly mintCalls: () => number;
    readonly signInRecoveryCalls: () => number;
    readonly close: () => void;
  }> {
    let mintCalls = 0;
    let signInRecoveryCalls = 0;
    clearHostDoorState(hostId);
    vi.stubGlobal("WebSocket", FakeNativeWebSocket);
    FakeNativeWebSocket.instances.length = 0;

    const provider = newProvider();
    signIn(provider, USER_A, SIGN_IN_TOKEN_OF_PERSON);
    const hostTokens = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () => {
        mintCalls += 1;
        return Promise.resolve({ kind: "no-sign-in" });
      },
      signIn: null,
      now: () => Date.now(),
    });
    await hostTokens.adopt(
      USER_A,
      hostId,
      {
        token: HOST_ONLY_TOKEN,
        expiresAtMs: Date.now() + 3_600_000,
      },
      hostTokens.era(USER_A),
      () => true,
    );
    const target = { ...mockLocalHostEntry, hostId, version: null, owner };
    const client = buildHostStreamClient({
      target,
      endpoint: () =>
        target.websocketUrl === null
          ? null
          : { hostId, websocketUrl: target.websocketUrl },
      bearer: liveBearer(provider),
      cloudAuthorized: () => true,
      authnBaseUrl: "https://authn.test",
      auth: {
        revalidateForReconnect: () => {
          signInRecoveryCalls += 1;
          return Promise.resolve("rejected");
        },
      },
      hostTokens,
      userId: USER_A,
      proactiveWakeEligible: false,
      autoStart: false,
      watchHostTokens: true,
    });
    if (client === null) throw new Error("local stream client did not build");
    const session = client.subscribe("epic.subscribe", { epicId: "epic-a" });
    applySnapshot({ targetHostId: hostId });
    renderHost(EMPTY_PRESENTATION, false, undefined);
    await waitFor(() => expect(FakeNativeWebSocket.instances).toHaveLength(1));
    const socket = FakeNativeWebSocket.instances.at(0);
    if (socket === undefined) throw new Error("host socket missing");
    socket.fireOpen();
    await waitFor(() =>
      expect(sentFramesOfKind(socket, "open")).toHaveLength(1),
    );
    const open = sentFramesOfKind(socket, "open").at(0);
    if (open === undefined) throw new Error("host open frame missing");
    expect(open.token).toBe(HOST_ONLY_TOKEN);
    expect(JSON.stringify(open)).not.toContain(SIGN_IN_TOKEN_OF_PERSON);
    return {
      socket,
      hostTokens,
      mintCalls: () => mintCalls,
      signInRecoveryCalls: () => signInRecoveryCalls,
      close: () => {
        session.close();
        client.close("test complete");
        clearHostDoorState(hostId);
      },
    };
  }

  interface RemoteDoorCase {
    readonly doorReason: FatalErrorDetails["doorReason"];
    readonly code: FatalErrorDetails["code"];
    readonly retryable: boolean;
    readonly state: HostDoorStateKind;
    readonly coverTitle: string;
    readonly coverLine: string;
  }

  const NOBODY_SIGNED_IN_CASE = {
    doorReason: "not_provisioned",
    code: "UNAUTHORIZED",
    retryable: true,
    state: "nobody-signed-in",
    coverTitle: "Nobody is signed in on this computer",
    coverLine: "Sign in on it to use it from here.",
  } as const satisfies RemoteDoorCase;

  const HOST_CLAIMED_CASE = {
    doorReason: "host_claimed",
    code: "UNAUTHORIZED",
    retryable: false,
    state: "host-claimed",
    // Its own cover waits for who claimed the computer.
    coverTitle: "No host is available",
    coverLine:
      "Traycer can't reach any of this account's hosts right now. It will connect again on its own as soon as one comes back.",
  } as const satisfies RemoteDoorCase;

  function remoteDoorRefusal(doorCase: RemoteDoorCase): FatalErrorDetails {
    return {
      code: doorCase.code,
      reason: NOT_PROVISIONED_HOST_SENTENCE,
      retryable: doorCase.retryable,
      doorReason: doorCase.doorReason,
      incompatibleMethods: null,
      upgradeGuidance: null,
    };
  }

  /**
   * One remote computer with a peer behind it, a runtime that can address it,
   * and a fake clock. Nothing dials it until a consumer is mounted.
   */
  async function startRemoteHost() {
    const hostId = REMOTE_HOST_ID;
    const peer = new RemoteMuxTestPeer();
    const entry: RemoteHostDirectoryEntry = {
      ...remoteHostEntry(MINIMUM_HOST_VERSION, "current"),
      publicKey: peer.hostPublicKey,
      websocketUrl: "wss://relay.test/attach",
    };
    const fixture = await createModalHostRuntimeFixture(entry, "normal");
    fixture.runtime.hostClient.setRequestContext(
      fixture.auth.getRequestContextProvider().current(),
    );
    const { hostTokens } = fixture.runnerHost;
    await hostTokens.adopt(
      "user-1",
      hostId,
      { token: "host-only-token", expiresAtMs: Date.now() + 3_600_000 },
      hostTokens.era("user-1"),
      () => true,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              grant: "relay-pass",
              role: "client",
              expires_in: 300,
              session_grant: "relay-session-grant",
              session_grant_expires_in: 300,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
      ),
    );
    const dialed = milestones();
    const dialedAt: number[] = [];
    remoteSocketFactoryHarness.delegate = {
      create: (url, priority) => {
        dialedAt.push(Date.now());
        dialed.reach();
        return peer.factory.create(url, priority);
      },
    };
    const { lost, admitted } = watchDials(hostId);
    const ended = new AbortController();
    onTestFinished(() => {
      ended.abort();
      cleanup();
      resetHostStreamClientCacheForTest();
      retireAllRemoteSessions();
      clearHostDoorState(hostId);
      vi.useRealTimers();
    });
    // `setImmediate` stays real: `reachedOnThisInstant` takes its turns on it.
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "Date",
      ],
    });
    const reached = (event: Promise<unknown>): Promise<void> =>
      reachedOnThisInstant(event, ended.signal);
    const until = (done: () => boolean): Promise<void> =>
      turnsUntil(done, ended.signal);
    return {
      hostId,
      peer,
      entry,
      fixture,
      dialed,
      dialedAt,
      lost,
      admitted,
      reached,
      until,
    };
  }

  /**
   * The window targets one remote computer and a tile's stream dials it.
   * `openRefusals` answer that computer's first opens, in order.
   */
  async function startRemoteTileStream(
    openRefusals: readonly FatalErrorDetails[],
  ) {
    const { hostId, peer, entry, fixture, dialed, dialedAt, lost, reached } =
      await startRemoteHost();
    const signInRecovery = vi.fn(() => Promise.resolve("rotated" as const));
    const log: StreamOwnerLog = {
      builtAt: [],
      closedAt: [],
      closeReasons: [],
      opened: milestones(),
      closed: milestones(),
    };

    peer.refuseNextOpens(openRefusals);
    applySnapshot({ targetHostId: hostId });
    renderHostWithRuntime(
      fixture,
      {
        ...EMPTY_PRESENTATION,
        targetKind: "remote",
        canManageHost: true,
        provisioningError: new Error("install failed"),
      },
      false,
      GATE_OPEN,
    );
    render(
      <RunnerHostProvider runnerHost={fixture.runnerHost}>
        <HostRuntimeContext.Provider value={fixture.binding}>
          <StreamOwner
            target={entry}
            auth={{ revalidateForReconnect: signInRecovery }}
            log={log}
          />
        </HostRuntimeContext.Provider>
      </RunnerHostProvider>,
    );
    const surface = (): HTMLElement => screen.getByTestId("window-host-modal");
    const expectRefusedCover = (doorCase: RemoteDoorCase): void => {
      expect(hostDoorStateFor(hostId)?.kind).toBe(doorCase.state);
      expect(
        within(surface()).getByTestId("window-host-modal-title").textContent,
      ).toBe(doorCase.coverTitle);
      expect(within(surface()).getByText(doorCase.coverLine)).toBeTruthy();
      expect(document.body.textContent).not.toContain("traycer login");
    };

    return {
      hostId,
      peer,
      fixture,
      dialed,
      dialedAt,
      signInRecovery,
      log,
      lost,
      reached,
      surface,
      expectRefusedCover,
    };
  }

  it("records nobody-signed-in from a refused first open alone and draws its cover", async () => {
    const {
      peer,
      signInRecovery,
      log,
      lost,
      reached,
      surface,
      expectRefusedCover,
    } = await startRemoteTileStream([remoteDoorRefusal(NOBODY_SIGNED_IN_CASE)]);

    await reached(lost.nth(1));

    // The computer has answered one open, with the refusal, and admitted none.
    expect(peer.openCount).toBe(1);
    expect(log.opened.count()).toBe(0);
    expectRefusedCover(NOBODY_SIGNED_IN_CASE);
    // No Retry, though this presentation has one to offer.
    expect(buttonsOf(surface())).toEqual(["Open settings"]);
    expect(signInRecovery).not.toHaveBeenCalled();
    expect(peer.errors).toEqual([]);
  });

  it("keeps one session dialing on its ladder while nobody is signed in on a remote computer, and drops the state when an open is admitted", async () => {
    const refusal = remoteDoorRefusal(NOBODY_SIGNED_IN_CASE);
    const {
      hostId,
      peer,
      dialed,
      signInRecovery,
      log,
      lost,
      reached,
      surface,
      expectRefusedCover,
    } = await startRemoteTileStream([]);

    await reached(log.opened.nth(1));
    expect(hostDoorStateFor(hostId)).toBeNull();
    const titleBeforeRefusal = within(surface()).getByTestId(
      "window-host-modal-title",
    ).textContent;

    // The host ends the connection it admitted at its recheck, refuses the
    // next three opens, then admits one. Nobody presses anything.
    peer.refuseNextOpens([refusal, refusal, refusal]);
    await peer.sendSessionFatal(refusal);
    // The session's own redial is the next dial, at once; no owner rebuilds.
    await reached(dialed.nth(2));
    expect(log.builtAt).toHaveLength(1);

    // The first redial after an admitted loss is at once. Each one after it
    // waits its rung, 1s then double, with equal jitter: within [half, whole].
    const rungsMs = [0, 1_000, 2_000, 4_000];
    for (const [index, rungMs] of rungsMs.entries()) {
      await reached(lost.nth(index + 1));
      expectRefusedCover(NOBODY_SIGNED_IN_CASE);
      // No Retry, though this presentation has one to offer.
      expect(buttonsOf(surface())).toEqual(["Open settings"]);
      if (rungMs > 0) {
        expect(dialed.count()).toBe(index + 1);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(rungMs / 2 - 1);
        });
        expect(dialed.count()).toBe(index + 1);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(rungMs / 2 + 1);
        });
      }
      await reached(dialed.nth(index + 2));
      expect(dialed.count()).toBe(index + 2);
      // The one session redials; its owner never rebuilds the client.
      expect(log.builtAt).toHaveLength(1);
    }
    await reached(log.opened.nth(2));

    expect(hostDoorStateFor(hostId)).toBeNull();
    expect(
      within(surface()).getByTestId("window-host-modal-title").textContent,
    ).toBe(titleBeforeRefusal);
    expect(peer.openCount).toBe(5);
    expect(peer.errors).toEqual([]);
    expect(log.closed.count()).toBe(0);
    expect(signInRecovery).not.toHaveBeenCalled();
  });

  const ELSEWHERE_HOST_ID = "host-elsewhere";

  /** The window's runtime messenger, built as the app builds it. */
  function windowMessenger(fixture: ModalHostRuntimeFixture) {
    const binding = buildRuntimeHostMessenger({
      registry: hostRpcRegistry,
      resolveTarget: (id) => fixture.directory.findById(id),
      confirmRowBeforeSignIn: () => Promise.resolve(true),
      auth: { revalidateForReconnect: () => Promise.resolve("rejected") },
      authnBaseUrl: fixture.runnerHost.authnBaseUrl,
      hostTokens: fixture.runnerHost.hostTokens,
      requestId: () => "tile-read",
      onRemoteAvailabilityRecovered: () => undefined,
      onRemoteSessionTerminal: () => undefined,
    });
    onTestFinished(() => {
      binding.dispose();
      binding.dispose();
    });
    return binding.messenger;
  }

  /** One unary read through the window's runtime messenger, sent to a computer. */
  function messengerReads(fixture: ModalHostRuntimeFixture) {
    const bearer = fixture.runtime.hostClient.getRequestContext()?.credentials;
    if (bearer === undefined) throw new Error("the runtime has no credentials");
    const messenger = windowMessenger(fixture);
    return (hostId: string, websocketUrl: string): void => {
      void messenger
        .request(
          "host.status",
          {},
          {
            idempotencyKey: null,
            replayMustBeKeyed: false,
            requiredHostMethodVersion: null,
            authority: {
              endpoint: { hostId, websocketUrl },
              bearer,
              abortSignal: new AbortController().signal,
            },
          },
        )
        .catch(() => undefined);
    };
  }

  /** The fixture's account and computers behind `messenger`, with its credentials set. */
  function bindingOver(
    fixture: ModalHostRuntimeFixture,
    messenger: IHostMessenger<HostRpcRegistry>,
  ): HostRuntimeBinding<HostRpcRegistry> {
    const runtime = runtimeOver(fixture, messenger);
    runtime.hostClient.setRequestContext(
      fixture.auth.getRequestContextProvider().current(),
    );
    return { ...fixture.binding, runtime, hostClient: runtime.hostClient };
  }

  /** `useHostReadRefusal` as Settings mounts it, over `binding`, with its own query cache. */
  function renderReadRefusal(
    fixture: ModalHostRuntimeFixture,
    binding: HostRuntimeBinding<HostRpcRegistry>,
    hostId: string,
  ) {
    const queryClient = new QueryClient();
    return renderHook(() => useHostReadRefusal(hostId), {
      wrapper: ({ children }: { readonly children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          <RunnerHostProvider runnerHost={fixture.runnerHost}>
            <HostRuntimeContext.Provider value={binding}>
              {children}
            </HostRuntimeContext.Provider>
          </RunnerHostProvider>
        </QueryClientProvider>
      ),
    });
  }

  /** The turns an operation needs to reach the wire, with the clock still. */
  const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 25; turn += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      });
    }
  };

  function inRuntime(fixture: ModalHostRuntimeFixture, children: ReactNode) {
    return (
      <QueryClientProvider client={new QueryClient()}>
        <RunnerHostProvider runnerHost={fixture.runnerHost}>
          <HostRuntimeContext.Provider value={fixture.binding}>
            {children}
          </HostRuntimeContext.Provider>
        </RunnerHostProvider>
      </QueryClientProvider>
    );
  }

  /** The sessions the cache builds and closes for real, counted without replacing them. */
  function watchSessions() {
    const started = vi.spyOn(RemoteSession.prototype, "start");
    const closed = vi.spyOn(RemoteSession.prototype, "close");
    onTestFinished(() => {
      started.mockRestore();
      closed.mockRestore();
    });
    return {
      closed,
      startedCount: () => new Set(started.mock.contexts).size,
    };
  }

  const advance = (ms: number): Promise<void> =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });

  it("keeps the session that raised nobody-signed-in dialing on its ladder after the window's reads move to another computer, and drops the state when an open is admitted", async () => {
    const { hostId, peer, entry, fixture, dialed, lost, admitted, reached } =
      await startRemoteHost();
    peer.refuseEveryOpen = remoteDoorRefusal(NOBODY_SIGNED_IN_CASE);
    const sessions = watchSessions();
    vi.stubGlobal("WebSocket", FakeNativeWebSocket);
    applySnapshot({ targetHostId: ELSEWHERE_HOST_ID });
    render(
      inRuntime(
        fixture,
        <TabHostContext.Provider value={hostId}>
          <SandboxTileStateFrame chat={null}>
            <p>tile</p>
          </SandboxTileStateFrame>
        </TabHostContext.Provider>,
      ),
    );
    const read = messengerReads(fixture);

    read(hostId, entry.websocketUrl ?? "");
    await reached(lost.nth(1));
    expect(hostDoorStateFor(hostId)?.kind).toBe("nobody-signed-in");
    expect(screen.getByTestId("tile-door-cover")).toBeTruthy();
    expect(sessions.startedCount()).toBe(1);

    // The window reads another computer: the messenger's one host slot gives
    // this computer's binding up, and the tile's hold is what is left on it.
    read(ELSEWHERE_HOST_ID, "ws://elsewhere.test/rpc");

    // Past the linger an unheld session would close. This one dials each rung
    // inside its jitter window, from the one session.
    let loss = 1;
    for (
      let waitedMs = 0;
      waitedMs < REMOTE_SESSION_LINGER_MS + 30_000;
      loss += 1
    ) {
      await reached(lost.nth(loss));
      const rungMs = Math.min(1_000 * 2 ** (loss - 1), 30_000);
      expect(dialed.count()).toBe(loss);
      await advance(rungMs / 2 - 1);
      expect(dialed.count()).toBe(loss);
      await advance(rungMs / 2 + 1);
      expect(sessions.closed).not.toHaveBeenCalled();
      await reached(dialed.nth(loss + 1));
      waitedMs += rungMs;
    }

    await reached(lost.nth(loss));
    peer.refuseEveryOpen = null;
    await advance(Math.min(1_000 * 2 ** (loss - 1), 30_000));
    await reached(admitted.nth(1));

    expect(hostDoorStateFor(hostId)).toBeNull();
    expect(screen.queryByTestId("tile-door-cover")).toBeNull();
    expect(sessions.startedCount()).toBe(1);
    expect(sessions.closed).not.toHaveBeenCalled();
  });

  it.each(["the surface unmounts", "the state clears"] as const)(
    "lets go of the held session when %s, and the session closes after its linger",
    async (release) => {
      const { hostId, peer, fixture, lost, admitted, reached } =
        await startRemoteHost();
      const refusal = remoteDoorRefusal(NOBODY_SIGNED_IN_CASE);
      peer.refuseEveryOpen = refusal;
      const sessions = watchSessions();
      appHostDoorObserver(hostId).refused(refusal);
      const held = render(inRuntime(fixture, <HoldProbe hostId={hostId} />));
      await reached(lost.nth(1));
      expect(sessions.startedCount()).toBe(1);

      if (release === "the surface unmounts") {
        held.unmount();
      } else {
        peer.refuseEveryOpen = null;
        await advance(1_000);
        await reached(admitted.nth(1));
        expect(hostDoorStateFor(hostId)).toBeNull();
      }
      await advance(REMOTE_SESSION_LINGER_MS - 1);
      expect(sessions.closed).not.toHaveBeenCalled();
      await advance(1);

      expect(sessions.closed).toHaveBeenCalledTimes(1);
    },
  );

  it("holds the session the window's own stream already dials, and builds no second one", async () => {
    const sessions = watchSessions();
    const { hostId, fixture, dialed, lost, reached } =
      await startRemoteTileStream([remoteDoorRefusal(NOBODY_SIGNED_IN_CASE)]);
    await reached(lost.nth(1));
    expect(hostDoorStateFor(hostId)?.kind).toBe("nobody-signed-in");
    expect(sessions.startedCount()).toBe(1);

    render(inRuntime(fixture, <HoldProbe hostId={hostId} />));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    });

    expect(sessions.startedCount()).toBe(1);
    expect(dialed.count()).toBe(1);
  });

  it.each(["never built", "closed after its linger"] as const)(
    "makes one attempt on a computer refused for good when Try again is pressed, with its session %s",
    async (history) => {
      const { hostId, peer, fixture, dialed, until } = await startRemoteHost();
      const refusal = remoteDoorRefusal(HOST_CLAIMED_CASE);
      peer.refuseEveryOpen = refusal;
      const messenger = windowMessenger(fixture);
      const requested = vi.spyOn(messenger, "request");
      const statusReads = (): number =>
        requested.mock.calls.filter(
          ([method]) => method === "environment.status",
        ).length;
      const binding = bindingOver(fixture, messenger);
      const hook = renderReadRefusal(fixture, binding, hostId);

      if (history === "never built") {
        act(() => {
          appHostDoorObserver(hostId).refused(refusal);
        });
      } else {
        void binding.hostClient
          .createRequesterForHostId(hostId)
          .requestWithSignal(
            "environment.status",
            {},
            new AbortController().signal,
          )
          .catch(() => undefined);
        await until(() => hostDoorStateFor(hostId)?.kind === "host-claimed");
        await advance(REMOTE_SESSION_LINGER_MS + 1);
      }
      expect(hook.result.current.refused).toBe(true);
      const dialsBefore = dialed.count();
      const opensBefore = peer.openCount;
      const readsBefore = statusReads();

      act(() => {
        hook.result.current.retryStatus();
      });
      await settle();

      expect(dialed.count() - dialsBefore).toBe(1);
      expect(peer.openCount - opensBefore).toBe(1);
      expect(statusReads() - readsBefore).toBe(1);
    },
  );

  it("redials the session its tile holds, once and at the press, when Try again is pressed after the window's reads moved on and the linger passed", async () => {
    const { hostId, peer, entry, fixture, dialed, dialedAt, lost, until } =
      await startRemoteHost();
    peer.refuseEveryOpen = remoteDoorRefusal(NOBODY_SIGNED_IN_CASE);
    const sessions = watchSessions();
    const redialIfWaiting = vi.spyOn(
      RemoteSession.prototype,
      "redialIfWaiting",
    );
    onTestFinished(() => {
      redialIfWaiting.mockRestore();
    });
    vi.stubGlobal("WebSocket", FakeNativeWebSocket);
    applySnapshot({ targetHostId: ELSEWHERE_HOST_ID });
    render(
      inRuntime(
        fixture,
        <TabHostContext.Provider value={hostId}>
          <SandboxTileStateFrame chat={null}>
            <p>tile</p>
          </SandboxTileStateFrame>
        </TabHostContext.Provider>,
      ),
    );
    const read = messengerReads(fixture);
    read(hostId, entry.websocketUrl ?? "");
    const closedSession = (): boolean => sessions.closed.mock.calls.length > 0;
    await until(() => lost.count() >= 1);
    read(ELSEWHERE_HOST_ID, "ws://elsewhere.test/rpc");

    // The linger passes while the session keeps dialing its ladder.
    let loss = 1;
    for (
      let waitedMs = 0;
      waitedMs < REMOTE_SESSION_LINGER_MS + 30_000;
      loss += 1
    ) {
      await until(() => lost.count() >= loss || closedSession());
      if (closedSession()) break;
      const rungMs = Math.min(1_000 * 2 ** (loss - 1), 30_000);
      await advance(rungMs);
      await until(() => dialed.count() > loss || closedSession());
      waitedMs += rungMs;
    }
    await until(() => lost.count() >= loss || closedSession());

    const statusRead = vi.fn(() => new Promise<never>(() => undefined));
    const binding = bindingOver(
      fixture,
      new MockHostMessenger<HostRpcRegistry>({
        registry: hostRpcRegistry,
        requestId: () => "try-again",
        handlers: { "environment.status": statusRead },
      }),
    );
    const hook = renderReadRefusal(fixture, binding, hostId);
    const dialsBefore = dialed.count();
    const pressedAt = Date.now();
    act(() => {
      hook.result.current.retryStatus();
    });
    await settle();

    expect(dialed.count() - dialsBefore).toBe(1);
    expect(dialedAt[dialsBefore]).toBe(pressedAt);
    expect(redialIfWaiting).toHaveBeenCalledTimes(1);
    expect(statusRead).toHaveBeenCalledTimes(1);
    expect(sessions.startedCount()).toBe(1);
    expect(sessions.closed).not.toHaveBeenCalled();
  });

  it("lists the nobody-signed-in capability on the open a tile's remote stream sends", async () => {
    const { peer, log, reached } = await startRemoteTileStream([]);

    await reached(log.opened.nth(1));

    expect(peer.opens).toHaveLength(1);
    expect(peer.opens[0]?.capabilities).toEqual(
      expect.arrayContaining([CLIENT_CAPABILITY_NOBODY_SIGNED_IN_V1]),
    );
  });

  /*
   * The same dials, at the same pace, whichever reason ends them: the host
   * ends the connection it admitted at its recheck, refuses the next three
   * opens, then admits one. Nobody presses anything.
   */
  it.each([
    HOST_CLAIMED_CASE,
    {
      doorReason: "membership_removed",
      code: "TEAM_MEMBERSHIP_REQUIRED",
      retryable: false,
      state: "membership-removed",
      coverTitle: "You no longer have access to this team's computer",
      coverLine: "Work you started continues for the team.",
    },
  ] as const)(
    "rebuilds a remote stream ended by $doorReason at once, then after 1s, 2s and 4s, and drops the state when an open is admitted",
    async (testCase) => {
      const refusal = remoteDoorRefusal(testCase);
      const {
        hostId,
        peer,
        dialed,
        dialedAt,
        signInRecovery,
        log,
        reached,
        surface,
        expectRefusedCover,
      } = await startRemoteTileStream([]);

      await reached(log.opened.nth(1));
      expect(hostDoorStateFor(hostId)).toBeNull();
      const titleBeforeRefusal = within(surface()).getByTestId(
        "window-host-modal-title",
      ).textContent;

      peer.refuseNextOpens([refusal, refusal, refusal]);
      await peer.sendSessionFatal(refusal);
      await reached(log.closed.nth(1));
      expectRefusedCover(testCase);

      // The first quick close rebuilds at once; each one after it waits twice as long.
      const delaysMs = [0, 1_000, 2_000, 4_000];
      for (const [index, delayMs] of delaysMs.entries()) {
        const rebuilds = index + 1;
        if (delayMs > 0) {
          await act(async () => {
            await vi.advanceTimersByTimeAsync(delayMs - 1);
          });
          expect(log.builtAt).toHaveLength(rebuilds);
          await act(async () => {
            await vi.advanceTimersByTimeAsync(1);
          });
        }
        expect(log.builtAt).toHaveLength(rebuilds + 1);
        await reached(dialed.nth(rebuilds + 1));
        if (rebuilds < delaysMs.length) {
          await reached(log.closed.nth(rebuilds + 1));
          expectRefusedCover(testCase);
        }
      }
      await reached(log.opened.nth(2));

      expect(hostDoorStateFor(hostId)).toBeNull();
      // For host_claimed the title alone cannot tell cleared from not cleared: the store assertion above does.
      expect(
        within(surface()).getByTestId("window-host-modal-title").textContent,
      ).toBe(titleBeforeRefusal);
      const waitedSinceClose = (instants: readonly number[]): number[] =>
        instants.slice(1).map((at, index) => at - log.closedAt[index]);
      expect(waitedSinceClose(log.builtAt)).toEqual(delaysMs);
      expect(waitedSinceClose(dialedAt)).toEqual(delaysMs);
      expect(peer.openCount).toBe(5);
      expect(peer.errors).toEqual([]);
      // The refusal ends each session for good, and never starts sign-in recovery.
      expect(log.closed.count()).toBe(4);
      expect(signInRecovery).not.toHaveBeenCalled();
      // The per-stream reopen lanes would take this close too.
      expect(
        log.closeReasons.map((reason) => isReopenableHostStreamClose(reason)),
      ).toEqual([true, true, true, true]);
    },
  );

  it("draws the older-host cover after a real host-token refusal when the directory version is unknown", async () => {
    const hostId = "host-token-older-host-cover";
    // A team's computer is never handed the person's sign-in, so its bare
    // refusal of the host-only token is the end: no attach follows it.
    const stream = await openLocalStreamOnHostOnlyToken(hostId, {
      kind: "team",
      id: "team-1",
      name: "Team",
    });
    try {
      act(() => {
        stream.socket.fireMessage(bareRefusalFrame);
      });

      await waitFor(() =>
        expect(hostDoorStateFor(hostId)?.kind).toBe("older-host"),
      );
      expect(
        (await screen.findByTestId("window-host-modal-title")).textContent,
      ).toBe("Host update needed");
      expect(
        screen.getByTestId("window-host-modal-update-host").textContent,
      ).toBe("Update now");
      expect(
        screen.getByTestId("window-host-modal-incompatible-detail").textContent,
      ).not.toContain("Host version:");
      expect(stream.signInRecoveryCalls()).toBe(0);
      expect(stream.mintCalls()).toBe(0);
      expect(stream.hostTokens.current(USER_A, hostId)?.token).toBe(
        HOST_ONLY_TOKEN,
      );
    } finally {
      stream.close();
    }
  });

  it("draws no cover when the person's own computer refuses the host-only token bare and the sign-in attach that follows is refused bare too", async () => {
    const hostId = "host-token-sign-in-attach-refused";
    const stream = await openLocalStreamOnHostOnlyToken(hostId, null);
    try {
      act(() => {
        stream.socket.fireMessage(bareRefusalFrame);
      });
      // The released way: the stream attaches again with the person's sign-in.
      await waitFor(() =>
        expect(FakeNativeWebSocket.instances).toHaveLength(2),
      );
      const signInSocket = FakeNativeWebSocket.instances.at(1);
      if (signInSocket === undefined) throw new Error("sign-in socket missing");
      signInSocket.fireOpen();
      await waitFor(() =>
        expect(sentFramesOfKind(signInSocket, "open")).toHaveLength(1),
      );
      expect(sentFramesOfKind(signInSocket, "open").at(0)?.token).toBe(
        SIGN_IN_TOKEN_OF_PERSON,
      );
      expect(hostDoorStateFor(hostId)).toBeNull();

      act(() => {
        signInSocket.fireMessage(bareRefusalFrame);
      });

      // That refusal is the person's sign-in's: recovery is asked, and the door is told nothing.
      await waitFor(() => expect(stream.signInRecoveryCalls()).toBe(1));
      expect(hostDoorStateFor(hostId)).toBeNull();
      expect(screen.queryByTestId("window-host-modal")).toBeNull();
      expect(stream.mintCalls()).toBe(0);
    } finally {
      stream.close();
    }
  });

  it("a served remote window follows its live directory row below the floor without replacing the window", async () => {
    const fixture = await createModalHostRuntimeFixture(
      remoteHostEntry(MINIMUM_HOST_VERSION, "current"),
      "normal",
    );
    applySnapshot({
      attached: true,
      effectiveHostId: REMOTE_HOST_ID,
      targetHostId: REMOTE_HOST_ID,
      leases: [lease({ hostId: REMOTE_HOST_ID, status: "ready", dead: null })],
    });

    renderHostWithRuntime(
      fixture,
      { ...EMPTY_PRESENTATION, targetKind: "remote", localBootIntent: false },
      false,
      GATE_OPEN,
    );

    expect(screen.queryByTestId("window-host-modal")).toBeNull();
    const narrationInstanceId = narrationRound2Harness.activeInstanceId;
    expect(narrationInstanceId).not.toBe(0);
    const atFloor = fixture.directory.findById(REMOTE_HOST_ID);
    if (atFloor === null || !isRemoteHostDirectoryEntry(atFloor)) {
      throw new Error("the selected remote directory row was missing");
    }
    expect(useSelectionAuthorityStore.getState().effectiveHostId).toBe(
      REMOTE_HOST_ID,
    );
    expect(atFloor.version).toBe("9.9.9");
    expect(atFloor.remoteStatus.appVersion).toBe(MINIMUM_HOST_VERSION);

    await act(async () => {
      fixture.rows.current = [remoteHostEntry("1.5.4", "current")];
      await fixture.directory.refresh();
    });

    const surface = await screen.findByTestId("window-host-modal");
    expect(narrationRound2Harness.activeInstanceId).toBe(narrationInstanceId);
    const belowFloor = fixture.directory.findById(REMOTE_HOST_ID);
    if (belowFloor === null || !isRemoteHostDirectoryEntry(belowFloor)) {
      throw new Error("the downgraded remote directory row was missing");
    }
    expect(useSelectionAuthorityStore.getState().effectiveHostId).toBe(
      REMOTE_HOST_ID,
    );
    expect(belowFloor.version).toBe(atFloor.version);
    expect(belowFloor.remoteStatus.appVersion).toBe("1.5.4");
    expect(surface.getAttribute("data-cause")).toBe("no-usable-host");
    expect(surface.getAttribute("data-variant")).toBe("update-host");
    expect(
      within(surface).getByTestId("window-host-modal-title").textContent,
    ).toBe("Host update needed");
    expect(
      within(surface).getByTestId("window-host-modal-description").textContent,
    ).toBe(
      "That computer's Traycer Host is running a version this app can't talk to. Update it to continue - its agents and history are untouched.",
    );
  });

  it("keeps the real older-host cover unchanged when a warm remote session's linger redial fails", async () => {
    const peer = new RemoteMuxTestPeer();
    const relayAttachUrl = "wss://relay.test/attach";
    const hostId = REMOTE_HOST_ID;
    const floorEntry: RemoteHostDirectoryEntry = {
      ...remoteHostEntry(MINIMUM_HOST_VERSION, "current"),
      publicKey: peer.hostPublicKey,
      websocketUrl: relayAttachUrl,
    };
    const fixture = await createModalHostRuntimeFixture(floorEntry, "normal");
    applySnapshot({
      attached: true,
      effectiveHostId: hostId,
      targetHostId: hostId,
      leases: [lease({ hostId, status: "ready", dead: null })],
    });
    renderHostWithRuntime(
      fixture,
      { ...EMPTY_PRESENTATION, targetKind: "remote", localBootIntent: false },
      false,
      GATE_OPEN,
    );
    expect(screen.queryByTestId("window-host-modal")).toBeNull();

    const hostTokens = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () => Promise.resolve({ kind: "no-sign-in" }),
      signIn: null,
      now: () => Date.now(),
    });
    await hostTokens.adopt(
      "user-1",
      hostId,
      {
        token: "host-only-token",
        expiresAtMs: Date.now() + 3_600_000,
      },
      hostTokens.era("user-1"),
      () => true,
    );
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            grant: "relay-pass",
            role: "client",
            expires_in: 300,
            session_grant: "relay-session-grant",
            session_grant_expires_in: 300,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const sockets: StreamWebSocketLike[] = [];
    let dialAttempts = 0;
    const failedRedial = Promise.withResolvers<void>();
    const webSocketFactory: IStreamWebSocketFactory = {
      create: (url, priority) => {
        dialAttempts += 1;
        if (dialAttempts === 1) {
          const socket = peer.factory.create(url, priority);
          sockets.push(socket);
          return socket;
        }

        const failedSocket: StreamWebSocketLike = {
          onopen: null,
          onmessage: null,
          onerror: null,
          onclose: null,
          send: () => undefined,
          close: () => undefined,
        };
        sockets.push(failedSocket);
        queueMicrotask(() => {
          const onerror = failedSocket.onerror;
          if (onerror === null) {
            failedRedial.reject(
              new Error("failed redial socket had no error handler"),
            );
            return;
          }
          onerror({ message: "relay network unavailable" });
          failedRedial.resolve();
        });
        return failedSocket;
      },
    };
    remoteSocketFactoryHarness.delegate = webSocketFactory;
    const provider = newProvider();
    signIn(provider, "user-1", "user-token");
    const bearer = liveBearer(provider);
    const auth: StreamAuthRevalidator = {
      revalidateForReconnect: () => Promise.resolve("rotated"),
    };
    const client = buildHostStreamClient({
      target: floorEntry,
      endpoint: () => null,
      bearer,
      cloudAuthorized: () => true,
      authnBaseUrl: "http://localhost:5005",
      auth,
      hostTokens,
      userId: "user-1",
      proactiveWakeEligible: false,
      autoStart: false,
      watchHostTokens: true,
    });
    if (client === null) throw new Error("remote stream client did not build");
    const sharedClient = buildHostStreamClient({
      target: floorEntry,
      endpoint: () => null,
      bearer,
      cloudAuthorized: () => true,
      authnBaseUrl: "http://localhost:5005",
      auth,
      hostTokens,
      userId: "user-1",
      proactiveWakeEligible: false,
      autoStart: false,
      watchHostTokens: true,
    });
    if (sharedClient === null)
      throw new Error("shared remote stream client did not build");
    const stream = client.subscribe("epic.subscribe", { epicId: "epic-a" });
    const sharedStream = sharedClient.subscribe("epic.subscribe", {
      epicId: "epic-b",
    });

    const toastError = vi.spyOn(toast, "error");
    let usingFakeTimers = false;
    // Registered with the runner, so a wait that never ends still releases
    // what this case opened before the next test runs.
    onTestFinished(() => {
      // The second dial settles this; a case that never reached it still
      // lets the act holding it finish. A settled promise ignores this.
      failedRedial.resolve();
      stream.close();
      sharedStream.close();
      client.close("test complete");
      sharedClient.close("test complete");
      toastError.mockRestore();
      remoteSocketFactoryHarness.delegate = null;
      clearHostDoorState(hostId);
      if (usingFakeTimers) {
        retireAllRemoteSessions();
        vi.useRealTimers();
      }
    });
    await waitFor(() => expect(peer.openCount).toBe(1));
    await waitFor(() => expect(hasReadyRemoteSession(hostId)).toBe(true));
    expect(dialAttempts).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(peer.errors).toEqual([]);
    const atFloor = fixture.directory.findById(hostId);
    if (atFloor === null || !isRemoteHostDirectoryEntry(atFloor)) {
      throw new Error("the connected remote directory row was missing");
    }
    expect(atFloor.remoteStatus.appVersion).toBe(MINIMUM_HOST_VERSION);

    await act(async () => {
      fixture.rows.current = [
        {
          ...remoteHostEntry("1.5.4", "current"),
          publicKey: peer.hostPublicKey,
          websocketUrl: relayAttachUrl,
        },
      ];
      await fixture.directory.refresh();
    });

    const surface = await screen.findByTestId("window-host-modal");
    expect(surface.getAttribute("data-cause")).toBe("no-usable-host");
    expect(surface.getAttribute("data-variant")).toBe("update-host");
    expect(
      within(surface).getByTestId("window-host-modal-title").textContent,
    ).toBe("Host update needed");
    expect(
      within(surface).getByTestId("window-host-modal-description").textContent,
    ).toBe(
      "That computer's Traycer Host is running a version this app can't talk to. Update it to continue - its agents and history are untouched.",
    );
    expect(buttonsOf(surface)).toEqual(["Update now", "Open settings"]);
    expect(useSelectionAuthorityStore.getState().effectiveHostId).toBe(hostId);

    vi.useFakeTimers();
    usingFakeTimers = true;
    stream.close();
    sharedStream.close();
    client.close("release into shared-session linger");
    sharedClient.close("release into shared-session linger");
    expect(hasReadyRemoteSession(hostId)).toBe(true);
    expect(client.isClosed()).toBe(false);

    const firstSocket = sockets.at(0);
    if (firstSocket === undefined || firstSocket.onclose === null) {
      throw new Error("established relay socket had no close handler");
    }
    // A ready session's first recovery redial uses the immediate rung.
    await act(async () => {
      firstSocket.onclose?.({
        code: 1006,
        reason: "relay connection interrupted",
        wasClean: false,
      });
      await vi.advanceTimersByTimeAsync(0);
      await failedRedial.promise;
    });
    expect(dialAttempts).toBe(2);
    expect(hasReadyRemoteSession(hostId)).toBe(false);
    expect(client.isClosed()).toBe(false);
    const belowFloor = fixture.directory.findById(hostId);
    if (belowFloor === null || !isRemoteHostDirectoryEntry(belowFloor)) {
      throw new Error("the downgraded remote directory row was missing");
    }
    expect(belowFloor.remoteStatus.appVersion).toBe("1.5.4");
    expect(useSelectionAuthorityStore.getState().effectiveHostId).toBe(hostId);
    expect(screen.getByTestId("window-host-modal")).toBe(surface);
    expect(surface.getAttribute("data-cause")).toBe("no-usable-host");
    expect(surface.getAttribute("data-variant")).toBe("update-host");
    expect(
      within(surface).getByTestId("window-host-modal-title").textContent,
    ).toBe("Host update needed");
    expect(
      within(surface).getByTestId("window-host-modal-description").textContent,
    ).toBe(
      "That computer's Traycer Host is running a version this app can't talk to. Update it to continue - its agents and history are untouched.",
    );
    expect(buttonsOf(surface)).toEqual(["Update now", "Open settings"]);
    expect(toast).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(authErrorToastHarness.show).not.toHaveBeenCalled();
  });

  it("the real older-host cover offers Update now and Open settings before a remote update is pending", async () => {
    const fixture = await createModalHostRuntimeFixture(
      remoteHostEntry("1.5.4", "current"),
      "normal",
    );
    applySnapshot({
      attached: true,
      effectiveHostId: null,
      targetHostId: REMOTE_HOST_ID,
      leases: [],
    });

    renderHostWithRuntime(
      fixture,
      { ...EMPTY_PRESENTATION, targetKind: "remote", localBootIntent: false },
      false,
      GATE_OPEN,
    );

    const surface = await screen.findByTestId("window-host-modal");
    expect(surface.getAttribute("data-variant")).toBe("update-host");
    expect(
      within(surface).getByTestId("window-host-modal-title").textContent,
    ).toBe("Host update needed");
    expect(
      within(surface).getByTestId("window-host-modal-description").textContent,
    ).toBe(
      "That computer's Traycer Host is running a version this app can't talk to. Update it to continue - its agents and history are untouched.",
    );
    expect(buttonsOf(surface)).toEqual(["Update now", "Open settings"]);
    expect(
      within(surface).queryByRole("button", { name: "Report issue" }),
    ).toBeNull();
  });

  it("the real older-host cover replaces Update now with the directory's pending lines", async () => {
    const fixture = await createModalHostRuntimeFixture(
      remoteHostEntry("1.5.4", "pending"),
      "normal",
    );
    applySnapshot({
      attached: true,
      effectiveHostId: null,
      targetHostId: REMOTE_HOST_ID,
      leases: [],
    });

    renderHostWithRuntime(
      fixture,
      { ...EMPTY_PRESENTATION, targetKind: "remote", localBootIntent: false },
      false,
      GATE_OPEN,
    );

    const surface = await screen.findByTestId("window-host-modal");
    expect(surface.getAttribute("data-variant")).toBe("update-host");
    expect(buttonsOf(surface)).toEqual(["Open settings"]);
    expect(within(surface).getByText("Update pending")).toBeTruthy();
    expect(
      within(surface).getByText(
        "Applied on this host's next check-in — within ~10 minutes, and only when no sessions are running.",
      ),
    ).toBeTruthy();
    expect(
      within(surface).queryByRole("button", { name: "Report issue" }),
    ).toBeNull();
  });

  it("the real older-host cover restores its actions after a failed update and keeps the auth toast", async () => {
    const fixture = await createModalHostRuntimeFixture(
      remoteHostEntry("1.5.4", "current"),
      "fail-update",
    );
    applySnapshot({
      attached: true,
      effectiveHostId: null,
      targetHostId: REMOTE_HOST_ID,
      leases: [],
    });

    renderHostWithRuntime(
      fixture,
      { ...EMPTY_PRESENTATION, targetKind: "remote", localBootIntent: false },
      false,
      GATE_OPEN,
    );

    const surface = await screen.findByTestId("window-host-modal");
    expect(buttonsOf(surface)).toEqual(["Update now", "Open settings"]);
    fireEvent.click(
      within(surface).getByTestId("window-host-modal-update-host"),
    );

    await waitFor(() => {
      expect(hostPolicyPatchCalls).toBe(1);
      expect(authErrorToastHarness.show).toHaveBeenCalledTimes(1);
    });
    const toastCall = authErrorToastHarness.show.mock.calls.at(0);
    if (toastCall === undefined)
      throw new Error("update failure toast missing");
    expect(toastCall[1]).toBe("Couldn't update this host.");
    await waitFor(() => {
      const updateButton = within(surface).getByTestId(
        "window-host-modal-update-host",
      );
      if (!(updateButton instanceof HTMLButtonElement)) {
        throw new Error("Update now control is not a button");
      }
      expect(updateButton.disabled).toBe(false);
    });
    expect(buttonsOf(surface)).toEqual(["Update now", "Open settings"]);
    expect(
      within(surface).queryByRole("button", { name: "Report issue" }),
    ).toBeNull();
  });

  it("∅ (no-usable-host): settled failure — Retry, Report issue and Open settings(button) present; progress heading absent; attempt panel + log toggle present", async () => {
    // The reported defect on this arm (B4) was a live "starting" narration
    // drawn over a state where nothing is starting, with Retry and Report
    // issue beside it as if a real attempt were in flight. Pinned by the
    // negative assertions below so nobody restores it.
    hostStatus.data = BOOTSTRAP_MARKERS;
    applySnapshot({
      attached: true,
      effectiveHostId: null,
      targetHostId: LOCAL_HOST_ID,
      leases: [deadLease(LOCAL_HOST_ID, { reason: "offline" })],
    });

    renderHost(
      {
        ...EMPTY_PRESENTATION,
        targetKind: "local",
        localBootIntent: true,
        canManageHost: true,
      },
      false,
      // A real CLI, not the no-CLI default: `local-host-loading-toggle-details`
      // structurally cannot render without one (see
      // `local-host-loading.test.tsx`'s own positive/negative control pair),
      // so proving it PRESENT needs the positive shell.
      new MockTraycerCli(),
    );

    // Existence before absence: a modal that failed to render at all would
    // also satisfy every "absent" assertion below, and that exact shape has
    // already bitten this branch three times.
    await waitFor(() => {
      expect(screen.getByTestId("window-host-modal")).toBeTruthy();
    });
    expect(
      screen.getByTestId("window-host-modal").getAttribute("data-cause"),
    ).toBe("no-usable-host");
    const openSettings = screen.getByTestId("window-host-modal-open-settings");
    expect(openSettings).toBeTruthy();

    // Nothing is starting, so nothing narrates a start.
    expect(screen.queryByTestId("local-host-loading-stage")).toBeNull();
    expect(screen.queryByText("Starting Traycer…")).toBeNull();

    // The attempt panel is what explains this state, and it is present...
    expect(
      screen.getByTestId("local-host-bootstrap-log-path").textContent,
    ).toBe("/Users/me/.traycer/bootstrap.log");
    expect(screen.getByTestId("local-host-bootstrap-details")).toBeTruthy();
    // ...and the log disclosure toggle survives onto this arm - it is the one
    // way to take a stuck startup elsewhere, and it is TRUE here.
    expect(
      screen.getByTestId("local-host-loading-toggle-details"),
    ).toBeTruthy();

    // This IS the settled failure: Retry, Report issue, and Open settings as
    // an equal-weight button, all present.
    expect(screen.getByTestId("window-host-modal-retry")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Report issue" })).toBeTruthy();
    expect(openSettings.getAttribute("data-emphasis")).toBe("button");
    expect(buttonsOf(screen.getByTestId("window-host-modal"))).toEqual([
      "Show details",
      "Retry",
      "Open settings",
      "Report issue",
    ]);
  });

  // `HostControllerStatus.lastEnsureFailure`'s settled read, surfaced
  // on `DefaultHostReadinessPresentation` as `ensureFailure`. Same post-latch
  // ∅/local-lifecycle settled body as the test above, so the only variable is
  // `ensureFailure` itself.
  it("the settled ∅ narrator shows the ensure failure's own message verbatim", async () => {
    const SENTENCE =
      "the Traycer Host task is disabled in Task Scheduler; enable it or run `traycer host service install`";
    hostStatus.data = BOOTSTRAP_MARKERS;
    applySnapshot({
      attached: true,
      effectiveHostId: null,
      targetHostId: LOCAL_HOST_ID,
      leases: [deadLease(LOCAL_HOST_ID, { reason: "offline" })],
    });

    renderHost(
      {
        ...EMPTY_PRESENTATION,
        targetKind: "local",
        localBootIntent: true,
        canManageHost: true,
        ensureFailure: { message: SENTENCE, code: null },
      },
      false,
      new MockTraycerCli(),
    );

    await waitFor(() => {
      expect(screen.getByTestId("window-host-modal")).toBeTruthy();
    });
    const messageEl = screen.queryByTestId("host-ensure-failure-message");
    expect(messageEl).not.toBeNull();
    expect(messageEl?.textContent).toBe(SENTENCE);
    expect(messageEl?.className ?? "").toContain("line-clamp-4");
    expect(messageEl?.className ?? "").toContain("select-text");
  });

  it("control: ensureFailure: null renders no message, and the attempt body is unchanged", async () => {
    hostStatus.data = BOOTSTRAP_MARKERS;
    applySnapshot({
      attached: true,
      effectiveHostId: null,
      targetHostId: LOCAL_HOST_ID,
      leases: [deadLease(LOCAL_HOST_ID, { reason: "offline" })],
    });

    renderHost(
      {
        ...EMPTY_PRESENTATION,
        targetKind: "local",
        localBootIntent: true,
        canManageHost: true,
        ensureFailure: null,
      },
      false,
      new MockTraycerCli(),
    );

    await waitFor(() => {
      expect(screen.getByTestId("window-host-modal")).toBeTruthy();
    });
    expect(screen.queryByTestId("host-ensure-failure-message")).toBeNull();
    // Today's attempt body, unchanged by the new field's absence.
    expect(
      screen.getByTestId("local-host-bootstrap-log-path").textContent,
    ).toBe("/Users/me/.traycer/bootstrap.log");
    expect(screen.getByTestId("local-host-bootstrap-details")).toBeTruthy();
  });

  it("a REMOTE-only fleet: no local bootstrap body, no bootstrap log path", async () => {
    applySnapshot({
      attached: true,
      effectiveHostId: null,
      targetHostId: REMOTE_HOST_ID,
      leases: [deadLease(REMOTE_HOST_ID, { reason: "offline" })],
    });

    renderHost(
      {
        ...EMPTY_PRESENTATION,
        targetKind: "remote",
        localBootIntent: false,
      },
      false,
      undefined,
    );

    await waitFor(() => {
      expect(screen.getByTestId("window-host-modal")).toBeTruthy();
    });
    expect(screen.queryByTestId("local-host-loading-stage")).toBeNull();
    expect(screen.queryByTestId("local-host-bootstrap-log-path")).toBeNull();
  });

  it("cold-start on a REMOTE target draws the SAME boot body as a local one: headline, inline Open settings, no action row", async () => {
    // THE REPORTED LAUNCH. A fresh install on an account that has remote hosts
    // derives a remote as effective until the local host registers (the
    // engine's third arm: no preference, no local row, first usable remote), so
    // for that whole window the target is REMOTE, its lease is `connecting`,
    // nothing has failed and nothing is slow. This arm used to withhold the
    // boot body for any non-local target and let the action row carry the
    // settings link on its own - which rendered as a card containing nothing
    // but "Open settings". Now the body is drawn whatever the target's kind:
    // same headline, same footer pair, same card as the two boot surfaces
    // before it.
    applySnapshot({
      attached: true,
      effectiveHostId: REMOTE_HOST_ID,
      targetHostId: REMOTE_HOST_ID,
      leases: [
        lease({ hostId: REMOTE_HOST_ID, status: "connecting", dead: null }),
      ],
    });

    renderHostWithGate(
      {
        ...EMPTY_PRESENTATION,
        targetKind: "remote",
        localBootIntent: false,
      },
      false,
      new MockTraycerCli(),
      GATE_BLOCKING,
    );

    await waitFor(() => {
      expect(screen.getByTestId("window-host-startup-card")).toBeTruthy();
    });
    const card = screen.getByTestId("window-host-startup-card");
    expect(card.getAttribute("data-cause")).toBe("cold-start");
    // Drawn THROUGH the shared boot card, not merely resembling it.
    expect(card.getAttribute("data-surface")).toBe(HOST_BOOT_CARD_SURFACE);

    // The boot body: the family's idle heading (no lane is running, and no
    // machine has been named that a lane could describe) and no bar, since
    // nothing has a measured position.
    expect(screen.getByTestId("local-host-loading-stage").textContent).toBe(
      "Starting Traycer…",
    );
    expect(screen.queryByRole("progressbar")).toBeNull();
    // The footer pair, exactly as the two surfaces before this one draw it:
    // `Show details` with `Open settings` INLINE beside it ...
    expect(
      screen.getByTestId("local-host-loading-toggle-details"),
    ).toBeTruthy();
    expect(screen.getByTestId("host-boot-open-settings").textContent).toContain(
      "Open settings",
    );
    // ... and NO action row of the card's own: nothing failed, nothing to
    // retry, so an equal-weight row would be the "something is wrong, pick
    // one" signal on a start that is fine.
    expect(screen.queryByTestId("window-host-modal-open-settings")).toBeNull();
    expect(screen.queryByTestId("window-host-modal-retry")).toBeNull();
    expect(screen.queryByRole("button", { name: "Report issue" })).toBeNull();
    // And no title/description: the headline is the one line.
    expect(screen.queryByTestId("window-host-startup-card-title")).toBeNull();
    expect(
      screen.queryByTestId("window-host-startup-card-description"),
    ).toBeNull();
  });

  it("cold-start on a REMOTE target while this machine's lane runs: the lane heading in the boot headline, never the boxed lane line", async () => {
    // The second shape of the same launch: the desktop's reconciler is
    // installing the local host underneath while the derived target is still
    // the remote. The lane is real and it is this machine's, so the boot body
    // narrates it the way every other phase would - its headline, plus the
    // progress bar once a stage reports a percentage - instead of the
    // bordered `LaneProgressLine` strip that titled faces use
    // under their own description. That strip under NO title was the
    // "weird-looking Setting up Traycer" card.
    controllerStatus.data = {
      mutation: {
        kind: "ensure",
        progress: null,
        startedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    applySnapshot({
      attached: true,
      effectiveHostId: REMOTE_HOST_ID,
      targetHostId: REMOTE_HOST_ID,
      leases: [
        lease({ hostId: REMOTE_HOST_ID, status: "connecting", dead: null }),
      ],
    });

    renderHostWithGate(
      {
        ...EMPTY_PRESENTATION,
        targetKind: "remote",
        localBootIntent: false,
      },
      false,
      undefined,
      GATE_BLOCKING,
    );

    await waitFor(() => {
      expect(screen.getByTestId("window-host-startup-card")).toBeTruthy();
    });
    expect(screen.getByTestId("local-host-loading-stage").textContent).toBe(
      "Setting up Traycer Host…",
    );
    // The lane has reported no percentage yet, so there is no bar to draw.
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByTestId("window-host-modal-progress")).toBeNull();
    // Still the healthy footer, still no action row.
    expect(screen.getByTestId("host-boot-open-settings")).toBeTruthy();
    expect(screen.queryByTestId("window-host-modal-open-settings")).toBeNull();
  });

  it("∅ on a REMOTE-only fleet keeps this machine's diagnostics OFF the card: the settled arm is the one place the target still gates", async () => {
    // The counterweight to the two fixtures above. The healthy body lost its
    // target gate; the SETTLED body did not, and must not - an attempt panel
    // about a local install under "No host is available" on a fleet this
    // machine is not part of blames the wrong computer. Title + description +
    // actions are that arm's whole story.
    hostStatus.data = BOOTSTRAP_MARKERS;
    applySnapshot({
      attached: true,
      effectiveHostId: null,
      targetHostId: REMOTE_HOST_ID,
      leases: [deadLease(REMOTE_HOST_ID, { reason: "offline" })],
    });

    renderHost(
      {
        ...EMPTY_PRESENTATION,
        targetKind: "remote",
        localBootIntent: false,
      },
      false,
      new MockTraycerCli(),
    );

    await waitFor(() => {
      expect(screen.getByTestId("window-host-modal")).toBeTruthy();
    });
    expect(screen.queryByTestId("local-host-bootstrap-details")).toBeNull();
    expect(screen.queryByTestId("local-host-bootstrap-log-path")).toBeNull();
    expect(screen.queryByTestId("local-host-loading-stage")).toBeNull();
    expect(
      screen.queryByTestId("local-host-loading-toggle-details"),
    ).toBeNull();
    expect(screen.getByTestId("window-host-modal-open-settings")).toBeTruthy();
  });

  it("cold-start, healthy (stage: loading, no provisioningError): Retry, Report issue absent; Open settings present as a link; idle heading shown; no attempt summary", async () => {
    // The markers MUST be available for this assertion to mean anything. The
    // first version of this test left the status query empty, so the summary
    // was absent because there was nothing to summarise - it passed with the
    // cause guard deleted, and a kill probe is what caught it. Supplying
    // markers makes the guard the only reason the summary stays away.
    hostStatus.data = BOOTSTRAP_MARKERS;
    applySnapshot({
      attached: true,
      effectiveHostId: LOCAL_HOST_ID,
      targetHostId: LOCAL_HOST_ID,
      leases: [
        lease({ hostId: LOCAL_HOST_ID, status: "connecting", dead: null }),
      ],
    });

    renderHostWithGate(
      {
        ...EMPTY_PRESENTATION,
        targetKind: "local",
        localBootIntent: true,
      },
      false,
      undefined,
      GATE_BLOCKING,
    );

    // A LAUNCH renders the card, not the dialog - there is no app behind it
    // to trap pointers over, and trapping them is what made every toast dead
    // for the whole of setup.
    await waitFor(() => {
      expect(screen.getByTestId("window-host-startup-card")).toBeTruthy();
    });
    expect(
      screen.getByTestId("window-host-startup-card").getAttribute("data-cause"),
    ).toBe("cold-start");
    // `Open settings` lives INLINE on the footer row beside `Show details`
    // here, not in an action row of its own - the same pair, in the same
    // place, as the two boot surfaces that precede this one. A row of its own
    // is what made the healthy card a four-line column of stray links.
    const openSettings = screen.getByTestId("host-boot-open-settings");
    expect(openSettings).toBeTruthy();
    expect(screen.queryByTestId("window-host-modal-open-settings")).toBeNull();

    expect(screen.getByTestId("local-host-loading-stage").textContent).toBe(
      "Starting Traycer…",
    );
    expect(screen.queryByTestId("local-host-bootstrap-details")).toBeNull();

    // This is the reported defect's own state: a start with no failure of any
    // kind. Retry and Report issue must both be absent.
    expect(screen.queryByTestId("window-host-modal-retry")).toBeNull();
    expect(screen.queryByRole("button", { name: "Report issue" })).toBeNull();

    // ONE VOICE FOR THE EVENT. The card draws no title or description on a
    // healthy start, so the lane's own heading is the only line - the
    // "Setting up Traycer" / "Setting up Traycer Host…" / "Setting up…"
    // stack the user reported is structurally unbuildable here.
    expect(screen.queryByTestId("window-host-startup-card-title")).toBeNull();
    expect(
      screen.queryByTestId("window-host-startup-card-description"),
    ).toBeNull();

    // And the escape hatch survives the quiet: `AppHeader variant="host-loading"`
    // has `navDisabled`, so this link is the ONLY route to Settings on screen.
    // Dropping it for a tidier card is a lockout, not a simplification.
    expect(openSettings.textContent).toContain("Open settings");
  });

  it("cold-start older host keeps the update title and exact remote description without Report issue", async () => {
    const fixture = await createModalHostRuntimeFixture(
      remoteHostEntry("1.5.4", "current"),
      "normal",
    );
    applySnapshot({
      attached: true,
      effectiveHostId: REMOTE_HOST_ID,
      targetHostId: REMOTE_HOST_ID,
      leases: [
        lease({
          hostId: REMOTE_HOST_ID,
          status: "connecting",
          dead: null,
        }),
      ],
    });

    renderHostWithRuntime(
      fixture,
      { ...EMPTY_PRESENTATION, targetKind: "remote", localBootIntent: false },
      false,
      GATE_BLOCKING,
    );

    const card = await screen.findByTestId("window-host-startup-card");
    expect(card.getAttribute("data-cause")).toBe("cold-start");
    expect(card.getAttribute("data-variant")).toBe("update-host");
    expect(
      within(card).getByTestId("window-host-startup-card-title").textContent,
    ).toBe("Host update needed");
    expect(
      within(card).getByTestId("window-host-startup-card-description")
        .textContent,
    ).toBe(
      "That computer's Traycer Host is running a version this app can't talk to. Update it to continue - its agents and history are untouched.",
    );
    expect(
      within(card).queryByRole("button", { name: "Report issue" }),
    ).toBeNull();
  });

  it("cold-start, slow (stage: slow): Retry present, Report issue absent, Open settings present as a button", async () => {
    // The row most likely to get this wrong later: Retry and Report issue sit
    // adjacent in the same row and share the same underlying state, so it is
    // easy for a change that means to unlock Retry to unlock both.
    applySnapshot({
      attached: true,
      effectiveHostId: LOCAL_HOST_ID,
      targetHostId: LOCAL_HOST_ID,
      leases: [
        lease({ hostId: LOCAL_HOST_ID, status: "connecting", dead: null }),
      ],
    });

    renderHostWithGate(
      {
        ...EMPTY_PRESENTATION,
        targetKind: "local",
        localBootIntent: true,
        canManageHost: true,
        stage: "slow",
      },
      false,
      undefined,
      GATE_BLOCKING,
    );

    await waitFor(() => {
      expect(screen.getByTestId("window-host-startup-card")).toBeTruthy();
    });
    expect(
      screen.getByTestId("window-host-startup-card").getAttribute("data-cause"),
    ).toBe("cold-start");
    const openSettings = screen.getByTestId("window-host-modal-open-settings");
    expect(openSettings).toBeTruthy();

    // Slow promotes Retry (nothing has FAILED, but the wait has outrun the
    // healthy band) without promoting Report issue - there is still no
    // failure for a report to describe.
    expect(screen.getByTestId("window-host-modal-retry")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Report issue" })).toBeNull();
    expect(openSettings.getAttribute("data-emphasis")).toBe("button");
  });

  it("cold-start, settled failure (provisioningError set): Retry, Report issue and Open settings(button) present; spinner + stage line absent; attempt panel + log toggle present", async () => {
    applySnapshot({
      attached: true,
      effectiveHostId: LOCAL_HOST_ID,
      targetHostId: LOCAL_HOST_ID,
      leases: [
        lease({ hostId: LOCAL_HOST_ID, status: "connecting", dead: null }),
      ],
    });

    // The markers must be AVAILABLE for the body assertions below to mean
    // anything - the attempt panel is what replaces the loading body here, and
    // without markers it renders nothing and "no heading" would be satisfied by
    // an empty body.
    hostStatus.data = BOOTSTRAP_MARKERS;

    renderHostWithGate(
      {
        ...EMPTY_PRESENTATION,
        targetKind: "local",
        localBootIntent: true,
        canManageHost: true,
        provisioningError: new Error("bootstrap exited 1"),
      },
      false,
      new MockTraycerCli(),
      GATE_BLOCKING,
    );

    await waitFor(() => {
      expect(screen.getByTestId("window-host-startup-card")).toBeTruthy();
    });
    const card = screen.getByTestId("window-host-startup-card");
    expect(card.getAttribute("data-cause")).toBe("cold-start");
    expect(card.getAttribute("data-variant")).toBe("offline");
    const openSettings = screen.getByTestId("window-host-modal-open-settings");
    expect(openSettings).toBeTruthy();
    // A SETTLED failure gets its heading back - a crash report under no title
    // reads as debris. This is the one cold-start face that is titled.
    expect(
      screen.getByTestId("window-host-startup-card-title").textContent,
    ).toBe("Traycer Host didn't start");
    expect(
      screen.queryByTestId("window-host-startup-card-description"),
    ).toBeNull();

    expect(screen.getByTestId("window-host-modal-retry")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Report issue" })).toBeTruthy();
    expect(openSettings.getAttribute("data-emphasis")).toBe("button");

    // THE BODY, which this test used to say nothing about - and that silence was
    // worse than an omission. The row was enumerated, so it read as covered,
    // while the arm it covers went on drawing a live "Starting local Traycer
    // Host…" beside the Retry and Report issue asserted above. The ∅ test has
    // had this negative assertion all along; the arm that was actually broken
    // did not.
    //
    // Positive first: the attempt panel is what this arm draws INSTEAD of the
    // loading body, so its presence is what makes the absences below
    // meaningful rather than vacuous.
    expect(screen.getByTestId("local-host-bootstrap-details")).toBeTruthy();
    expect(
      screen.getByTestId("local-host-loading-toggle-details"),
    ).toBeTruthy();

    expect(screen.queryByTestId("local-host-loading-stage")).toBeNull();
    // The copy itself, not just the node: the stage line's fallback is the exact
    // sentence this arm must not say, and asserting the testid alone would pass
    // if the same string were reintroduced anywhere else in the card.
    expect(document.body.textContent).not.toContain("Starting Traycer…");
  });

  it("bypassed: true renders nothing at all", () => {
    applySnapshot({
      attached: true,
      effectiveHostId: null,
      targetHostId: LOCAL_HOST_ID,
      leases: [deadLease(LOCAL_HOST_ID, { reason: "offline" })],
    });

    renderHost(
      { ...EMPTY_PRESENTATION, targetKind: "local", localBootIntent: true },
      true,
      undefined,
    );

    expect(screen.queryByTestId("window-host-modal")).toBeNull();
  });

  it("closes by re-derivation: a later snapshot naming a ready effective host makes the modal disappear with no user interaction", async () => {
    applySnapshot({
      attached: true,
      effectiveHostId: null,
      targetHostId: LOCAL_HOST_ID,
      leases: [deadLease(LOCAL_HOST_ID, { reason: "offline" })],
    });

    renderHost(
      { ...EMPTY_PRESENTATION, targetKind: "local", localBootIntent: true },
      false,
      undefined,
    );

    await waitFor(() => {
      expect(screen.getByTestId("window-host-modal")).toBeTruthy();
    });

    applySnapshot({
      attached: true,
      effectiveHostId: LOCAL_HOST_ID,
      targetHostId: LOCAL_HOST_ID,
      preferredHostId: LOCAL_HOST_ID,
      leases: [lease({ hostId: LOCAL_HOST_ID, status: "ready", dead: null })],
      selectionRevision: 2,
    });

    await waitFor(() => {
      expect(screen.queryByTestId("window-host-modal")).toBeNull();
    });
  });

  it("stays gone after the host has served once, even when its lease goes back to connecting", async () => {
    // THE SERVED LATCH's own job, which the recovery test above cannot reach:
    // there, a ready lease keeps the modal away whether or not the latch
    // exists. Only a host that served and then stopped being ready
    // distinguishes them - and re-opening a window-wide modal there would be
    // the layered narration this epic deletes, because a host that goes quiet
    // after the app is working is the TILE's story, not the window's.
    // Asserted through `narratorSurface()`: the subject is the LATCH, so this
    // fixture must not care which presentation the narrator picked. The gate
    // state is held BLOCKING throughout because this harness's readiness is
    // static - in production it would open once the host served, and the
    // narrator would move from the card to the dialog with the latch
    // behaviour below unchanged.
    applySnapshot({
      attached: true,
      effectiveHostId: LOCAL_HOST_ID,
      targetHostId: LOCAL_HOST_ID,
      leases: [lease({ status: "connecting", dead: null })],
    });
    renderHostWithGate(
      { ...EMPTY_PRESENTATION, targetKind: "local", localBootIntent: true },
      false,
      undefined,
      GATE_BLOCKING,
    );
    await waitFor(() => {
      expect(narratorSurface()).toBeTruthy();
    });

    applySnapshot({
      attached: true,
      effectiveHostId: LOCAL_HOST_ID,
      targetHostId: LOCAL_HOST_ID,
      leases: [lease({ status: "ready", dead: null })],
      selectionRevision: 2,
    });
    await waitFor(() => {
      expect(narratorSurface()).toBeNull();
    });

    applySnapshot({
      attached: true,
      effectiveHostId: LOCAL_HOST_ID,
      targetHostId: LOCAL_HOST_ID,
      leases: [lease({ status: "connecting", dead: null })],
      selectionRevision: 3,
    });
    await waitFor(() => {
      expect(narratorSurface()).toBeNull();
    });

    // ...but ∅ still re-opens it. The latch silences the cold-start arm, not
    // the no-usable-host arm; conflating the two would strand a window whose
    // fleet died after it had been working.
    applySnapshot({
      attached: true,
      effectiveHostId: null,
      targetHostId: LOCAL_HOST_ID,
      leases: [deadLease(LOCAL_HOST_ID, { reason: "offline" })],
      selectionRevision: 4,
    });
    await waitFor(() => {
      expect(narratorSurface()).toBeTruthy();
    });
  });

  it("narrates a NON-ensure mutation lane: the modal reads the lane's own kind", async () => {
    // Actor- AND kind-agnostic. Filtering the lane to `ensure` is the shape the
    // legacy install card used, and it is why a restart or an update running
    // under a window that nothing can serve rendered a silent card.
    controllerStatus.data = {
      mutation: {
        kind: "respawn",
        progress: null,
        startedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    applySnapshot({
      attached: true,
      effectiveHostId: null,
      targetHostId: REMOTE_HOST_ID,
      leases: [deadLease(REMOTE_HOST_ID, { reason: "offline" })],
    });

    renderHost(
      { ...EMPTY_PRESENTATION, targetKind: "remote" },
      false,
      undefined,
    );

    await waitFor(() => {
      expect(screen.getByTestId("window-host-modal")).toBeTruthy();
    });
    expect(
      screen.getByTestId("window-host-modal-progress").textContent,
    ).toContain("Restarting Traycer Host…");
  });

  it("update-host: offers Update now and Open settings, and no Report issue, when the HOST is the outdated leg", async () => {
    applySnapshot({
      attached: true,
      effectiveHostId: null,
      targetHostId: LOCAL_HOST_ID,
      leases: [
        deadLease(LOCAL_HOST_ID, {
          reason: "incompatible",
          detail: {
            code: "protocol-major-behind",
            hostVersion: "1.0.0",
            minSupportedVersion: "1.5.0",
            clientCompatibility: null,
          },
        }),
      ],
    });

    renderHost(
      {
        ...EMPTY_PRESENTATION,
        targetKind: "local",
        localBootIntent: true,
        canManageHost: true,
      },
      false,
      undefined,
    );

    await waitFor(() => {
      expect(screen.getByTestId("window-host-modal")).toBeTruthy();
    });
    expect(
      screen.getByTestId("window-host-modal").getAttribute("data-variant"),
    ).toBe("update-host");
    expect(buttonsOf(screen.getByTestId("window-host-modal"))).toEqual([
      "Update now",
      "Open settings",
    ]);
  });

  it("arm 2: a non-target incompatible host is named and can be updated directly", async () => {
    // `deriveNoHostVariant` arm 2 - "some OTHER lease is dead because it is
    // incompatible", reached when the target is dead for an unrelated reason.
    // Arm 1 (target IS the incompatible host) is what the two tests around this
    // one cover. This arm proves the named remote host's update action stays
    // available even though local provisioning belongs to the other target.
    const forceProvisioning = vi.fn();
    applySnapshot({
      attached: true,
      effectiveHostId: null,
      targetHostId: LOCAL_HOST_ID,
      leases: [
        // Target: this machine, dead but NOT incompatible - so arm 1 misses.
        deadLease(LOCAL_HOST_ID, { reason: "offline" }),
        // A different machine, and the incompatible one. Its version is what
        // the card will quote, which is how the assertions below tell which
        // lease the narration is about.
        deadLease(REMOTE_HOST_ID, {
          reason: "incompatible",
          detail: {
            code: "protocol-major-behind",
            hostVersion: "0.9.0",
            minSupportedVersion: "1.5.0",
            clientCompatibility: null,
          },
        }),
      ],
    });

    renderHost(
      {
        ...EMPTY_PRESENTATION,
        targetKind: "local",
        localBootIntent: true,
        canManageHost: true,
        forceProvisioning,
      },
      false,
      undefined,
    );

    await waitFor(() => {
      expect(screen.getByTestId("window-host-modal")).toBeTruthy();
    });

    // Premise, positively: the narration really is arm 2 - `update-host`, and
    // quoting the REMOTE lease's version rather than the target's. Without
    // this the assertion below could pass on an arm-1 render.
    expect(
      screen.getByTestId("window-host-modal").getAttribute("data-variant"),
    ).toBe("update-host");
    expect(screen.getByTestId("window-host-modal").textContent).toContain(
      "0.9.0",
    );

    expect(
      screen.getByTestId("window-host-modal-update-host").textContent,
    ).toBe("Update now");
    expect(
      screen.getByTestId("window-host-modal-description").textContent,
    ).toBe(
      "That computer's Traycer Host is running a version this app can't talk to. Update it to continue - its agents and history are untouched.",
    );
    expect(forceProvisioning).not.toHaveBeenCalled();
  });

  it("update-host: WITHHOLDS Update host when THIS APP is the outdated leg", async () => {
    // Updating the host cannot fix an outdated client, so offering it is an
    // action that could only fail. Same fleet, same variant, opposite skew -
    // the host version is now AHEAD of this app's pinned 1.5.0.
    applySnapshot({
      attached: true,
      effectiveHostId: null,
      targetHostId: LOCAL_HOST_ID,
      leases: [
        deadLease(LOCAL_HOST_ID, {
          reason: "incompatible",
          detail: {
            code: "protocol-major-ahead",
            hostVersion: "2.0.0",
            minSupportedVersion: "2.0.0",
            clientCompatibility: null,
          },
        }),
      ],
    });

    renderHost(
      {
        ...EMPTY_PRESENTATION,
        targetKind: "local",
        localBootIntent: true,
        canManageHost: true,
      },
      false,
      undefined,
    );

    await waitFor(() => {
      expect(screen.getByTestId("window-host-modal")).toBeTruthy();
    });
    expect(screen.queryByTestId("window-host-modal-update-host")).toBeNull();
  });

  /**
   * The two STRUCTURAL claims jsdom can answer.
   *
   * The finding has a third, geometric half - the toggle centring itself in an
   * otherwise left-aligned card - and no assertion in this file touches it.
   * `self-center` is a resolved box position, and jsdom computes no layout at
   * all, so the only jsdom-visible form of that claim is "the class string does
   * not contain `self-center`", which pins the fix's SPELLING and would pass
   * happily on a build that re-centred the control by any other means. It is
   * measured in a real engine instead, by
   * `scripts/window-host-modal-alignment-browser.mjs`, and recorded as
   * browser-verified-only rather than left reading as covered here.
   *
   * TWO LIMITS OF THAT HARNESS, stated here because this is where a reader comes
   * looking for coverage:
   *
   *  1. It renders the COLD-START body only. Its existence check requires the
   *     spinner, the stage line, the lane detail and the progress bar - four
   *     members the ∅ body does not render - so pointing it at that arm makes it
   *     FAIL rather than measure. The ∅ arm has no rendered alignment
   *     measurement at all; the assertions below are its only coverage.
   *  2. It cannot distinguish the shipped fix from `self-start` +
   *     `justify-center`, which renders at the same left edge. Its own `PC4`
   *     asserts that blindness as a truth table rather than admitting it in
   *     prose, and the grep-style class guard is what actually pins it -
   *     `src/__tests__/local-bootstrap-alignment-lint.test.ts`, where that exact
   *     combination is one of the mutation proofs.
   *
   * WHY THE ∅ ARM HAS NO RENDERED MEASUREMENT, and what would make it need one.
   *
   * Deferred, not forgotten, and the argument is CONDITIONAL - which is the only
   * reason a deferral is a decision rather than a gap. Both arms now route through
   * the same `LocalHostBodyShell`, so alignment is shared BY CONSTRUCTION:
   * measuring the cold-start arm measures the shell, and the ∅ arm uses that
   * shell. A rendered ∅ measurement would be re-verifying one owner through a
   * second door, and building it faithfully needs the readiness controller mounted
   * in a browser fixture - approximating it would measure the fixture.
   *
   * ⚠ THE CONSTRUCTION ARGUMENT DIES the moment anyone gives the ∅ arm alignment
   * of its own - a second root, or centring on one of its children. At that point
   * the shared-owner reasoning no longer holds and the rendered measurement
   * becomes required. What the shell does NOT cover either way is a CHILD carrying
   * its own centring, which is precisely the `text-center` that survived on
   * `local-host-loading-empty-tail` in the one branch nothing measured; the class
   * guard covers its recurrence.
   */
  describe("the local-bootstrap body's structure", () => {
    it("gives BOTH local arms one body root, so alignment has an owner", async () => {
      // The defect class: both bodies were fragments, so their children became
      // direct children of the dialog's own column and each one carried its own
      // alignment or none. Asserted per arm because the two arms are built by
      // different branches of `buildBootBody` - fixing one and
      // leaving the other is exactly how they drift.
      hostStatus.data = BOOTSTRAP_MARKERS;
      applySnapshot({
        attached: true,
        effectiveHostId: LOCAL_HOST_ID,
        targetHostId: LOCAL_HOST_ID,
        leases: [
          lease({ hostId: LOCAL_HOST_ID, status: "connecting", dead: null }),
        ],
      });
      renderHostWithGate(
        { ...EMPTY_PRESENTATION, targetKind: "local", localBootIntent: true },
        false,
        new MockTraycerCli(),
        GATE_BLOCKING,
      );

      await waitFor(() => {
        expect(screen.getByTestId("window-host-startup-card")).toBeTruthy();
      });
      expect(
        screen
          .getByTestId("window-host-startup-card")
          .getAttribute("data-cause"),
      ).toBe("cold-start");

      // ONE root, not one per child: two roots would re-create the same defect
      // with the members regrouped.
      expect(screen.getAllByTestId("local-host-body")).toHaveLength(1);
      const coldStartBody = screen.getByTestId("local-host-body");
      // The root actually CONTAINS the body's members. Without this the
      // assertion above is satisfied by an empty div rendered beside them.
      expect(
        screen
          .getByTestId("local-host-loading-stage")
          .closest('[data-testid="local-host-body"]'),
      ).toBe(coldStartBody);
      expect(
        screen
          .getByTestId("local-host-loading-toggle-details")
          .closest('[data-testid="local-host-body"]'),
      ).toBe(coldStartBody);

      cleanup();
      useSelectionAuthorityStore.getState().reset();

      // The ∅ arm, whose body is a different branch with different members.
      applySnapshot({
        attached: true,
        effectiveHostId: null,
        targetHostId: LOCAL_HOST_ID,
        leases: [deadLease(LOCAL_HOST_ID, { reason: "offline" })],
      });
      renderHost(
        {
          ...EMPTY_PRESENTATION,
          targetKind: "local",
          localBootIntent: true,
          canManageHost: true,
        },
        false,
        new MockTraycerCli(),
      );

      await waitFor(() => {
        expect(screen.getByTestId("window-host-modal")).toBeTruthy();
      });
      expect(
        screen.getByTestId("window-host-modal").getAttribute("data-cause"),
      ).toBe("no-usable-host");
      expect(screen.getAllByTestId("local-host-body")).toHaveLength(1);
      const emptyArmBody = screen.getByTestId("local-host-body");
      expect(
        screen
          .getByTestId("local-host-bootstrap-details")
          .closest('[data-testid="local-host-body"]'),
      ).toBe(emptyArmBody);
      expect(
        screen
          .getByTestId("local-host-loading-toggle-details")
          .closest('[data-testid="local-host-body"]'),
      ).toBe(emptyArmBody);
    });

    it("puts the ∅ arm's attempt panel ABOVE the log toggle, not below it", async () => {
      // Document order, deliberately anchored on the MODAL rather than on the
      // body root: this claim predates the root, so expressing it this way is
      // what lets it be controlled against the tree that actually had the
      // defect. Below the toggle, the panel reads as the toggle's own expanded
      // content - an open dropdown the user never opened.
      hostStatus.data = BOOTSTRAP_MARKERS;
      applySnapshot({
        attached: true,
        effectiveHostId: null,
        targetHostId: LOCAL_HOST_ID,
        leases: [deadLease(LOCAL_HOST_ID, { reason: "offline" })],
      });
      renderHost(
        {
          ...EMPTY_PRESENTATION,
          targetKind: "local",
          localBootIntent: true,
          canManageHost: true,
        },
        false,
        new MockTraycerCli(),
      );

      await waitFor(() => {
        expect(screen.getByTestId("window-host-modal")).toBeTruthy();
      });
      const panel = screen.getByTestId("local-host-bootstrap-details");
      const toggle = screen.getByTestId("local-host-loading-toggle-details");
      // Both present first: an ordering assertion over a missing node is the
      // vacuity this branch keeps catching.
      expect(panel).toBeTruthy();
      expect(toggle).toBeTruthy();
      expect(
        panel.compareDocumentPosition(toggle) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeGreaterThan(0);
    });
  });

  it("a computer that does not admit this account draws board C1's 'No reason known' state and nothing else, on every shell", async () => {
    // A lane on this machine, so the cover's silence about it is a decision.
    controllerStatus.data = {
      mutation: {
        kind: "respawn",
        progress: null,
        startedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    const shells = [
      {
        name: "desktop",
        mobile: false,
        gate: GATE_OPEN,
        testId: "window-host-modal",
      },
      {
        name: "phone",
        mobile: true,
        gate: GATE_OPEN,
        testId: "window-host-startup-card",
      },
      {
        name: "launch",
        mobile: false,
        gate: GATE_BLOCKING,
        testId: "window-host-startup-card",
      },
    ] as const;
    for (const shell of shells) {
      setMobileApp(shell.mobile);
      noteHostDoorState({
        hostId: LOCAL_HOST_ID,
        kind: "not-admitted",
        detail: null,
      });
      applySnapshot({
        attached: true,
        effectiveHostId: null,
        targetHostId: LOCAL_HOST_ID,
        leases: [],
      });
      renderHostWithGate(
        { ...EMPTY_PRESENTATION, targetKind: "local", canManageHost: true },
        false,
        new MockTraycerCli(),
        shell.gate,
      );

      const surface = await screen.findByTestId(shell.testId);
      expect(surface.getAttribute("data-variant"), shell.name).toBe(
        "not-admitted",
      );
      const title = within(surface).getByRole("heading");
      expect(title.textContent, shell.name).toBe(
        "This account cannot access this computer",
      );
      expect(
        within(surface).getByText("Switch accounts to use it."),
      ).toBeTruthy();
      expect(
        within(surface)
          .getAllByRole("button")
          .map((button) => button.textContent),
        shell.name,
      ).toEqual(["Open settings"]);
      expect(
        within(surface)
          .getByTestId("window-host-modal-open-settings")
          .getAttribute("data-emphasis"),
        shell.name,
      ).toBe("link");
      expect(
        within(surface).queryByTestId("window-host-modal-progress"),
        shell.name,
      ).toBeNull();

      cleanup();
      useSelectionAuthorityStore.getState().reset();
      useHostDoorStateStore.setState({ byHost: new Map() });
    }
  });

  async function renderDoorCover(state: HostDoorState): Promise<{
    readonly surface: HTMLElement;
    readonly runnerHost: MockRunnerHost;
  }> {
    noteHostDoorState(state);
    applySnapshot({
      attached: true,
      effectiveHostId: null,
      targetHostId: LOCAL_HOST_ID,
      leases: [],
    });
    const { runnerHost } = renderHostWithGate(
      {
        ...EMPTY_PRESENTATION,
        targetKind: "local",
        canManageHost: true,
        provisioningError: new Error("install failed"),
      },
      false,
      new MockTraycerCli(),
      GATE_OPEN,
    );
    return {
      surface: await screen.findByTestId("window-host-modal"),
      runnerHost,
    };
  }

  it("message 1, a token that cannot be had: its words and Open settings only", async () => {
    const { surface } = await renderDoorCover({
      hostId: LOCAL_HOST_ID,
      kind: "token-unavailable",
      detail: null,
    });
    expect(within(surface).getByRole("heading").textContent).toBe(
      "We can't confirm access to this computer right now",
    );
    expect(
      within(surface).getByText("We'll try again. Your draft is saved."),
    ).toBeTruthy();
    expect(buttonsOf(surface)).toEqual(["Open settings"]);
  });

  it("message 3, keys never fetched: its words, Retry and Open settings; Retry reconnects to that computer", async () => {
    const { surface } = await renderDoorCover({
      hostId: LOCAL_HOST_ID,
      kind: "keys-unavailable",
      detail: null,
    });
    expect(within(surface).getByRole("heading").textContent).toBe(
      "This computer needs to connect once before it can verify access",
    );
    expect(
      within(surface).getByText("Check its connection, then retry."),
    ).toBeTruthy();
    expect(buttonsOf(surface)).toEqual(["Retry", "Open settings"]);

    const rebuildNow = vi.fn();
    const stopHearing = onHostDoorRetry(LOCAL_HOST_ID, rebuildNow);
    fireEvent.click(within(surface).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(rebuildNow).toHaveBeenCalledTimes(1));
    stopHearing();
  });

  it("message 4, a wrong clock: its words, Retry and Open settings", async () => {
    const { surface } = await renderDoorCover({
      hostId: LOCAL_HOST_ID,
      kind: "clock-skew",
      detail: null,
    });
    expect(within(surface).getByRole("heading").textContent).toBe(
      "This computer's date or time appears incorrect",
    );
    expect(
      within(surface).getByText(
        "Enable automatic date and time on that computer, then retry.",
      ),
    ).toBeTruthy();
    expect(buttonsOf(surface)).toEqual(["Retry", "Open settings"]);
  });

  it("message 5, an expired token: its words, Retry and Open settings", async () => {
    const { surface } = await renderDoorCover({
      hostId: LOCAL_HOST_ID,
      kind: "token-expired",
      detail: null,
    });
    expect(within(surface).getByRole("heading").textContent).toBe(
      "Access needs to be renewed before you can reconnect",
    );
    expect(
      within(surface).getByText(
        "Connect to the internet and retry. Work already started remains on this computer.",
      ),
    ).toBeTruthy();
    expect(buttonsOf(surface)).toEqual(["Retry", "Open settings"]);
  });

  it("message 5's Retry still reconnects when the new token cannot be had, and owns the failure", async () => {
    useAuthStore.setState({
      contextMetadata: { userId: "retry-user", username: "retry-user" },
    });
    const { surface, runnerHost } = await renderDoorCover({
      hostId: LOCAL_HOST_ID,
      kind: "token-expired",
      detail: null,
    });
    vi.spyOn(runnerHost.hostTokens, "obtain").mockRejectedValue(
      new Error("token storage is unavailable"),
    );
    const warn = vi.spyOn(appLogger, "warn");
    const rebuildNow = vi.fn();
    const stopHearing = onHostDoorRetry(LOCAL_HOST_ID, rebuildNow);

    fireEvent.click(within(surface).getByRole("button", { name: "Retry" }));

    await waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        "[host-door] retry token refresh failed",
        { hostId: LOCAL_HOST_ID },
      ),
    );
    expect(rebuildNow).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("window-host-modal")).toBe(surface);
    stopHearing();
  });

  it("message 6, a broken enrolment: its words and Open settings only", async () => {
    const { surface } = await renderDoorCover({
      hostId: LOCAL_HOST_ID,
      kind: "enrolment-broken",
      detail: null,
    });
    expect(within(surface).getByRole("heading").textContent).toBe(
      "This computer's connection to the team needs repair",
    );
    expect(
      within(surface).getByText(
        "Ask a team administrator to restore it. Work is still stored here.",
      ),
    ).toBeTruthy();
    expect(buttonsOf(surface)).toEqual(["Open settings"]);
  });

  it("message 7, a removed membership: its words and Open settings only", async () => {
    const { surface } = await renderDoorCover({
      hostId: LOCAL_HOST_ID,
      kind: "membership-removed",
      detail: null,
    });
    expect(within(surface).getByRole("heading").textContent).toBe(
      "You no longer have access to this team's computer",
    );
    expect(
      within(surface).getByText("Work you started continues for the team."),
    ).toBeTruthy();
    expect(buttonsOf(surface)).toEqual(["Open settings"]);
  });

  it("message 8, not a member: Switch account and Open settings only", async () => {
    const { surface } = await renderDoorCover({
      hostId: LOCAL_HOST_ID,
      kind: "not-a-member",
      detail: null,
    });
    expect(within(surface).getByRole("heading").textContent).toBe(
      "This computer belongs to a team",
    );
    expect(
      within(surface).getByText(
        "This account is not a member. Switch accounts to use Traycer here.",
      ),
    ).toBeTruthy();
    expect(buttonsOf(surface)).toEqual(["Switch account", "Open settings"]);
  });

  it("unknown refusal keeps the offline cover and adds only its reason line", async () => {
    const { surface } = await renderDoorCover({
      hostId: LOCAL_HOST_ID,
      kind: "unrecognised-refusal",
      detail: { code: "UNAUTHORIZED", doorReason: "some_future_reason" },
    });
    expect(within(surface).getByRole("heading").textContent).toBe(
      "No host is available",
    );
    expect(
      within(surface).getByText(
        "Traycer can't reach any of this account's hosts right now. It will connect again on its own as soon as one comes back.",
      ),
    ).toBeTruthy();
    expect(
      within(surface).getByTestId("window-host-modal-refusal-detail")
        .textContent,
    ).toBe("Reason: UNAUTHORIZED");
    expect(buttonsOf(surface)).toEqual([
      "Retry",
      "Open settings",
      "Report issue",
    ]);
  });

  async function renderDoorCoverCard(
    state: HostDoorState,
    shell: "phone" | "launch",
  ): Promise<HTMLElement> {
    setMobileApp(shell === "phone");
    noteHostDoorState(state);
    applySnapshot({
      attached: true,
      effectiveHostId: null,
      targetHostId: LOCAL_HOST_ID,
      leases: [],
    });
    renderHostWithGate(
      {
        ...EMPTY_PRESENTATION,
        targetKind: "local",
        canManageHost: true,
        provisioningError: new Error("install failed"),
      },
      false,
      new MockTraycerCli(),
      shell === "launch" ? GATE_BLOCKING : GATE_OPEN,
    );
    return screen.findByTestId("window-host-startup-card");
  }

  async function expectCardMessage(
    shell: "phone" | "launch",
    state: HostDoorState,
    copy: {
      readonly title: string;
      readonly description: string;
      readonly actions: readonly string[];
    },
  ): Promise<void> {
    const surface = await renderDoorCoverCard(state, shell);
    expect(
      within(surface).getByTestId("window-host-startup-card-title").textContent,
    ).toBe(copy.title);
    expect(
      within(surface).getByTestId("window-host-startup-card-description")
        .textContent,
    ).toBe(copy.description);
    expect(buttonsOf(surface)).toEqual(copy.actions);
    expect(
      within(surface).queryByTestId("window-host-modal-progress"),
    ).toBeNull();
  }

  describe("board C1 covers on the phone and launch cards", () => {
    it("message 1 on the phone card keeps its words and Open settings only", async () => {
      await expectCardMessage(
        "phone",
        { hostId: LOCAL_HOST_ID, kind: "token-unavailable", detail: null },
        {
          title: "We can't confirm access to this computer right now",
          description: "We'll try again. Your draft is saved.",
          actions: ["Open settings"],
        },
      );
    });

    it("message 3 on the phone card keeps its words, Retry and Open settings", async () => {
      await expectCardMessage(
        "phone",
        { hostId: LOCAL_HOST_ID, kind: "keys-unavailable", detail: null },
        {
          title:
            "This computer needs to connect once before it can verify access",
          description: "Check its connection, then retry.",
          actions: ["Retry", "Open settings"],
        },
      );
    });

    it("message 4 on the phone card keeps its words, Retry and Open settings", async () => {
      await expectCardMessage(
        "phone",
        { hostId: LOCAL_HOST_ID, kind: "clock-skew", detail: null },
        {
          title: "This computer's date or time appears incorrect",
          description:
            "Enable automatic date and time on that computer, then retry.",
          actions: ["Retry", "Open settings"],
        },
      );
    });

    it("message 5 on the phone card keeps its words, Retry and Open settings", async () => {
      await expectCardMessage(
        "phone",
        { hostId: LOCAL_HOST_ID, kind: "token-expired", detail: null },
        {
          title: "Access needs to be renewed before you can reconnect",
          description:
            "Connect to the internet and retry. Work already started remains on this computer.",
          actions: ["Retry", "Open settings"],
        },
      );
    });

    it("message 6 on the phone card keeps its words and Open settings only", async () => {
      await expectCardMessage(
        "phone",
        { hostId: LOCAL_HOST_ID, kind: "enrolment-broken", detail: null },
        {
          title: "This computer's connection to the team needs repair",
          description:
            "Ask a team administrator to restore it. Work is still stored here.",
          actions: ["Open settings"],
        },
      );
    });

    it("message 7 on the phone card keeps its words and Open settings only", async () => {
      await expectCardMessage(
        "phone",
        { hostId: LOCAL_HOST_ID, kind: "membership-removed", detail: null },
        {
          title: "You no longer have access to this team's computer",
          description: "Work you started continues for the team.",
          actions: ["Open settings"],
        },
      );
    });

    it("message 8 on the phone card keeps its words, Switch account and Open settings", async () => {
      await expectCardMessage(
        "phone",
        { hostId: LOCAL_HOST_ID, kind: "not-a-member", detail: null },
        {
          title: "This computer belongs to a team",
          description:
            "This account is not a member. Switch accounts to use Traycer here.",
          actions: ["Switch account", "Open settings"],
        },
      );
    });

    it("message 1 on the launch card keeps its words and Open settings only", async () => {
      await expectCardMessage(
        "launch",
        { hostId: LOCAL_HOST_ID, kind: "token-unavailable", detail: null },
        {
          title: "We can't confirm access to this computer right now",
          description: "We'll try again. Your draft is saved.",
          actions: ["Open settings"],
        },
      );
    });

    it("message 3 on the launch card keeps its words, Retry and Open settings", async () => {
      await expectCardMessage(
        "launch",
        { hostId: LOCAL_HOST_ID, kind: "keys-unavailable", detail: null },
        {
          title:
            "This computer needs to connect once before it can verify access",
          description: "Check its connection, then retry.",
          actions: ["Retry", "Open settings"],
        },
      );
    });

    it("message 4 on the launch card keeps its words, Retry and Open settings", async () => {
      await expectCardMessage(
        "launch",
        { hostId: LOCAL_HOST_ID, kind: "clock-skew", detail: null },
        {
          title: "This computer's date or time appears incorrect",
          description:
            "Enable automatic date and time on that computer, then retry.",
          actions: ["Retry", "Open settings"],
        },
      );
    });

    it("message 5 on the launch card keeps its words, Retry and Open settings", async () => {
      await expectCardMessage(
        "launch",
        { hostId: LOCAL_HOST_ID, kind: "token-expired", detail: null },
        {
          title: "Access needs to be renewed before you can reconnect",
          description:
            "Connect to the internet and retry. Work already started remains on this computer.",
          actions: ["Retry", "Open settings"],
        },
      );
    });

    it("message 6 on the launch card keeps its words and Open settings only", async () => {
      await expectCardMessage(
        "launch",
        { hostId: LOCAL_HOST_ID, kind: "enrolment-broken", detail: null },
        {
          title: "This computer's connection to the team needs repair",
          description:
            "Ask a team administrator to restore it. Work is still stored here.",
          actions: ["Open settings"],
        },
      );
    });

    it("message 7 on the launch card keeps its words and Open settings only", async () => {
      await expectCardMessage(
        "launch",
        { hostId: LOCAL_HOST_ID, kind: "membership-removed", detail: null },
        {
          title: "You no longer have access to this team's computer",
          description: "Work you started continues for the team.",
          actions: ["Open settings"],
        },
      );
    });

    it("message 8 on the launch card keeps its words, Switch account and Open settings", async () => {
      await expectCardMessage(
        "launch",
        { hostId: LOCAL_HOST_ID, kind: "not-a-member", detail: null },
        {
          title: "This computer belongs to a team",
          description:
            "This account is not a member. Switch accounts to use Traycer here.",
          actions: ["Switch account", "Open settings"],
        },
      );
    });
  });

  /**
   * The mobile app's post-latch narration, whose subject is the DOCUMENT rather
   * than the copy: a modal layer over a mounted shell raises the pointer
   * barrier, and on that shell the barrier is what the edge-swipe recognizer
   * reads before it reserves a touch. The gesture is the phone's only history
   * affordance, so the narration must not cost it.
   */
  describe("on the mobile app", () => {
    beforeEach(() => {
      setMobileApp(true);
    });

    function applyPostLatchEmptyFleet(): void {
      applySnapshot({
        attached: true,
        effectiveHostId: null,
        targetHostId: REMOTE_HOST_ID,
        leases: [deadLease(REMOTE_HOST_ID, { reason: "offline" })],
      });
    }

    it("post-latch ∅ narrates through the non-modal card, and raises no document barrier", async () => {
      applyPostLatchEmptyFleet();

      renderHost(
        { ...EMPTY_PRESENTATION, targetKind: "remote" },
        false,
        undefined,
      );

      // Existence before absence: a narrator that rendered nothing at all would
      // satisfy both negative assertions below.
      await waitFor(() => {
        expect(screen.getByTestId("window-host-startup-card")).toBeTruthy();
      });
      expect(
        screen
          .getByTestId("window-host-startup-card")
          .getAttribute("data-cause"),
      ).toBe("no-usable-host");
      // The words survive the presentation change - this is still the surface
      // that says a fleet is unreachable, and it still offers the escape hatch.
      expect(
        screen.getByTestId("window-host-modal-open-settings"),
      ).toBeTruthy();

      expect(screen.queryByTestId("window-host-modal")).toBeNull();
      expect(screen.queryByTestId("window-host-modal-overlay")).toBeNull();
      expect(document.body.style.pointerEvents).not.toBe("none");
    });

    // The novelty guard: a narrator that had simply stopped drawing the dialog
    // everywhere would pass the case above just as well as one that forks on
    // the product signal, and the dialog is still the honest form on a shell
    // whose app is driven with a pointer.
    it("leaves the dialog in place on every other shell", async () => {
      setMobileApp(false);
      applyPostLatchEmptyFleet();

      renderHost(
        { ...EMPTY_PRESENTATION, targetKind: "remote" },
        false,
        undefined,
      );

      await waitFor(() => {
        expect(screen.getByTestId("window-host-modal")).toBeTruthy();
      });
      expect(screen.queryByTestId("window-host-startup-card")).toBeNull();
    });
  });
});

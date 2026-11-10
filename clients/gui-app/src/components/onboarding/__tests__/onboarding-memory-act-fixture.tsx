/**
 * The faked host and the helpers shared by the Memory act's test files: the
 * real tour over a `MockHostMessenger` with a recorded negotiated manifest.
 * The `vi.mock` calls stay in each test file, which hoists its own.
 */
import { expect, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { LazyMotion, MotionGlobalConfig, domMax } from "motion/react";
import {
  MockRunnerHost,
  MockTraycerCli,
} from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { remoteEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { IStreamSession } from "@traycer/protocol/host-transport/stream-session";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
  type ProviderCliState,
  type ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import { environmentStatusResponseSchemaV12 } from "@traycer/protocol/host/environment-schemas";
import { RequestContext } from "@/components/onboarding/__tests__/onboarding-memory-act-request-context";
import { OnboardingPage } from "@/components/onboarding/onboarding-page";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  HostRuntimeProvider,
  hostRpcRegistry,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import { StreamRuntimeContext } from "@/lib/host/stream-runtime-context";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { WindowsBridgeContext } from "@/providers/windows-bridge-context";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";

export const HOST_ID = "memory-act-host";
/** A second machine, which the host picker offers as a remote host. */
export const OTHER_HOST = remoteEntry("memory-act-other-host", null);
export const ENVIRONMENT_ID = "env-personal";

interface ProviderSpec {
  readonly providerId: ProviderId;
  readonly enabled: boolean;
  readonly supported: boolean;
  readonly nativeMemory: boolean;
}
type SetAnswer = "applied" | "queued" | "fail";
interface Receipt {
  readonly uploadId: string;
  readonly environmentId: string;
}
interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

/** What the faked host holds and answers. Reset for every test. */
interface World {
  memoriesOn: boolean;
  providers: ProviderSpec[];
  /** Answers to `config.agentMemories.set` in order; the last one repeats. */
  setAnswers: SetAnswer[];
  /** Per harness id: how many more `providers.setNativeMemory` calls fail. */
  nativeFailures: Map<string, number>;
  accepted: Receipt[];
  refused: string[];
  /** Holds `config.agentMemories.set` open until resolved. */
  setGate: Deferred | null;
  /** Holds `providers.setNativeMemory` open until resolved. */
  nativeGate: Deferred | null;
  sessionImport: boolean;
  /** Hosts besides the tour's own that the host picker offers. */
  otherHosts: RemoteHostDirectoryEntry[];
}

export function defaultProviders(): ProviderSpec[] {
  return [
    {
      providerId: "claude-code",
      enabled: true,
      supported: true,
      nativeMemory: true,
    },
    { providerId: "codex", enabled: true, supported: true, nativeMemory: true },
  ];
}

function freshWorld(): World {
  return {
    memoriesOn: false,
    providers: defaultProviders(),
    setAnswers: ["applied"],
    nativeFailures: new Map(),
    accepted: [],
    refused: [],
    setGate: null,
    nativeGate: null,
    sessionImport: true,
    otherHosts: [],
  };
}

export const world = freshWorld();
const messengers: MockHostMessenger<HostRpcRegistry>[] = [];

export function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function hostFailure(method: string): HostRpcError {
  return new HostRpcError({
    code: "RPC_ERROR",
    message: "refused",
    requestId: "memory-act",
    method,
    fatalDetails: null,
  });
}

function providerState(spec: ProviderSpec): ProviderCliState {
  return {
    providerId: spec.providerId,
    enabled: spec.enabled,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    nativeCapabilities: DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
    managedInstallState: null,
    versionVisibility: null,
    advisory: null,
    profiles: [],
    nativeMemory: spec.nativeMemory,
    nativeMemorySupported: spec.supported,
  };
}

function statusAnswer() {
  return environmentStatusResponseSchemaV12.parse({
    principal: { kind: "personal" },
    reachability: "connected",
    bindingGeneration: 1,
    desiredRevision: 1,
    receivedRevision: 1,
    appliedRevision: 1,
    receiptAgeMs: 0,
    items: [],
    pendingUploads: world.refused.map((uploadId) => ({
      uploadId,
      kind: "agent_memory",
      key: "memory",
      os: "any",
      queuedAt: 1,
      receipt: "refused",
      code: null,
    })),
    setup: null,
    remoteAccess: "off",
    acceptedUploads: world.accepted.map((receipt) => ({
      uploadId: receipt.uploadId,
      kind: "agent_memory",
      key: "memory",
      os: "any",
      environmentId: receipt.environmentId,
      revision: 3,
      acceptedAt: 1,
    })),
  });
}

let setCalls = 0;
const messengerFactory: MessengerFactory<HostRpcRegistry> = ({ registry }) => {
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry,
    requestId: () => `memory-act-${String(messengers.length)}`,
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
      "providers.list": () => ({
        providers: world.providers.map(providerState),
        native: null,
      }),
      "config.agentMemories.get": () => ({
        enabled: world.memoriesOn,
        revision: 4,
        environmentId: ENVIRONMENT_ID,
      }),
      "config.agentMemories.set": async (request) => {
        const answer =
          world.setAnswers[Math.min(setCalls, world.setAnswers.length - 1)];
        setCalls += 1;
        if (world.setGate !== null) await world.setGate.promise;
        if (answer === "fail") throw hostFailure("config.agentMemories.set");
        if (answer === "queued")
          return {
            enabled: world.memoriesOn,
            state: "queued" as const,
            revision: null,
            environmentId: ENVIRONMENT_ID,
            uploadId: "upload-1",
          };
        world.memoriesOn = request.enabled;
        return {
          enabled: request.enabled,
          state: "applied" as const,
          revision: 5,
          environmentId: ENVIRONMENT_ID,
          uploadId: null,
        };
      },
      "providers.setNativeMemory": async (request) => {
        if (world.nativeGate !== null) await world.nativeGate.promise;
        const failures = world.nativeFailures.get(request.harnessId) ?? 0;
        if (failures > 0) {
          world.nativeFailures.set(request.harnessId, failures - 1);
          throw hostFailure("providers.setNativeMemory");
        }
        return { nativeMemory: request.nativeMemory };
      },
      "environment.status": () => statusAnswer(),
    },
  });
  messengers.push(messenger);
  return messenger;
};

/** Every recorded call of one method, in the order the host received them. */
export function paramsOf(method: string): unknown[] {
  return hostCalls()
    .filter((call) => call.method === method)
    .map((call) => call.params);
}
export function hostCalls(): { method: string; params: unknown }[] {
  return messengers
    .flatMap((messenger) => messenger.calls)
    .filter((call) => call.method !== "host.status");
}
/** The recorded calls one host's address received, in order. */
export function callsTo(hostId: string): { method: string; params: unknown }[] {
  return messengers
    .flatMap((messenger) => messenger.calls)
    .filter((call) => call.authority.endpoint.hostId === hostId)
    .filter((call) => call.method !== "host.status");
}

export function methodsInOrder(): string[] {
  return hostCalls().map((call) => call.method);
}

const localHost = {
  hostId: HOST_ID,
  websocketUrl: "ws://127.0.0.1:9/rpc",
  version: "1.2.3",
  pid: 4547,
  systemHostName: "tanveer-mbp",
  displayName: "MacBook Pro",
  availability: "available",
} as const;

const silentSession: IStreamSession = {
  sendClientFrame: () => undefined,
  onServerFrame: () => undefined,
  onStatusChange: () => undefined,
  getNegotiatedSchemaVersion: () => null,
  requestReconnect: () => undefined,
  close: () => undefined,
};

function streamBinding() {
  const client: IHostStreamClient<HostStreamRpcRegistry> = {
    subscribe: () => silentSession,
    subscribeWithParamsProvider: () => silentSession,
    close: () => undefined,
    isClosed: () => false,
    isReady: () => true,
    notifyBearerRotated: () => undefined,
    notifyCloudVerdictChanged: () => undefined,
    reconnectAll: () => undefined,
    getMethodSupport: () =>
      world.sessionImport ? "unknown" : ("unsupported" as const),
    subscribeMethodSupport: () => () => undefined,
    getMethodSchemaVersion: () => null,
    subscribeAvailabilityRecovered: () => () => undefined,
    getClosedReason: () => null,
    onClosed: () => () => undefined,
    instanceId: "memory-act-stream",
  };
  return { wsStreamClient: client, hostId: HOST_ID, retain: null };
}

let queryClient = new QueryClient();

/** What the page's own invalidation does when a provider is toggled on the Providers act. */
export function invalidateAllQueries(): Promise<void> {
  return queryClient.invalidateQueries();
}

function renderTour(): void {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const runnerHost = new MockRunnerHost({
    signInUrl: "http://127.0.0.1:9/sign-in",
    authnBaseUrl: "http://127.0.0.1:9",
    localHost,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: new MockTraycerCli(),
  });
  for (const other of world.otherHosts)
    recordNegotiatedHostManifest(other.hostId, FULL_MANIFEST);
  const streams = streamBinding();
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider runnerHost={runnerHost}>
          <HostRuntimeProvider
            registry={hostRpcRegistry}
            messengerFactory={messengerFactory}
            invalidator={null}
            requestId={null}
            remoteFetcher={() =>
              Promise.resolve({ kind: "hosts", entries: world.otherHosts })
            }
            fallback={<div data-testid="memory-act-fallback" />}
          >
            <WindowsBridgeContext.Provider
              value={{ bridge: null, hasHydrated: true }}
            >
              <StreamRuntimeContext.Provider value={streams}>
                <TooltipProvider>
                  <RequestContext>
                    <LazyMotion features={domMax}>
                      <OnboardingPage />
                    </LazyMotion>
                  </RequestContext>
                </TooltipProvider>
              </StreamRuntimeContext.Provider>
            </WindowsBridgeContext.Provider>
          </HostRuntimeProvider>
        </RunnerHostProvider>
      </QueryClientProvider>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(<RouterProvider router={router} />);
}

const FULL_MANIFEST = {
  "providers.list": { major: 10, minor: 8 },
  "providers.setNativeMemory": { major: 1, minor: 0 },
  "environment.status": { major: 1, minor: 2 },
  "config.agentMemories.get": { major: 1, minor: 0 },
  "config.agentMemories.set": { major: 1, minor: 0 },
} as const;

export function currentStepId(): string | null {
  return screen.getByTestId("onboarding-step").getAttribute("data-step-id");
}

export async function clickAdvance(): Promise<void> {
  fireEvent.click(await screen.findByTestId("onboarding-advance"));
}

/** The tour past its welcome, on the first act. */
export async function enterTour(): Promise<void> {
  renderTour();
  const skipWelcome = await screen.findByTestId("onboarding-welcome-skip");
  // The hand-off is a pair of timeouts; only those run on the fake clock.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    fireEvent.click(skipWelcome);
    void act(() => vi.advanceTimersByTime(320));
  } finally {
    vi.useRealTimers();
  }
  await waitFor(() =>
    expect(screen.queryByTestId("onboarding-welcome-skip")).toBeNull(),
  );
  // The tour starts itself over when it mounts, so a position set before it
  // is up would be undone.
  await screen.findByTestId("onboarding-step", {});
}

/** The Memory act, reached by the store's own re-seat. */
export async function openMemoryAct(): Promise<void> {
  await enterTour();
  act(() => useOnboardingStore.getState().reseat(2));
  await screen.findByTestId("onboarding-memory-stage");
}

/** The Memory act, reached the way a person does: Continue through Providers. */
export async function walkToMemoryAct(): Promise<void> {
  await enterTour();
  await clickAdvance();
  await expectOnStep("providers");
  await clickAdvance();
  await screen.findByTestId("onboarding-memory-stage");
}

export async function chooseTraycer(): Promise<void> {
  fireEvent.click(await screen.findByTestId("onboarding-memory-use"));
  await screen.findByTestId("onboarding-memory-traycer");
}

export function switchOf(testId: string): HTMLElement {
  return within(screen.getByTestId(testId)).getByRole("switch");
}
export async function providerSwitch(providerId: string): Promise<HTMLElement> {
  await screen.findByTestId(`onboarding-memory-provider-${providerId}`);
  return switchOf(`onboarding-memory-provider-${providerId}`);
}
export function isOn(element: HTMLElement): boolean {
  return element.getAttribute("aria-checked") === "true";
}

export async function continueFromMemory(): Promise<void> {
  fireEvent.click(await screen.findByTestId("onboarding-advance"));
}
export async function expectOnStep(stepId: string): Promise<void> {
  await waitFor(() => expect(currentStepId()).toBe(stepId));
}
/** Every write the page sent has been answered and its caller has resumed. */
export async function writesAnswered(): Promise<void> {
  await waitFor(() => expect(queryClient.isMutating()).toBe(0));
  await act(() => Promise.resolve());
}
/** Every read and write the page started has been answered. */
export async function settled(): Promise<void> {
  await waitFor(() => {
    expect(queryClient.isFetching()).toBe(0);
    expect(queryClient.isMutating()).toBe(0);
  });
}

const skipAnimationsBefore = MotionGlobalConfig.skipAnimations;

const scrollToDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollTo",
);

/** Replaces the negotiated manifest the host answered the handshake with. */
export function negotiateManifest(
  manifest: Parameters<typeof recordNegotiatedHostManifest>[1],
): void {
  resetNegotiatedManifests();
  recordNegotiatedHostManifest(HOST_ID, manifest);
}

/** Every test file's beforeEach: a fresh host, manifest, store and scroll stub. */
export function resetMemoryActFixture(): void {
  // Motion keeps its frame loop at module level for the whole worker; a file
  // that ran before this one on a fake clock can leave it stalled, and the
  // tour's step changes then never finish. Without animations they do not
  // need it.
  MotionGlobalConfig.skipAnimations = true;
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
  Object.assign(world, freshWorld());
  setCalls = 0;
  messengers.length = 0;
  resetNegotiatedManifests();
  recordNegotiatedHostManifest(HOST_ID, FULL_MANIFEST);
  useOnboardingStore.setState({ completedAt: null, step: 0 });
}

/** Every test file's afterEach. */
export function cleanupMemoryActFixture(): void {
  MotionGlobalConfig.skipAnimations = skipAnimationsBefore;
  cleanup();
  if (scrollToDescriptor === undefined)
    Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  else
    Object.defineProperty(
      HTMLElement.prototype,
      "scrollTo",
      scrollToDescriptor,
    );
  resetNegotiatedManifests();
  useOnboardingStore.setState({ completedAt: null, step: 0 });
}

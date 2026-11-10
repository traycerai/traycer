/**
 * The tour's Memory act, end to end: the real `OnboardingPage`, the real
 * hook, stage, mutations and queries, over a host that is faked at the
 * messenger (`MockHostMessenger` handlers + a recorded negotiated manifest).
 * Every host effect is asserted from the messenger's recorded calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useEffect, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { LazyMotion, domMax } from "motion/react";
import {
  MockRunnerHost,
  MockTraycerCli,
} from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { createRendererContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { IStreamSession } from "@traycer/protocol/host-transport/stream-session";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
  type ProviderCliState,
  type ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import { environmentStatusResponseSchemaV12 } from "@traycer/protocol/host/environment-schemas";
import { OnboardingPage } from "@/components/onboarding/onboarding-page";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  HostRuntimeProvider,
  hostRpcRegistry,
  useHostBinding,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import { StreamRuntimeContext } from "@/lib/host/stream-runtime-context";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { WindowsBridgeContext } from "@/providers/windows-bridge-context";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";

vi.mock("@/components/auth/cinematic-backdrop", () => ({
  BrandMark: () => <span aria-hidden="true" />,
}));
vi.mock("@/components/onboarding/onboarding-workspace-illustration", () => ({
  OnboardingWorkspaceIllustration: () => (
    <div data-testid="workspace-illustration" />
  ),
}));
vi.mock("@/components/onboarding/onboarding-provider-discovery", () => ({
  OnboardingProviderPrefetch: () => null,
}));
vi.mock("@/components/onboarding/onboarding-detected-agents", () => ({
  OnboardingDetectedAgents: () => <div data-testid="detected-agents-stub" />,
}));
vi.mock("@/components/session-import/session-import-wizard", () => ({
  SessionImportWizard: () => <div data-testid="session-import-wizard" />,
}));
vi.mock("@/components/session-import/use-session-import-scan", () => ({
  useSessionImportScan: () => ({
    state: { kind: "scan-stub" },
    dispatch: () => undefined,
  }),
}));
const navigateMock = vi.fn();
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigateMock,
}));

const HOST_ID = "memory-act-host";
const ENVIRONMENT_ID = "env-personal";

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
  sessionImport: boolean;
}

function defaultProviders(): ProviderSpec[] {
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
    sessionImport: true,
  };
}

let world = freshWorld();
const messengers: MockHostMessenger<HostRpcRegistry>[] = [];

function deferred(): Deferred {
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
      "providers.setNativeMemory": (request) => {
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
function paramsOf(method: string): unknown[] {
  return hostCalls()
    .filter((call) => call.method === method)
    .map((call) => call.params);
}
function hostCalls(): { method: string; params: unknown }[] {
  return messengers
    .flatMap((messenger) => messenger.calls)
    .filter((call) => call.method !== "host.status");
}
function methodsInOrder(): string[] {
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

function RequestContext(props: { readonly children: ReactNode }): ReactNode {
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

let queryClient = new QueryClient();

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
              Promise.resolve({ kind: "hosts", entries: [] })
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

function currentStepId(): string | null {
  return screen.getByTestId("onboarding-step").getAttribute("data-step-id");
}

async function clickAdvance(): Promise<void> {
  fireEvent.click(await screen.findByTestId("onboarding-advance"));
}

/** The tour past its welcome, on the first act. */
async function enterTour(): Promise<void> {
  renderTour();
  fireEvent.click(await screen.findByTestId("onboarding-welcome-skip"));
  await waitFor(
    () => expect(screen.queryByTestId("onboarding-welcome-skip")).toBeNull(),
    { timeout: 3000 },
  );
}

async function openMemoryAct(): Promise<void> {
  await enterTour();
  await clickAdvance();
  await expectOnStep("providers");
  await clickAdvance();
  await screen.findByTestId("onboarding-memory-stage");
}

async function chooseTraycer(): Promise<void> {
  fireEvent.click(await screen.findByTestId("onboarding-memory-use"));
  await screen.findByTestId("onboarding-memory-traycer");
}

function switchOf(testId: string): HTMLElement {
  return within(screen.getByTestId(testId)).getByRole("switch");
}
async function providerSwitch(providerId: string): Promise<HTMLElement> {
  await screen.findByTestId(`onboarding-memory-provider-${providerId}`);
  return switchOf(`onboarding-memory-provider-${providerId}`);
}
function isOn(element: HTMLElement): boolean {
  return element.getAttribute("aria-checked") === "true";
}

async function continueFromMemory(): Promise<void> {
  fireEvent.click(await screen.findByTestId("onboarding-advance"));
}
async function expectOnStep(stepId: string): Promise<void> {
  await waitFor(() => expect(currentStepId()).toBe(stepId));
}
/** Every write the page sent has been answered and its caller has resumed. */
async function writesAnswered(): Promise<void> {
  await waitFor(() => expect(queryClient.isMutating()).toBe(0));
  await act(() => Promise.resolve());
}
/** Lets queued renders and reads that send nothing run before a negative check. */
async function settled(): Promise<void> {
  await act(async () => {
    await new Promise((done) => setTimeout(done, 0));
  });
}

const scrollToDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollTo",
);

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
  world = freshWorld();
  setCalls = 0;
  messengers.length = 0;
  navigateMock.mockReset();
  resetNegotiatedManifests();
  recordNegotiatedHostManifest(HOST_ID, FULL_MANIFEST);
  useOnboardingStore.setState({ completedAt: null, step: 0 });
});
afterEach(() => {
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
});

describe("the Memory act: what it shows", () => {
  it("gives switches only to enabled, supported, non-Traycer providers, starting off", async () => {
    world.providers = [
      ...defaultProviders(),
      {
        providerId: "opencode",
        enabled: true,
        supported: false,
        nativeMemory: true,
      },
      {
        providerId: "cursor",
        enabled: false,
        supported: true,
        nativeMemory: true,
      },
      {
        providerId: "traycer",
        enabled: true,
        supported: true,
        nativeMemory: true,
      },
    ];
    await openMemoryAct();
    await chooseTraycer();

    const claude = await providerSwitch("claude-code");
    expect(isOn(claude)).toBe(false);
    expect(isOn(await providerSwitch("codex"))).toBe(false);
    expect(
      screen.queryByTestId("onboarding-memory-provider-cursor"),
    ).toBeNull();
    expect(
      screen.queryByTestId("onboarding-memory-provider-opencode"),
    ).toBeNull();
    expect(
      screen.queryByTestId("onboarding-memory-provider-traycer"),
    ).toBeNull();
    expect(
      screen.getByTestId("onboarding-memory-without-switch").textContent,
    ).toBe("Memory settings for OpenCode stay as they are.");
  });

  it("writes nothing while shown, and Not now advances writing nothing", async () => {
    await openMemoryAct();
    await screen.findByTestId("onboarding-memory-not-now");
    await settled();
    expect(paramsOf("config.agentMemories.set")).toEqual([]);
    expect(paramsOf("providers.setNativeMemory")).toEqual([]);

    fireEvent.click(screen.getByTestId("onboarding-memory-not-now"));
    await expectOnStep("session-import");
    await settled();
    expect(paramsOf("config.agentMemories.set")).toEqual([]);
    expect(paramsOf("providers.setNativeMemory")).toEqual([]);
  });

  it("keeps explicit overrides across Back and Next", async () => {
    await openMemoryAct();
    await chooseTraycer();
    fireEvent.click(await providerSwitch("codex"));
    expect(isOn(switchOf("onboarding-memory-provider-codex"))).toBe(true);

    fireEvent.click(screen.getByTestId("onboarding-back"));
    await expectOnStep("providers");
    await clickAdvance();
    await screen.findByTestId("onboarding-memory-stage");

    expect(isOn(await providerSwitch("codex"))).toBe(true);
    expect(isOn(await providerSwitch("claude-code"))).toBe(false);
  });

  it("reconciles a changed selection by provider id", async () => {
    await openMemoryAct();
    await chooseTraycer();
    fireEvent.click(await providerSwitch("codex"));

    fireEvent.click(screen.getByTestId("onboarding-back"));
    await expectOnStep("providers");
    // Providers act: Claude Code deselected, Cursor newly enabled.
    world.providers = [
      { ...defaultProviders()[1], nativeMemory: true },
      {
        providerId: "cursor",
        enabled: true,
        supported: true,
        nativeMemory: true,
      },
      { ...defaultProviders()[0], enabled: false },
    ];
    // Enabling and disabling providers is what invalidates this list.
    await act(() => queryClient.invalidateQueries());
    await clickAdvance();
    await screen.findByTestId("onboarding-memory-stage");

    await waitFor(() =>
      expect(
        screen.queryByTestId("onboarding-memory-provider-claude-code"),
      ).toBeNull(),
    );
    expect(isOn(await providerSwitch("codex"))).toBe(true);
    expect(isOn(await providerSwitch("cursor"))).toBe(false);

    await continueFromMemory();
    await expectOnStep("session-import");
    expect(paramsOf("providers.setNativeMemory")).toEqual([
      { harnessId: "cursor", nativeMemory: false },
    ]);
  });
});

describe("the Memory act: what Continue writes", () => {
  it("writes Traycer first, then only the rows that differ from the host", async () => {
    world.providers = [
      // Chosen on, host already on: no write.
      { ...defaultProviders()[0], nativeMemory: true },
      // Left off, host already off: no write.
      { ...defaultProviders()[1], nativeMemory: false },
      // Left off, host on: written.
      {
        providerId: "cursor",
        enabled: true,
        supported: true,
        nativeMemory: true,
      },
    ];
    await openMemoryAct();
    await chooseTraycer();
    fireEvent.click(await providerSwitch("claude-code"));
    await providerSwitch("cursor");

    await continueFromMemory();
    await expectOnStep("session-import");

    expect(paramsOf("config.agentMemories.set")).toEqual([{ enabled: true }]);
    expect(paramsOf("providers.setNativeMemory")).toEqual([
      { harnessId: "cursor", nativeMemory: false },
    ]);
    const order = methodsInOrder();
    expect(order.indexOf("config.agentMemories.set")).toBeLessThan(
      order.indexOf("providers.setNativeMemory"),
    );
  });

  it("does not write Traycer when the host already has it on, and locks its switch", async () => {
    world.memoriesOn = true;
    await openMemoryAct();
    expect(
      (await screen.findByText(/Traycer memories stay on/)).textContent,
    ).toMatch(/stay on/);

    await chooseTraycer();
    const traycer = switchOf("onboarding-memory-traycer");
    expect(isOn(traycer)).toBe(true);
    expect(traycer.hasAttribute("disabled")).toBe(true);

    await continueFromMemory();
    await expectOnStep("session-import");
    expect(paramsOf("config.agentMemories.set")).toEqual([]);
    expect(paramsOf("providers.setNativeMemory")).toEqual([
      { harnessId: "claude", nativeMemory: false },
      { harnessId: "codex", nativeMemory: false },
    ]);
  });

  it("drops the provider choices when the Traycer switch is turned off", async () => {
    await openMemoryAct();
    await chooseTraycer();
    fireEvent.click(await providerSwitch("codex"));

    fireEvent.click(switchOf("onboarding-memory-traycer"));
    await waitFor(() =>
      expect(
        screen.queryByTestId("onboarding-memory-provider-codex"),
      ).toBeNull(),
    );
    await continueFromMemory();
    await expectOnStep("session-import");
    expect(paramsOf("config.agentMemories.set")).toEqual([]);
    expect(paramsOf("providers.setNativeMemory")).toEqual([]);
  });

  it("starts the providers over when Traycer is turned back on", async () => {
    await openMemoryAct();
    await chooseTraycer();
    fireEvent.click(await providerSwitch("codex"));
    fireEvent.click(switchOf("onboarding-memory-traycer"));
    fireEvent.click(switchOf("onboarding-memory-traycer"));

    expect(isOn(await providerSwitch("codex"))).toBe(false);
  });
});

describe("the Memory act: order and failure", () => {
  it.each(["fail", "queued"] as const)(
    "sends no provider write when Traycer's set is %s",
    async (answer) => {
      world.setAnswers = [answer];
      await openMemoryAct();
      await chooseTraycer();
      await providerSwitch("codex");

      await continueFromMemory();
      await screen.findByTestId("onboarding-memory-save-report");

      expect(currentStepId()).toBe("agent-memories");
      expect(paramsOf("config.agentMemories.set")).toHaveLength(1);
      expect(paramsOf("providers.setNativeMemory")).toEqual([]);
    },
  );

  it("names the provider that failed and retries only that one", async () => {
    world.nativeFailures.set("codex", 1);
    await openMemoryAct();
    await chooseTraycer();
    await providerSwitch("codex");

    await continueFromMemory();
    const report = await screen.findByTestId("onboarding-memory-save-report");
    expect(report.textContent).toContain("Couldn't change Codex memories.");
    expect(report.textContent).toContain("Claude Code memories are now off.");
    expect(currentStepId()).toBe("agent-memories");
    expect(screen.getByTestId("onboarding-advance").textContent).toContain(
      "Try again",
    );
    const sentBefore = hostCalls().length;

    await continueFromMemory();
    await expectOnStep("session-import");

    const retry = hostCalls().slice(sentBefore);
    expect(retry.filter((call) => call.method.endsWith("set"))).toEqual([]);
    expect(
      retry
        .filter((call) => call.method === "providers.setNativeMemory")
        .map((call) => call.params),
    ).toEqual([{ harnessId: "codex", nativeMemory: false }]);
  });

  it("Skip for now advances from a failed state and sends nothing more", async () => {
    world.setAnswers = ["fail"];
    await openMemoryAct();
    await chooseTraycer();
    await continueFromMemory();
    await screen.findByTestId("onboarding-memory-save-report");
    const sentBefore = hostCalls().length;

    fireEvent.click(screen.getByTestId("onboarding-memory-skip"));
    await expectOnStep("session-import");
    await settled();

    expect(hostCalls().slice(sentBefore)).toEqual([]);
  });
});

describe("the Memory act: a queued Traycer write", () => {
  it("is never re-sent, and moves on once the receipt names it", async () => {
    world.setAnswers = ["queued"];
    await openMemoryAct();
    await chooseTraycer();
    await providerSwitch("codex");
    await continueFromMemory();
    await screen.findByTestId("onboarding-memory-save-report");

    // No word either way yet: still held, nothing sent.
    await continueFromMemory();
    await settled();
    expect(paramsOf("environment.status").length).toBeGreaterThan(0);
    expect(paramsOf("config.agentMemories.set")).toHaveLength(1);
    expect(paramsOf("providers.setNativeMemory")).toEqual([]);
    expect(currentStepId()).toBe("agent-memories");

    world.accepted = [{ uploadId: "upload-1", environmentId: ENVIRONMENT_ID }];
    await continueFromMemory();
    await expectOnStep("session-import");

    expect(paramsOf("config.agentMemories.set")).toHaveLength(1);
    expect(paramsOf("providers.setNativeMemory")).toEqual([
      { harnessId: "claude", nativeMemory: false },
      { harnessId: "codex", nativeMemory: false },
    ]);
  });

  it("sends a fresh set only on the retry after the configuration refused it", async () => {
    world.setAnswers = ["queued", "applied"];
    await openMemoryAct();
    await chooseTraycer();
    await continueFromMemory();
    await screen.findByTestId("onboarding-memory-save-report");

    world.refused = ["upload-1"];
    await continueFromMemory();
    await waitFor(() =>
      expect(
        screen.getByTestId("onboarding-memory-save-report").textContent,
      ).toContain("turned this change away"),
    );
    expect(paramsOf("config.agentMemories.set")).toHaveLength(1);
    expect(paramsOf("providers.setNativeMemory")).toEqual([]);

    await continueFromMemory();
    await expectOnStep("session-import");
    expect(paramsOf("config.agentMemories.set")).toHaveLength(2);
  });
});

describe("the Memory act: host gates", () => {
  it("is not in the tour on a host without config.agentMemories", async () => {
    resetNegotiatedManifests();
    recordNegotiatedHostManifest(HOST_ID, {
      "providers.list": { major: 10, minor: 8 },
      "providers.setNativeMemory": { major: 1, minor: 0 },
    });
    await enterTour();
    await clickAdvance();
    await expectOnStep("providers");
    await clickAdvance();
    await expectOnStep("session-import");
    expect(screen.queryByTestId("onboarding-memory-stage")).toBeNull();
  });

  it.each([
    [
      "providers.setNativeMemory is not negotiated",
      {
        "providers.list": { major: 10, minor: 8 },
        "config.agentMemories.get": { major: 1, minor: 0 },
        "config.agentMemories.set": { major: 1, minor: 0 },
      },
    ],
    [
      "providers.list is older than 10.8",
      {
        "providers.list": { major: 10, minor: 7 },
        "providers.setNativeMemory": { major: 1, minor: 0 },
        "config.agentMemories.get": { major: 1, minor: 0 },
        "config.agentMemories.set": { major: 1, minor: 0 },
      },
    ],
  ])("offers no provider switches when %s", async (_name, manifest) => {
    resetNegotiatedManifests();
    recordNegotiatedHostManifest(HOST_ID, manifest);
    await openMemoryAct();
    await chooseTraycer();

    const line = await screen.findByTestId("onboarding-memory-without-switch");
    expect(line.textContent).toBe(
      "Memory settings for Claude Code and Codex stay as they are.",
    );
    expect(screen.queryAllByRole("switch")).toHaveLength(1);

    await continueFromMemory();
    await expectOnStep("session-import");
    expect(paramsOf("providers.setNativeMemory")).toEqual([]);
  });
});

describe("the Memory act: finishing", () => {
  it("is the last act without import, reads Start building, and finishes only once saved", async () => {
    world.sessionImport = false;
    world.setGate = deferred();
    await openMemoryAct();
    await chooseTraycer();
    expect(screen.getByTestId("onboarding-advance").textContent).toContain(
      "Start building",
    );

    await continueFromMemory();
    await waitFor(() =>
      expect(paramsOf("config.agentMemories.set")).toHaveLength(1),
    );
    expect(useOnboardingStore.getState().completedAt).toBeNull();

    await act(async () => {
      world.setGate?.resolve();
      await new Promise((done) => setTimeout(done, 0));
    });
    await waitFor(() =>
      expect(useOnboardingStore.getState().completedAt).toEqual(
        expect.any(Number),
      ),
    );
  });

  it("does not advance a person who pressed Back while the save was in flight", async () => {
    world.setGate = deferred();
    await openMemoryAct();
    await chooseTraycer();
    await continueFromMemory();
    await waitFor(() =>
      expect(paramsOf("config.agentMemories.set")).toHaveLength(1),
    );

    fireEvent.click(screen.getByTestId("onboarding-back"));
    await expectOnStep("providers");
    await act(async () => {
      world.setGate?.resolve();
      await new Promise((done) => setTimeout(done, 0));
    });
    await waitFor(() =>
      expect(paramsOf("providers.setNativeMemory")).toHaveLength(2),
    );
    await writesAnswered();

    // The store holds the position the save would have moved; the page draws it a frame later.
    expect(useOnboardingStore.getState().step).toBe(1);
    expect(currentStepId()).toBe("providers");
  });

  it("saves on Enter, then advances", async () => {
    await openMemoryAct();
    await chooseTraycer();
    await providerSwitch("codex");

    fireEvent.keyDown(document.body, { key: "Enter" });
    await expectOnStep("session-import");

    expect(paramsOf("config.agentMemories.set")).toEqual([{ enabled: true }]);
    expect(paramsOf("providers.setNativeMemory")).toEqual([
      { harnessId: "claude", nativeMemory: false },
      { harnessId: "codex", nativeMemory: false },
    ]);
  });
});

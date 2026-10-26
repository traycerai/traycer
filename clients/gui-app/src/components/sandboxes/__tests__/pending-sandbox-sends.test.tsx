/**
 * A message sent to a staged sandbox waits in its task, behind the setup line,
 * until the agent the person asked for is ready on the sandbox.
 *
 * The driver, the strip, the stores and the staged run are the real ones. What
 * is faked is what lives outside the window: the control plane's create and
 * list, the account's host directory, and each host's `harnesses` and
 * `providers` answers, `epic.createChat` and the terminal create.
 */
import { useSyncExternalStore } from "react";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { JsonContent } from "@traycer/protocol/common/registry";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import { putImage } from "@/lib/composer/landing-image-store";
import { resetDraftBlobTransportForTests } from "@/lib/drafts/draft-blob-transport";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuiHarnessOption } from "@traycer/protocol/host/index";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import type {
  SandboxCreateRequest,
  SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import type { SandboxVerbGesture } from "@traycer/protocol/host/sandbox-control";
import type { CreateChatResponseV12 } from "@traycer/protocol/host/epic/unary-schemas";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type {
  SandboxCreateFetchResult,
  SandboxListFetchResult,
} from "@traycer-clients/shared/host-client/sandbox-control";
import type { CreateChatMutationInput } from "@/hooks/epic/use-epic-chat-mutations";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import {
  MESSAGE_CONTENT,
  PICKED_SETTINGS,
  harnessRow,
  pendingSend,
  providerRow,
} from "@/lib/sandboxes/__tests__/pending-send-fixtures";
import { holdPendingSandboxSendOwnership } from "@/lib/sandboxes/pending-sandbox-send-ownership";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import {
  endPendingSandboxSend,
  confirmPendingSandboxSendEpic,
  handPendingSandboxSend,
  returnPendingSandboxSend,
} from "@/lib/sandboxes/pending-sandbox-send";
import { PERSONAL_CONFIGURATION_ID } from "@/lib/settings-environment-pages";
import { useAccountContextStore } from "@/stores/auth/account-context-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  readStagedSandbox,
  useStagedSandboxStore,
  type StagedSandboxTarget,
} from "@/stores/composer/staged-sandbox-store";
import { useInitialChatHandoffStore } from "@/stores/epics/initial-chat-handoff-store";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { landingLiveImageRootHashes } from "@/lib/composer/landing-image-budget";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";
import {
  pendingSendSurfaceKey,
  usePendingSandboxSendStore,
  type PendingSandboxSend,
  type PendingSandboxSendDispatch,
} from "@/stores/sandboxes/pending-sandbox-send-store";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { persistKey, STORE_KEYS } from "@/lib/persist";
import { createRecordMapStorage } from "@/lib/persist/record-map-storage";
import {
  recordMapStorageKey,
  recordMapStoragePrefix,
} from "@/lib/persist/keys";
import {
  PendingSandboxSendStrip,
  PendingSandboxSendsDriver,
  SandboxReadyLineForChat,
} from "../pending-sandbox-sends";

const SANDBOX_HOST = "sbx-host";
const SANDBOX_ID = "sbx-1";
const SEND_ID = "send-1";
const SURFACE = pendingSendSurfaceKey(SEND_ID);
const PERSONAL_SENTENCE =
  "Sign in to a coding agent to run agents on Personal.";

interface FakeClient {
  readonly hostId: string;
  readonly requestWithOptions: (
    method: string,
    params: { readonly sha256: string },
  ) => Promise<{ readonly ok: true }>;
}

interface CreateChatCall {
  /** The host the client the create went out on addresses. */
  readonly clientHostId: string | null;
  readonly input: CreateChatMutationInput;
}

interface HostAnswers {
  readonly harnesses: ReadonlyArray<GuiHarnessOption>;
  readonly providers: ReadonlyArray<ProviderCliState>;
}

const mocks = vi.hoisted(() => ({
  /** What each host's `harnesses` and `providers` queries answer. */
  hostAnswers: new Map<string, unknown>(),
  answerListeners: new Set<() => void>(),
  answerVersion: 0,
  createChatCalls: [] as unknown[],
  createChatError: null as Error | null,
  createChatDeferred: null as Promise<CreateChatResponseV12> | null,
  createChatRefusal: null as CreateChatResponseV12["refusal"] | null,
  openTile: vi.fn<(intent: unknown) => void>(),
  openEnvironmentPage:
    vi.fn<
      (address: {
        readonly configurationId: string;
        readonly pageId: string;
      }) => void
    >(),
  /** The account's environments, as `environment.list` answers them. */
  environments: [] as Array<{
    readonly environmentId: string;
    readonly ownerKind: "user" | "organization";
    readonly ownerId: string;
  }>,
  /** The control plane. */
  createSandbox:
    vi.fn<
      (request: SandboxCreateRequest) => Promise<SandboxCreateFetchResult>
    >(),
  stopSandbox: vi.fn<(verb: string) => void>(),
  listSandboxes: vi.fn<() => Promise<SandboxListFetchResult>>(),
  findById: vi.fn<(hostId: string) => HostDirectoryEntry | null>(),
  /** The account's sandbox rows the ready line is read from. */
  sandboxes: [] as SandboxSummary[],
  /** When the list was last read (epoch ms); `0` is a read before any mount. */
  listReadAt: 0,
  refetchSandboxes: vi.fn<() => Promise<undefined>>(),
  /** The sandbox wake the staged run asks for, by host. */
  wake: vi.fn<
    (
      hostId: string,
      gesture: SandboxVerbGesture,
    ) => Promise<{ readonly kind: "awake" }>
  >(),
  /** What reached the sandbox's client, in order: puts, then the create. */
  wire: [] as string[],
  /** Hosts whose client is not available here, as a host not dialled yet. */
  nullClientHosts: new Set<string>(),
  /** The models each host lists for its agents, in its own order. */
  modelsByHost: new Map<string, ReadonlyArray<{ readonly slug: string }>>(),
  /** Hosts whose model observer reports a failed refresh (cached data may remain). */
  modelReadErrorHosts: new Set<string>(),
  /** Every model read made, with the activity it asked for. */
  modelReads: [] as Array<{
    readonly hostId: string | null;
    readonly enabled: boolean;
    readonly subscribed: boolean;
  }>,
}));

function answersFor(hostId: string): HostAnswers | undefined {
  const answers = mocks.hostAnswers.get(hostId);
  return isHostAnswers(answers) ? answers : undefined;
}

function isHostAnswers(value: unknown): value is HostAnswers {
  return (
    typeof value === "object" &&
    value !== null &&
    "harnesses" in value &&
    "providers" in value
  );
}

function useAnswerVersion(): number {
  return useSyncExternalStore(
    (listener) => {
      mocks.answerListeners.add(listener);
      return () => {
        mocks.answerListeners.delete(listener);
      };
    },
    () => mocks.answerVersion,
  );
}

const clients = vi.hoisted(
  () =>
    new Map<
      string,
      {
        readonly hostId: string;
        readonly requestWithOptions: (
          method: string,
          params: { readonly sha256: string },
        ) => Promise<{ readonly ok: true }>;
      }
    >(),
);
const refetchNothing = vi.hoisted(() => () => Promise.resolve(undefined));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) => {
    if (hostId === null || mocks.nullClientHosts.has(hostId)) return null;
    const known = clients.get(hostId);
    if (known !== undefined) return known;
    const created = {
      hostId,
      requestWithOptions: (
        method: string,
        params: { readonly sha256: string },
      ) => {
        mocks.wire.push(`${method}:${params.sha256}`);
        return Promise.resolve({ ok: true as const });
      },
    };
    clients.set(hostId, created);
    return created;
  },
}));

vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQueryForClient: (
    client: FakeClient | null,
    activity: { readonly enabled: boolean },
  ) => {
    useAnswerVersion();
    const answers =
      client === null || !activity.enabled
        ? undefined
        : answersFor(client.hostId);
    return {
      data:
        answers === undefined ? undefined : { harnesses: answers.harnesses },
      refetch: refetchNothing,
    };
  },
  // A cold read answers only while it is enabled AND subscribed, as the
  // host query's own does: an unsubscribed observer never fetches.
  useGuiHarnessModelsQueryForClient: (
    client: FakeClient | null,
    _harnessId: string,
    _workingDirectory: string | null,
    activity: { readonly enabled: boolean; readonly subscribed: boolean },
  ) => {
    useAnswerVersion();
    mocks.modelReads.push({
      hostId: client === null ? null : client.hostId,
      enabled: activity.enabled,
      subscribed: activity.subscribed,
    });
    const models =
      client !== null && activity.enabled && activity.subscribed
        ? mocks.modelsByHost.get(client.hostId)
        : undefined;
    return {
      data: models === undefined ? undefined : { models },
      isError: client !== null && mocks.modelReadErrorHosts.has(client.hostId),
    };
  },
}));

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersListForClient: (
    client: FakeClient | null,
    activity: { readonly enabled: boolean },
  ) => {
    useAnswerVersion();
    const answers =
      client === null || !activity.enabled
        ? undefined
        : answersFor(client.hostId);
    return {
      data:
        answers === undefined ? undefined : { providers: answers.providers },
      isError: false,
      refetch: refetchNothing,
    };
  },
}));

vi.mock("@/hooks/epic/use-epic-chat-mutations", () => ({
  useEpicCreateChatForHostClient: (client: FakeClient | null) => ({
    mutateAsync: (input: CreateChatMutationInput) => {
      mocks.wire.push("epic.createChat");
      mocks.createChatCalls.push({
        clientHostId: client === null ? null : client.hostId,
        input,
      });
      if (mocks.createChatError !== null) {
        return Promise.reject(mocks.createChatError);
      }
      if (mocks.createChatDeferred !== null) return mocks.createChatDeferred;
      return Promise.resolve({
        chatId: input.chatId,
        initialTurnStarted: true,
        ...(mocks.createChatRefusal === null
          ? {}
          : { refusal: mocks.createChatRefusal }),
      });
    },
  }),
  useEpicCreateChatForPendingSandbox: (
    client: FakeClient | null,
    _ownerUserId: string | null,
  ) => ({
    mutateAsync: (input: CreateChatMutationInput) => {
      mocks.wire.push("epic.createChat");
      mocks.createChatCalls.push({
        clientHostId: client === null ? null : client.hostId,
        input,
      });
      if (mocks.createChatError !== null) {
        return Promise.reject(mocks.createChatError);
      }
      if (mocks.createChatDeferred !== null) return mocks.createChatDeferred;
      return Promise.resolve({
        chatId: input.chatId,
        initialTurnStarted: true,
        ...(mocks.createChatRefusal === null
          ? {}
          : { refusal: mocks.createChatRefusal }),
      });
    },
  }),
}));

vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation: () => vi.fn(),
}));
vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({ openTile: mocks.openTile }),
}));
vi.mock("@/components/settings/environment/open-environment-page", () => ({
  openEnvironmentPage: mocks.openEnvironmentPage,
}));
vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: () => ({
    data: { environments: mocks.environments },
  }),
}));
vi.mock("@/components/epic-canvas/sidebar/new-terminal-tile-ref", () => ({
  mintNewEpicTerminalTile: (target: {
    readonly hostId: string;
    readonly cwd: string;
  }) => ({ type: "terminal", hostId: target.hostId, cwd: target.cwd }),
  mintPendingSandboxTerminalTile: (
    target: { readonly hostId: string; readonly cwd: string },
    sendId: string,
  ) => ({
    type: "terminal",
    hostId: target.hostId,
    cwd: target.cwd,
    sendId,
  }),
}));
vi.mock("@/lib/commands/actions/new-chat", () => ({
  openCreatedChatWhenProjectedWithNavigation: vi.fn(),
}));

// The control plane and the account's host directory.
// One binding for the whole run, as the app's is, so what is derived from it
// keeps its identity between renders.
const hostBinding = vi.hoisted(() => ({
  auth: {
    createSandbox: (request: SandboxCreateRequest) =>
      mocks.createSandbox(request),
    listSandboxes: () => mocks.listSandboxes(),
  },
  directory: {
    refresh: () => Promise.resolve(),
    findById: (hostId: string) => mocks.findById(hostId),
  },
}));
vi.mock("@/lib/host", () => ({
  useHostClient: () => null,
  useHostBinding: () => hostBinding,
}));
vi.mock("@/lib/sandboxes/sandbox-wake", () => ({
  startSandboxWake: (
    _queryClient: unknown,
    _binding: unknown,
    hostId: string,
    gesture: SandboxVerbGesture,
  ) => mocks.wake(hostId, gesture),
}));
vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({ data: null }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-catalogue-query", () => ({
  useSandboxCatalogue: () => ({ data: null }),
}));
// The real list query backs the staged run's own reads; the hook the ready
// line reads is the account's rows.
vi.mock("@/hooks/sandboxes/use-sandbox-list-query", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/sandboxes/use-sandbox-list-query")
  >()),
  useSandboxList: () => {
    useAnswerVersion();
    return {
      data: { sandboxes: mocks.sandboxes },
      dataUpdatedAt: mocks.listReadAt,
      refetch: mocks.refetchSandboxes,
    };
  },
}));
vi.mock("@/hooks/sandboxes/use-sandbox-verb-mutation", () => ({
  useSandboxVerb: () => ({ mutate: mocks.stopSandbox }),
}));
vi.mock("@/hooks/sandboxes/use-configuration-billing-url", () => ({
  useConfigurationBillingUrl: () => "https://example.test/billing",
}));
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => vi.fn(),
}));
vi.mock(
  "@/hooks/sandboxes/use-sandbox-repair-guest-configuration-mutation",
  () => ({
    useSandboxRepairGuestConfigurationOnHost: () => ({ mutate: vi.fn() }),
  }),
);
// The new host answers with its default cwd as soon as it is named.
vi.mock(
  "@/components/epic-canvas/sidebar/use-folderless-terminal-target",
  () => ({
    useFolderlessTerminalTarget: (_epicId: string, hostId: string | null) =>
      hostId === null ? null : { hostId, cwd: "/home/sandbox" },
  }),
);

const NEW_TARGET: StagedSandboxTarget = {
  kind: "new",
  configuration: { kind: "personal" },
  shape: {
    os: "linux",
    cpus: 2,
    memoryMb: 4096,
    diskMb: null,
    region: "us-east",
    idleMinutes: 30,
    destroyAfterRestingMinutes: null,
  },
  name: "api-refactor",
  wakeString: null,
};

const RESUME_TARGET: StagedSandboxTarget = {
  kind: "existing",
  hostId: SANDBOX_HOST,
  sandboxId: SANDBOX_ID,
  name: "build-box",
  configuration: { kind: "personal" },
  verb: "resume",
};

const START_TARGET: StagedSandboxTarget = { ...RESUME_TARGET, verb: "start" };

const TEAM_TARGET: StagedSandboxTarget = {
  ...NEW_TARGET,
  configuration: { kind: "team", teamId: "team-9", teamName: "Acme" },
};

function answerHost(hostId: string, answers: HostAnswers): void {
  mocks.hostAnswers.set(hostId, answers);
  notifyAnswerListeners();
}

function answerSandboxRows(sandboxes: SandboxSummary[], readAt: number): void {
  mocks.sandboxes = sandboxes;
  mocks.listReadAt = readAt;
  notifyAnswerListeners();
}

function notifyAnswerListeners(): void {
  mocks.answerVersion += 1;
  act(() => {
    for (const listener of mocks.answerListeners) listener();
  });
}

/** Codex's pack is preparing on the sandbox, Claude is ready beside it. */
const CODEX_DOWNLOADING: HostAnswers = {
  harnesses: [
    harnessRow("codex", { available: false }),
    harnessRow("claude", { available: true }),
  ],
  providers: [
    providerRow("codex", { status: "downloading", percent: 40 }),
    providerRow("claude-code", { status: "installed" }),
  ],
};

const CODEX_READY: HostAnswers = {
  harnesses: [
    harnessRow("codex", { available: true }),
    harnessRow("claude", { available: true }),
  ],
  providers: [
    providerRow("codex", { status: "installed" }),
    providerRow("claude-code", { status: "installed" }),
  ],
};

const CODEX_UNAVAILABLE: HostAnswers = {
  harnesses: [
    harnessRow("codex", { available: false }),
    harnessRow("claude", { available: true }),
  ],
  providers: [providerRow("codex", null), providerRow("claude-code", null)],
};

const CODEX_SETUP_FAILED: HostAnswers = {
  harnesses: [
    harnessRow("codex", { available: false }),
    harnessRow("claude", { available: true }),
  ],
  providers: [
    providerRow("codex", {
      status: "error",
      reason: "disk-full",
      message: "ENOSPC",
      retryAtMs: null,
    }),
    providerRow("claude-code", null),
  ],
};

interface SeedOptions {
  readonly send: Partial<PendingSandboxSend>;
  readonly target: StagedSandboxTarget;
  /** Where the create stands. */
  readonly phase: "creating" | "handoff";
  /** The sandbox the create made, once it has answered. */
  readonly created: boolean;
  /** Seconds from Send to now, for the ready line. */
  readonly elapsedSeconds: number;
}

/** The pane an in-pane New agent names for its tile. */
const PANE = { kind: "tab", paneId: "pane-2", index: null } as const;

/** A fork asked of a staged sandbox, as the fork dialog hands it over. */
const FORK_REQUEST = {
  kind: "fork" as const,
  parentId: null,
  title: "Sandbox fork",
  forkSource: {
    boundary: "assistantMessage" as const,
    sourceChatId: "source-chat",
    assistantMessageId: "assistant-message-1",
    interviewBlockId: null,
    carriedInterviews: "settled" as const,
    sourceOwnerUserId: null,
  },
  tabId: "tab-1",
};

const SEEDED: SeedOptions = {
  send: {},
  target: NEW_TARGET,
  phase: "handoff",
  created: true,
  elapsedSeconds: 24,
};

/** A message handed to its task, its create `phase` along. */
function seed(options: SeedOptions): void {
  usePendingSandboxSendStore
    .getState()
    .add(pendingSend({ id: SEND_ID, ...options.send }));
  const store = useStagedSandboxStore.getState();
  store.stage(SURFACE, options.target);
  store.begin(
    SURFACE,
    false,
    Date.now() - options.elapsedSeconds * 1000,
    false,
  );
  store.report(SURFACE, {
    ownerId: null,
    sendTaken: true,
    step: options.phase === "handoff" ? "delivering" : "booting",
    stepAt: Date.now(),
    ...(options.created
      ? { createdSandboxId: SANDBOX_ID, createdHostId: SANDBOX_HOST }
      : {}),
    ...(options.phase === "handoff" ? { phase: "handoff" as const } : {}),
  });
}

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <PendingSandboxSendsDriver />
      <PendingSandboxSendStrip epicId="epic-1" tabId="tab-1" />
    </QueryClientProvider>,
  );
}

async function waitForCreateChats(count: number): Promise<void> {
  await waitFor(() => {
    expect(createChatCalls()).toHaveLength(count);
  });
}

function createChatCalls(): CreateChatCall[] {
  return mocks.createChatCalls.filter(isCreateChatCall);
}

function isCreateChatCall(value: unknown): value is CreateChatCall {
  return typeof value === "object" && value !== null && "input" in value;
}

function dialableHost(hostId: string): HostDirectoryEntry {
  return {
    hostId,
    label: "api-refactor",
    kind: "remote",
    websocketUrl: "ws://sbx-host.test",
    version: null,
    transportDialability: "dialable",
  };
}

function listAnswers(rows: SandboxSummary[]): SandboxListFetchResult {
  return { kind: "ok", response: { sandboxes: rows } };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function resolvePendingCreate(
  create: Deferred<CreateChatResponseV12>,
): Promise<void> {
  await act(async () => {
    create.resolve({
      chatId: createChatCalls()[0]?.input.chatId ?? "cleanup-chat",
    });
    await create.promise;
  });
}

/** Grants a real per-send exclusive reservation for withdrawal-specific cases. */
function installImmediateExclusiveLocks(): () => void {
  const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: (
        _name: string,
        _options: LockOptions,
        callback: () => Promise<void>,
      ) => callback(),
    },
  });
  return () => {
    if (originalLocks === undefined) {
      Reflect.deleteProperty(navigator, "locks");
    } else {
      Object.defineProperty(navigator, "locks", originalLocks);
    }
  };
}

/**
 * A send whose sandbox ended is released, not left on its line: the stage is
 * gone, a chat's message waits in one closed Draft, a fork simply ends, and
 * nothing was sent, opened or navigated to.
 */
function expectSendRecovered(kind: "chat" | "fork"): void {
  expect(usePendingSandboxSendStore.getState().sends).toEqual({});
  expect(readStagedSandbox(SURFACE)).toBeNull();
  expect(createChatCalls()).toEqual([]);
  expect(mocks.createSandbox).not.toHaveBeenCalled();
  expect(useNewConversationModalOpenStore.getState().request).toBeNull();
  expect(mocks.openTile).not.toHaveBeenCalled();
  const { drafts, activeDraftId } = useLandingDraftStore.getState();
  if (kind === "chat") {
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      content: MESSAGE_CONTENT,
      settings: PICKED_SETTINGS,
      closed: true,
    });
    expect(activeDraftId).toBeNull();
  } else {
    expect(drafts).toEqual([]);
  }
}

function userSignedIn(): void {
  useAuthStore
    .getState()
    .setSignedIn(
      { userId: "user-1", userName: "U", email: "u@example.com" },
      { userId: "user-1", username: "U" },
      [],
    );
}

beforeEach(() => {
  localStorage.clear();
  userSignedIn();
  useAccountContextStore.setState({ accountContext: { type: "PERSONAL" } });
  mocks.hostAnswers.clear();
  mocks.createChatCalls.length = 0;
  mocks.createChatError = null;
  mocks.createChatDeferred = null;
  mocks.createChatRefusal = null;
  mocks.openTile.mockReset();
  mocks.openEnvironmentPage.mockReset();
  mocks.environments = [];
  mocks.createSandbox.mockReset();
  mocks.stopSandbox.mockReset();
  mocks.listSandboxes.mockReset();
  mocks.findById.mockReset();
  mocks.findById.mockImplementation((hostId) => dialableHost(hostId));
  // Every dispatch waits on an affirmative row read since mount: the default
  // is the staged sandbox, awake, read after any mount.
  mocks.sandboxes = [
    sandboxSummaryFixture({
      id: SANDBOX_ID,
      hostId: SANDBOX_HOST,
      state: "awake",
    }),
  ];
  mocks.listReadAt = Date.now() + 60_000;
  mocks.refetchSandboxes.mockReset();
  mocks.refetchSandboxes.mockResolvedValue(undefined);
  mocks.wire.length = 0;
  mocks.nullClientHosts.clear();
  mocks.modelsByHost.clear();
  mocks.modelReadErrorHosts.clear();
  mocks.modelReads.length = 0;
  mocks.wake.mockReset();
  mocks.wake.mockResolvedValue({ kind: "awake" });
  resetNegotiatedManifests();
  useStagedSandboxStore.setState({ bySurface: {} });
  usePendingSandboxSendStore.setState({ sends: {} });
  useInitialChatHandoffStore.getState().resetForTests();
  useNewConversationModalStore.getState().resetForTests();
  useNewConversationModalOpenStore.getState().close();
  useSettingsEnvironmentPickStore.setState({ pick: null });
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
});

afterEach(() => {
  cleanup();
  useAuthStore.getState().setSignedOut();
});

describe("a send waiting for the requested agent on its sandbox", () => {
  it("is not delivered while the requested agent's pack downloads, shows no error, and goes out once, on the sandbox's own client, when it is ready", async () => {
    seed(SEEDED);
    answerHost(SANDBOX_HOST, CODEX_DOWNLOADING);
    mount();

    // Claude is ready, Codex is not: the message waits for Codex.
    expect(createChatCalls()).toEqual([]);
    expect(screen.getByTestId("sandbox-setup-line")).toBeDefined();
    expect(screen.queryByTestId("sandbox-refusal-line")).toBeNull();
    expect(readStagedSandbox(SURFACE)).toMatchObject({
      phase: "handoff",
      failure: null,
    });

    answerHost(SANDBOX_HOST, CODEX_READY);

    await waitForCreateChats(1);
    const calls = createChatCalls();
    expect(calls[0].clientHostId).toBe(SANDBOX_HOST);
    expect(calls[0].input).toMatchObject({
      epicId: "epic-1",
      hostId: SANDBOX_HOST,
      workspaceMode: "folderless",
      settings: PICKED_SETTINGS,
      initialMessage: { content: MESSAGE_CONTENT },
    });
    // The message left the strip with its delivery.
    expect(screen.queryByTestId("pending-sandbox-message")).toBeNull();
  });

  it("keeps the message and sends no create when its durable dispatch claim cannot be written", async () => {
    const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
    Reflect.deleteProperty(navigator, "locks");
    const sendRecordKey = recordMapStorageKey(
      persistKey(STORE_KEYS.pendingSandboxSend),
      SEND_ID,
    );
    const originalSetItem = localStorage.setItem.bind(localStorage);
    try {
      seed(SEEDED);
      answerHost(SANDBOX_HOST, CODEX_DOWNLOADING);
      mount();
      await screen.findByTestId("sandbox-setup-line");

      const failedWrite = vi
        .spyOn(Storage.prototype, "setItem")
        .mockImplementation(function (this: Storage, key, value) {
          if (key === sendRecordKey) {
            throw new Error("quota exceeded");
          }
          originalSetItem.call(this, key, value);
        });
      try {
        answerHost(SANDBOX_HOST, CODEX_READY);

        await waitFor(() => {
          expect(failedWrite).toHaveBeenCalledWith(
            sendRecordKey,
            expect.any(String),
          );
        });
        expect(createChatCalls()).toEqual([]);
        expect(screen.getByTestId("pending-sandbox-message").textContent).toBe(
          "fix the login bug",
        );
        const sends = usePendingSandboxSendStore.getState().sends;
        if (!Object.hasOwn(sends, SEND_ID)) {
          throw new Error("expected the pending message to be retained");
        }
        expect(sends[SEND_ID]).toMatchObject({
          text: "fix the login bug",
          delivery: null,
        });
      } finally {
        failedWrite.mockRestore();
      }
    } finally {
      if (originalLocks === undefined) {
        Reflect.deleteProperty(navigator, "locks");
      } else {
        Object.defineProperty(navigator, "locks", originalLocks);
      }
    }
  });

  it("opens the agent in the pane its surface named, as an ordinary create does", async () => {
    seed({
      ...SEEDED,
      send: { request: { kind: "chat", parentId: null, placement: PANE } },
    });
    answerHost(SANDBOX_HOST, CODEX_READY);
    mount();

    await waitForCreateChats(1);
    expect(
      Object.values(useInitialChatHandoffStore.getState().handoffs),
    ).toMatchObject([{ epicId: "epic-1", placement: PANE }]);
  });

  it("waits while the requested agent's availability is still being probed, then delivers once it is available", async () => {
    seed(SEEDED);
    answerHost(SANDBOX_HOST, {
      harnesses: [
        harnessRow("codex", { available: false, availabilityPending: true }),
        harnessRow("claude", { available: true }),
      ],
      providers: [providerRow("codex", null), providerRow("claude-code", null)],
    });
    mount();

    expect(createChatCalls()).toEqual([]);
    expect(screen.queryByTestId("sandbox-refusal-line")).toBeNull();

    answerHost(SANDBOX_HOST, {
      harnesses: [
        harnessRow("codex", { available: true }),
        harnessRow("claude", { available: true }),
      ],
      providers: [providerRow("codex", null), providerRow("claude-code", null)],
    });

    await waitForCreateChats(1);
  });

  it.each([
    ["a new sandbox", NEW_TARGET],
    ["a suspended sandbox", RESUME_TARGET],
    ["a stopped sandbox", START_TARGET],
  ] as const)(
    "runs the message on Codex · GPT-6.1-Sol · High for %s, though its catalog first shows Codex unavailable and Claude ready",
    async (_label, target) => {
      seed({ ...SEEDED, target });
      answerHost(SANDBOX_HOST, CODEX_DOWNLOADING);
      mount();
      expect(createChatCalls()).toEqual([]);

      answerHost(SANDBOX_HOST, CODEX_READY);

      await waitForCreateChats(1);
      const calls = createChatCalls();
      expect(calls[0].input.settings).toMatchObject({
        harnessId: "codex",
        model: "gpt-6.1-sol",
        reasoningEffort: "high",
      });
    },
  );

  it("waits while the pack is preparing, then refuses with the sign-in sentence when the agent settles unauthenticated, delivering nothing", async () => {
    seed(SEEDED);
    answerHost(SANDBOX_HOST, CODEX_DOWNLOADING);
    mount();

    // Preparing: the message waits and nothing is refused.
    expect(screen.queryByTestId("sandbox-refusal-line")).toBeNull();
    expect(readStagedSandbox(SURFACE)?.failure).toBeNull();

    // The install is done, but the agent is signed out: not available.
    answerHost(SANDBOX_HOST, {
      harnesses: [
        harnessRow("codex", { available: false, availabilityPending: false }),
        harnessRow("claude", { available: true }),
      ],
      providers: [
        providerRow("codex", { status: "installed" }),
        providerRow("claude-code", { status: "installed" }),
      ],
    });

    const line = await screen.findByTestId("sandbox-refusal-line");
    expect(within(line).getByText(PERSONAL_SENTENCE)).toBeDefined();
    expect(readStagedSandbox(SURFACE)?.failure).toEqual({
      kind: "no-provider",
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(createChatCalls()).toEqual([]);
  });

  it("refuses a Personal send whose agent cannot run there with the sign-in sentence, uses no other agent, and opens Personal's Providers", async () => {
    seed(SEEDED);
    // Settled unavailable, nothing pending, no pack in the way; Claude is ready.
    answerHost(SANDBOX_HOST, {
      harnesses: [
        harnessRow("codex", { available: false, availabilityPending: false }),
        harnessRow("claude", { available: true }),
      ],
      providers: [providerRow("codex", null), providerRow("claude-code", null)],
    });
    mount();

    const line = await screen.findByTestId("sandbox-refusal-line");
    expect(within(line).getByText(PERSONAL_SENTENCE)).toBeDefined();
    expect(createChatCalls()).toEqual([]);
    expect(readStagedSandbox(SURFACE)?.failure).toEqual({
      kind: "no-provider",
    });
    // The message stays, pending.
    expect(screen.getByTestId("pending-sandbox-message").textContent).toBe(
      "fix the login bug",
    );

    fireEvent.click(
      within(line).getByRole("button", { name: "Open Personal's Providers" }),
    );

    expect(mocks.openEnvironmentPage).toHaveBeenCalledTimes(1);
    expect(mocks.openEnvironmentPage).toHaveBeenCalledWith({
      configurationId: PERSONAL_CONFIGURATION_ID,
      pageId: "providers",
    });
  });

  it("delivers the requested agent after its Personal provider is repaired, without a manual retry or a second sandbox", async () => {
    seed(SEEDED);
    answerHost(SANDBOX_HOST, CODEX_UNAVAILABLE);
    mount();

    const line = await screen.findByTestId("sandbox-refusal-line");
    expect(readStagedSandbox(SURFACE)?.failure).toEqual({
      kind: "no-provider",
    });
    fireEvent.click(
      within(line).getByRole("button", { name: "Open Personal's Providers" }),
    );

    answerHost(SANDBOX_HOST, CODEX_READY);

    await waitForCreateChats(1);
    expect(createChatCalls()[0].input.settings?.harnessId).toBe("codex");
    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });

  it("delivers the requested agent after its failed setup is repaired", async () => {
    seed(SEEDED);
    answerHost(SANDBOX_HOST, CODEX_SETUP_FAILED);
    mount();

    await waitFor(() => {
      expect(readStagedSandbox(SURFACE)?.failure).toMatchObject({
        kind: "agent-setup-failed",
      });
    });
    expect(createChatCalls()).toEqual([]);

    answerHost(SANDBOX_HOST, CODEX_READY);

    await waitForCreateChats(1);
    expect(createChatCalls()[0].input.settings?.harnessId).toBe("codex");
    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });

  describe("on a team's sandbox", () => {
    const SIGNED_OUT: HostAnswers = {
      harnesses: [
        harnessRow("codex", { available: false, availabilityPending: false }),
        harnessRow("claude", { available: true }),
      ],
      providers: [providerRow("codex", null), providerRow("claude-code", null)],
    };

    it("refuses with the team's sentence and opens that team's own Providers, by its environment", async () => {
      mocks.environments = [
        { environmentId: "env-personal", ownerKind: "user", ownerId: "user-1" },
        {
          environmentId: "env-other",
          ownerKind: "organization",
          ownerId: "team-1",
        },
        {
          environmentId: "env-acme",
          ownerKind: "organization",
          ownerId: "team-9",
        },
      ];
      seed({ ...SEEDED, target: TEAM_TARGET });
      answerHost(SANDBOX_HOST, SIGNED_OUT);
      mount();

      const line = await screen.findByTestId("sandbox-refusal-line");
      expect(
        within(line).getByText(
          "Sign in to a coding agent to run agents on Acme.",
        ),
      ).toBeDefined();
      fireEvent.click(
        within(line).getByRole("button", { name: "Open Acme's Providers" }),
      );

      expect(mocks.openEnvironmentPage).toHaveBeenCalledTimes(1);
      expect(mocks.openEnvironmentPage).toHaveBeenCalledWith({
        configurationId: "env-acme",
        pageId: "providers",
      });
    });

    it("offers no Providers link when the team's environment is not among the account's", async () => {
      mocks.environments = [
        {
          environmentId: "env-other",
          ownerKind: "organization",
          ownerId: "team-1",
        },
      ];
      seed({ ...SEEDED, target: TEAM_TARGET });
      answerHost(SANDBOX_HOST, SIGNED_OUT);
      mount();

      const line = await screen.findByTestId("sandbox-refusal-line");
      expect(
        within(line).queryByRole("button", { name: "Open Acme's Providers" }),
      ).toBeNull();
    });
  });

  it("refuses an agent whose install failed with the host's sentence, offers Open terminal instead and no sign-in, and opens a terminal on the sandbox", async () => {
    seed(SEEDED);
    answerHost(SANDBOX_HOST, {
      harnesses: [harnessRow("codex", { available: false })],
      providers: [
        providerRow("codex", {
          status: "error",
          reason: "disk-full",
          message: "ENOSPC",
          retryAtMs: null,
        }),
      ],
    });
    mount();

    const line = await screen.findByTestId("sandbox-refusal-line");
    expect(line.textContent).toContain("disk space");
    expect(line.textContent).not.toContain("Sign in");
    expect(
      within(line).queryByRole("button", { name: /Providers/ }),
    ).toBeNull();
    expect(createChatCalls()).toEqual([]);

    fireEvent.click(
      within(line).getByRole("button", { name: "Open terminal instead" }),
    );

    expect(mocks.openTile).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.openTile.mock.calls[0][0])).toContain(
      SANDBOX_HOST,
    );
    expect(JSON.stringify(mocks.openTile.mock.calls[0][0])).toContain(SEND_ID);
  });

  it("shows the setup line above the pending message, and the line opens to its steps", () => {
    seed(SEEDED);
    answerHost(SANDBOX_HOST, CODEX_DOWNLOADING);
    mount();

    const line = screen.getByTestId("sandbox-setup-line");
    const message = screen.getByTestId("pending-sandbox-message");
    expect(
      line.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(message.textContent).toBe("fix the login bug");

    fireEvent.click(screen.getByTestId("sandbox-setup-line-toggle"));

    expect(screen.getByTestId("sandbox-setup-step-creating")).toBeDefined();
    expect(screen.getByTestId("sandbox-setup-step-booting")).toBeDefined();
    expect(screen.getByTestId("sandbox-setup-step-applying")).toBeDefined();
    expect(
      screen.getByTestId("sandbox-setup-step-delivering").textContent,
    ).toContain("Delivering your message");
  });

  it("opens a terminal on the staged sandbox once it is up, sends no agent, and ends the send", async () => {
    seed({
      ...SEEDED,
      send: { request: { kind: "terminal" }, text: "" },
      phase: "creating",
      created: true,
    });
    const ready = sandboxSummaryFixture({
      id: SANDBOX_ID,
      hostId: SANDBOX_HOST,
      state: "awake",
      guestConfigured: true,
    });
    mocks.listReadAt = Date.now() + 60_000;
    mocks.sandboxes = [ready];
    mocks.listSandboxes.mockResolvedValue(listAnswers([ready]));
    mount();

    await waitFor(() => {
      expect(mocks.openTile).toHaveBeenCalledTimes(1);
    });
    expect(JSON.stringify(mocks.openTile.mock.calls[0][0])).toContain(
      SANDBOX_HOST,
    );
    expect(JSON.stringify(mocks.openTile.mock.calls[0][0])).toContain(SEND_ID);
    expect(createChatCalls()).toEqual([]);
    expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    expect(readStagedSandbox(SURFACE)).toBeNull();
    // The create it joined was the one already made.
    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });
});

describe("a send that survives a reload", () => {
  /** The two persisted stores as a reload finds them. */
  async function reload(): Promise<void> {
    await reloadPendingSandboxStores();
  }

  it("takes up a create that was answered without making a second sandbox, shows the line again, and delivers once", async () => {
    seed({ ...SEEDED, phase: "creating", created: true });
    const clientRequestId = readStagedSandbox(SURFACE)?.clientRequestId;
    mocks.listSandboxes.mockResolvedValue(
      listAnswers([
        sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: SANDBOX_HOST,
          state: "awake",
          guestConfigured: true,
        }),
      ]),
    );
    answerHost(SANDBOX_HOST, CODEX_READY);

    await reload();
    mount();

    expect(screen.getByTestId("sandbox-setup-line")).toBeDefined();
    expect(screen.getByTestId("pending-sandbox-message").textContent).toBe(
      "fix the login bug",
    );
    await waitFor(() => {
      expect(createChatCalls()).toHaveLength(1);
    });
    expect(mocks.createSandbox).not.toHaveBeenCalled();
    expect(createChatCalls()[0].clientHostId).toBe(SANDBOX_HOST);
    expect(clientRequestId).toBeDefined();
  });

  it("resumes a team's requested agent after rehydrating the provider refusal, without creating another sandbox or chat", async () => {
    mocks.environments = [
      {
        environmentId: "env-acme",
        ownerKind: "organization",
        ownerId: "team-9",
      },
    ];
    seed({ ...SEEDED, target: TEAM_TARGET });
    answerHost(SANDBOX_HOST, CODEX_UNAVAILABLE);
    mount();

    const line = await screen.findByTestId("sandbox-refusal-line");
    expect(readStagedSandbox(SURFACE)?.failure).toEqual({
      kind: "no-provider",
    });
    fireEvent.click(
      within(line).getByRole("button", { name: "Open Acme's Providers" }),
    );

    await reload();
    expect(readStagedSandbox(SURFACE)?.failure).toEqual({
      kind: "no-provider",
    });
    answerHost(SANDBOX_HOST, CODEX_READY);
    mount();

    await waitForCreateChats(1);
    expect(createChatCalls()[0].input.settings?.harnessId).toBe("codex");
    expect(createChatCalls()).toHaveLength(1);
    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });

  it("names the same create key again when the create was never answered", async () => {
    seed({ ...SEEDED, phase: "creating", created: false });
    const clientRequestId = readStagedSandbox(SURFACE)?.clientRequestId;
    if (clientRequestId === null || clientRequestId === undefined) {
      throw new Error("expected the create's key");
    }
    mocks.createSandbox.mockResolvedValue({
      kind: "ok",
      accepted: {
        sandboxId: SANDBOX_ID,
        hostId: SANDBOX_HOST,
        sandbox: sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: SANDBOX_HOST,
          state: "creating",
        }),
      },
    });
    mocks.listSandboxes.mockResolvedValue(
      listAnswers([
        sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: SANDBOX_HOST,
          state: "awake",
          guestConfigured: true,
        }),
      ]),
    );
    answerHost(SANDBOX_HOST, CODEX_READY);

    await reload();
    mount();

    await waitFor(() => {
      expect(createChatCalls()).toHaveLength(1);
    });
    expect(mocks.createSandbox).toHaveBeenCalledTimes(1);
    expect(mocks.createSandbox.mock.calls[0][0].clientRequestId).toBe(
      clientRequestId,
    );
  });

  it("retries an uncertain chat create from its saved request after the stage is missing", async () => {
    seed(SEEDED);
    mocks.createChatError = new Error("The reply was lost.");
    answerHost(SANDBOX_HOST, CODEX_READY);
    mount();

    await waitForCreateChats(1);
    await waitFor(() => {
      expect(
        screen.getByTestId("pending-sandbox-dispatch").textContent,
      ).toContain("Couldn't confirm the agent was created.");
    });
    const firstCalls = createChatCalls();
    if (!Object.hasOwn(firstCalls, 0)) {
      throw new Error("expected a chat create");
    }
    const firstInput = firstCalls[0].input;

    mocks.createChatError = null;
    useStagedSandboxStore.getState().clear(SURFACE);
    await reload();

    const sends = usePendingSandboxSendStore.getState().sends;
    if (!Object.hasOwn(sends, SEND_ID)) {
      throw new Error("expected the pending send after reload");
    }
    const send = sends[SEND_ID];
    usePendingSandboxSendStore.setState({
      sends: {
        ...sends,
        [SEND_ID]: {
          ...send,
          content: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "changed content after Send" }],
              },
            ],
          },
          settings: { ...send.settings, model: "changed-model-default" },
        },
      },
    });
    useAccountContextStore.setState({
      accountContext: { type: "TEAM", teamId: "team-current" },
    });
    mount();

    const dispatch = await screen.findByTestId("pending-sandbox-dispatch");
    expect(dispatch.textContent).toContain(
      "Couldn't confirm the agent was created.",
    );
    expect(createChatCalls()).toHaveLength(1);
    expect(screen.getByTestId("pending-sandbox-message").textContent).toBe(
      "fix the login bug",
    );
    fireEvent.click(screen.getByTestId("pending-sandbox-dispatch-retry"));

    await waitForCreateChats(2);
    expect(createChatCalls()[1]?.clientHostId).toBe(
      createChatCalls()[0]?.clientHostId,
    );
    expect(createChatCalls()[1]?.input).toEqual(firstInput);
  });

  it("resumes a persisted sending claim without Web Locks or its stage", async () => {
    const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
    Reflect.deleteProperty(navigator, "locks");
    try {
      const input: PendingSandboxSendDispatch["input"] = {
        epicId: "epic-1",
        hostId: SANDBOX_HOST,
        parentId: null,
        title: "",
        chatId: "saved-chat-id",
        workspaceMode: "folderless",
        worktreeIntent: null,
        settings: PICKED_SETTINGS,
        initialMessage: {
          messageId: "saved-message-id",
          clientActionId: "saved-action-id",
          content: MESSAGE_CONTENT,
          sender: { type: "user", userId: "user-1" },
          settings: PICKED_SETTINGS,
          accountContext: { type: "PERSONAL" },
          sentFromHostId: null,
        },
      };
      const dispatch = {
        input,
        delivery: {
          chatId: input.chatId,
          hostId: SANDBOX_HOST,
          sandboxId: SANDBOX_ID,
          readySeconds: 24,
        },
        status: "sending" as const,
      };
      usePendingSandboxSendStore
        .getState()
        .add(pendingSend({ id: SEND_ID, dispatch }));
      await reloadPendingSandboxStores();

      const create = deferred<CreateChatResponseV12>();
      mocks.createChatDeferred = create.promise;
      answerHost(SANDBOX_HOST, CODEX_READY);
      mount();
      try {
        await waitForCreateChats(1);
        expect(createChatCalls()[0]?.input).toEqual(input);
        expect(readStagedSandbox(SURFACE)).toBeNull();

        await act(async () => {
          create.resolve({ chatId: input.chatId });
          await create.promise;
        });
      } finally {
        await resolvePendingCreate(create);
      }
      await waitFor(() => {
        expect(
          usePendingSandboxSendStore.getState().sends[SEND_ID]?.delivery,
        ).toEqual(dispatch.delivery);
      });
      expect(createChatCalls()).toHaveLength(1);
      expect(readStagedSandbox(SURFACE)).toBeNull();
    } finally {
      if (originalLocks === undefined) {
        Reflect.deleteProperty(navigator, "locks");
      } else {
        Object.defineProperty(navigator, "locks", originalLocks);
      }
    }
  });

  it("does not deliver a delivered send again", async () => {
    seed(SEEDED);
    answerHost(SANDBOX_HOST, CODEX_READY);
    mount();
    await waitForCreateChats(1);

    await reload();
    mount();
    await act(async () => {
      await Promise.resolve();
    });

    expect(createChatCalls()).toHaveLength(1);
    expect(screen.queryByTestId("pending-sandbox-message")).toBeNull();
    // The record is kept for its ready line.
    expect(
      usePendingSandboxSendStore.getState().sends[SEND_ID]?.delivery,
    ).toMatchObject({ hostId: SANDBOX_HOST, sandboxId: SANDBOX_ID });
  });

  it("persists the message and its run settings and no credential or token", () => {
    seed(SEEDED);

    const record = localStorage.getItem(
      recordMapStorageKey(persistKey(STORE_KEYS.pendingSandboxSend), SEND_ID),
    );
    const stage = localStorage.getItem(
      recordMapStorageKey(persistKey(STORE_KEYS.stagedSandboxSend), SURFACE),
    );

    if (record === null || stage === null) throw new Error("nothing persisted");
    for (const json of [record, stage]) {
      expect(
        JSON.stringify(Object.keys(flattenKeys(JSON.parse(json)))),
      ).not.toMatch(
        /token|credential|secret|password|apikey|authorization|cookie/i,
      );
    }
    expect(Object.keys(sendOf(record))).toEqual([
      "id",
      "userId",
      "epicId",
      "request",
      "content",
      "text",
      "settings",
      "createdAt",
      "epicConfirmed",
      "delivery",
    ]);
  });

  it("keeps independent pending records when stale windows each persist one", () => {
    const name = persistKey(STORE_KEYS.pendingSandboxSend);
    const first = createRecordMapStorage("sends");
    const second = createRecordMapStorage("sends");
    first.getItem(name);
    second.getItem(name);
    const p = pendingSend({ id: "send-p" });
    const q = pendingSend({ id: "send-q" });

    first.setItem(
      name,
      JSON.stringify({ state: { sends: { [p.id]: p } }, version: 1 }),
    );
    second.setItem(
      name,
      JSON.stringify({ state: { sends: { [q.id]: q } }, version: 1 }),
    );
    const newStorage = createRecordMapStorage("sends");

    expect(localStorage.getItem(recordMapStorageKey(name, p.id))).toBe(
      JSON.stringify(p),
    );
    expect(localStorage.getItem(recordMapStorageKey(name, q.id))).toBe(
      JSON.stringify(q),
    );
    expect(JSON.parse(newStorage.getItem(name) ?? "{}")).toMatchObject({
      state: { sends: { [p.id]: p, [q.id]: q } },
    });
  });

  it("keeps a pending stage when a stale composer window persists its own pick", () => {
    const name = persistKey(STORE_KEYS.stagedSandboxSend);
    const first = createRecordMapStorage("bySurface");
    const second = createRecordMapStorage("bySurface");
    first.getItem(name);
    second.getItem(name);
    const pendingKey = pendingSendSurfaceKey("send-p");
    const composerKey = "landing:window-2";
    const pending = { phase: "creating", clientRequestId: "send-p" };
    const composer = { phase: "staged" };

    first.setItem(
      name,
      JSON.stringify({
        state: { bySurface: { [pendingKey]: pending } },
        version: 1,
      }),
    );
    second.setItem(
      name,
      JSON.stringify({
        state: { bySurface: { [composerKey]: composer } },
        version: 1,
      }),
    );
    const newStorage = createRecordMapStorage("bySurface");

    expect(localStorage.getItem(recordMapStorageKey(name, pendingKey))).toBe(
      JSON.stringify(pending),
    );
    expect(localStorage.getItem(recordMapStorageKey(name, composerKey))).toBe(
      JSON.stringify(composer),
    );
    expect(JSON.parse(newStorage.getItem(name) ?? "{}")).toMatchObject({
      state: { bySurface: { [pendingKey]: pending, [composerKey]: composer } },
    });
  });
});

describe("a send opened in two windows", () => {
  it("rehydrates after a foreign owner releases and does not deliver its stale pending record", async () => {
    const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
    const foreignHold = Promise.withResolvers<void>();
    const locks = {
      request: vi.fn(
        (_name: string, _options: LockOptions, callback: () => Promise<void>) =>
          foreignHold.promise.then(callback),
      ),
    };
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: locks,
    });
    try {
      seed(SEEDED);
      answerHost(SANDBOX_HOST, CODEX_READY);
      mount();

      await waitFor(() => {
        expect(locks.request).toHaveBeenCalledTimes(1);
      });
      expect(createChatCalls()).toEqual([]);

      // The other window finished while this one waited. Its storage event has
      // not reached this stale window; the grant-time rehydrate is the guard.
      localStorage.setItem(
        recordMapStorageKey(persistKey(STORE_KEYS.pendingSandboxSend), SEND_ID),
        "null",
      );
      localStorage.setItem(
        recordMapStorageKey(persistKey(STORE_KEYS.stagedSandboxSend), SURFACE),
        "null",
      );
      foreignHold.resolve();

      await waitFor(() => {
        expect(usePendingSandboxSendStore.getState().sends).toEqual({});
      });
      expect(createChatCalls()).toEqual([]);
      expect(readStagedSandbox(SURFACE)).toBeNull();
    } finally {
      if (originalLocks === undefined) {
        Reflect.deleteProperty(navigator, "locks");
      } else {
        Object.defineProperty(navigator, "locks", originalLocks);
      }
    }
  });

  it("cancels a queued lock when its driver unmounts", async () => {
    const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
    const locks = {
      request: vi.fn(
        (
          _name: string,
          _options: LockOptions,
          _callback: () => Promise<void>,
        ) => new Promise<void>(() => undefined),
      ),
    };
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: locks,
    });
    try {
      seed(SEEDED);
      const view = mount();

      await waitFor(() => {
        expect(locks.request).toHaveBeenCalledTimes(1);
      });
      view.unmount();
      await act(async () => {
        await Promise.resolve();
      });

      expect(locks.request.mock.calls.at(0)?.[1].signal?.aborted).toBe(true);
      expect(createChatCalls()).toEqual([]);
    } finally {
      if (originalLocks === undefined) {
        Reflect.deleteProperty(navigator, "locks");
      } else {
        Object.defineProperty(navigator, "locks", originalLocks);
      }
    }
  });
});

describe("a send whose sandbox cannot take it", () => {
  it("keeps a sandbox lifecycle failure when the requested agent is ready", () => {
    seed(SEEDED);
    useStagedSandboxStore.getState().report(SURFACE, {
      failure: {
        kind: "failed",
        code: "PROVIDER_CREATE_FAILED",
        step: "delivering",
      },
    });
    answerHost(SANDBOX_HOST, CODEX_READY);
    mount();

    expect(readStagedSandbox(SURFACE)?.failure).toEqual({
      kind: "failed",
      code: "PROVIDER_CREATE_FAILED",
      step: "delivering",
    });
    expect(createChatCalls()).toEqual([]);
  });

  it("ends the send when the sandbox failed while it was created, gives the message back to a closed Draft, and never delivers", async () => {
    seed({ ...SEEDED, phase: "creating", created: true });
    const failed = sandboxSummaryFixture({
      id: SANDBOX_ID,
      hostId: SANDBOX_HOST,
      state: "failed",
      failureCode: "PROVIDER_CREATE_FAILED",
    });
    mocks.listSandboxes.mockResolvedValue(listAnswers([failed]));
    // The account's list is one fact: the control plane and the strip read it.
    answerSandboxRows([failed], Date.now() + 60_000);
    answerHost(SANDBOX_HOST, CODEX_READY);
    mount();

    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    expectSendRecovered("chat");
  });

  it("settles to the refusal in place when the create is refused, and Choose another host gives the whole message back to the composer, for the pane it named", async () => {
    const restoreLocks = installImmediateExclusiveLocks();
    try {
      seed({
        ...SEEDED,
        send: { request: { kind: "chat", parentId: null, placement: PANE } },
        phase: "creating",
        created: false,
      });
      mocks.createSandbox.mockResolvedValue({
        kind: "refused",
        status: 402,
        code: "insufficient_credit",
        reason: null,
        shortfallMc: 120,
        newRateMcPerHour: null,
        currentAwakeBurnMcPerHour: null,
        message: "refused",
      });
      mount();

      await waitFor(() => {
        expect(readStagedSandbox(SURFACE)?.failure).toMatchObject({
          kind: "credits",
        });
      });
      expect(createChatCalls()).toEqual([]);

      fireEvent.click(
        within(screen.getByTestId("sandbox-refusal-line")).getByRole("button", {
          name: "Choose another host",
        }),
      );

      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
      expect(readStagedSandbox(SURFACE)).toBeNull();
      expect(
        useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"],
      ).toMatchObject({ content: MESSAGE_CONTENT, settings: PICKED_SETTINGS });
      expect(useNewConversationModalOpenStore.getState().request).toMatchObject(
        { epicId: "epic-1", tabId: "tab-1", placement: PANE },
      );
    } finally {
      restoreLocks();
    }
  });

  it.each(["chat", "fork"] as const)(
    "re-reads a sandbox gone while the %s record waited, ends the send and sends nothing into it",
    async (kind) => {
      seed({
        ...SEEDED,
        send: kind === "fork" ? { request: FORK_REQUEST } : {},
        phase: "creating",
        created: true,
      });
      // The list no longer holds the sandbox: it was destroyed in the gap.
      mocks.listSandboxes.mockResolvedValue(listAnswers([]));
      answerSandboxRows([], Date.now() + 60_000);
      answerHost(SANDBOX_HOST, CODEX_READY);
      mount();

      await waitFor(() => {
        expect(usePendingSandboxSendStore.getState().sends).toEqual({});
      });
      expectSendRecovered(kind);
    },
  );
});

describe("a send at its handoff whose sandbox is gone", () => {
  const FRESH = Date.now() + 60_000;

  it.each(
    (["chat", "fork"] as const).flatMap((kind) =>
      (["gone", "failed", "destroying", "destroyed"] as const).map(
        (state) => [kind, state] as const,
      ),
    ),
  )(
    "ends a %s send at its handoff, with no lock to take, when a fresh read shows the sandbox %s",
    async (kind, state) => {
      seed({
        ...SEEDED,
        send: kind === "fork" ? { request: FORK_REQUEST } : {},
        phase: "handoff",
        created: true,
      });
      mocks.listReadAt = FRESH;
      mocks.sandboxes =
        state === "gone"
          ? []
          : [
              sandboxSummaryFixture({
                id: SANDBOX_ID,
                hostId: SANDBOX_HOST,
                state,
              }),
            ];
      // The ended sandbox's host never answers.
      mount();

      await waitFor(() => {
        expect(usePendingSandboxSendStore.getState().sends).toEqual({});
      });
      expectSendRecovered(kind);
    },
  );

  it("does not read a list cached before the page mounted as the sandbox being gone", async () => {
    seed({ ...SEEDED, phase: "handoff", created: true });
    mocks.listReadAt = 1;
    mocks.sandboxes = [];
    mount();
    await act(async () => {
      await Promise.resolve();
    });

    expect(readStagedSandbox(SURFACE)?.failure).toBeNull();
  });

  it("leaves a sandbox that is awake in the fresh list alone", async () => {
    seed({ ...SEEDED, phase: "handoff", created: true });
    mocks.listReadAt = FRESH;
    mocks.sandboxes = [
      sandboxSummaryFixture({
        id: SANDBOX_ID,
        hostId: SANDBOX_HOST,
        state: "awake",
      }),
    ];
    mount();
    await act(async () => {
      await Promise.resolve();
    });

    expect(readStagedSandbox(SURFACE)?.failure).toBeNull();
  });

  it("reads the list again on the poll tick while it waits for the agent", async () => {
    vi.useFakeTimers();
    try {
      seed({ ...SEEDED, phase: "handoff", created: true });
      answerHost(SANDBOX_HOST, CODEX_DOWNLOADING);
      mount();
      // The driver mounts its work once it holds the send: await that grant.
      const ownership = holdPendingSandboxSendOwnership(SEND_ID);
      try {
        await act(async () => {
          await ownership.ready;
        });
      } finally {
        ownership.release();
      }
      mocks.refetchSandboxes.mockClear();

      act(() => {
        vi.advanceTimersByTime(2_100);
      });

      expect(mocks.refetchSandboxes).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a send whose task may not exist yet", () => {
  const CREDITS_REFUSED: SandboxCreateFetchResult = {
    kind: "refused",
    status: 402,
    code: "insufficient_credit",
    reason: null,
    shortfallMc: 120,
    newRateMcPerHour: null,
    currentAwakeBurnMcPerHour: null,
    message: "refused",
  };

  it("gives a record that came back from a reload without its task confirmed back to a start-task draft, creating and waking nothing", async () => {
    const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: (
          _name: string,
          _options: LockOptions,
          callback: () => Promise<void>,
        ) => callback(),
      },
    });
    try {
      // Seeded the way a rehydrated record is: this window never handed it.
      seed({
        ...SEEDED,
        send: { epicConfirmed: false },
        phase: "creating",
        created: false,
      });
      mocks.createSandbox.mockResolvedValue(CREDITS_REFUSED);
      mount();

      await waitFor(() => {
        expect(usePendingSandboxSendStore.getState().sends).toEqual({});
      });
      expect(readStagedSandbox(SURFACE)).toBeNull();
      expect(mocks.createSandbox).not.toHaveBeenCalled();
      expect(mocks.wake).not.toHaveBeenCalled();
      expect(createChatCalls()).toEqual([]);
      // Its only copy is not dropped: the message is a draft again, put away
      // in the Drafts list, with the composer left where it was.
      expect(useLandingDraftStore.getState().drafts).toMatchObject([
        { content: MESSAGE_CONTENT, settings: PICKED_SETTINGS, closed: true },
      ]);
      expect(useLandingDraftStore.getState().activeDraftId).toBeNull();
    } finally {
      if (originalLocks === undefined) {
        Reflect.deleteProperty(navigator, "locks");
      } else {
        Object.defineProperty(navigator, "locks", originalLocks);
      }
    }
  });

  it("keeps an unconfirmed send in a shell without exclusive locks", async () => {
    const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
    Reflect.deleteProperty(navigator, "locks");
    try {
      seed({
        ...SEEDED,
        send: { epicConfirmed: false },
        phase: "creating",
        created: false,
      });
      mount();
      await act(async () => {
        await Promise.resolve();
      });

      expect(
        usePendingSandboxSendStore.getState().sends[SEND_ID],
      ).toBeDefined();
      expect(readStagedSandbox(SURFACE)).not.toBeNull();
      expect(useLandingDraftStore.getState().drafts).toEqual([]);
      expect(mocks.createSandbox).not.toHaveBeenCalled();
    } finally {
      if (originalLocks !== undefined) {
        Object.defineProperty(navigator, "locks", originalLocks);
      }
    }
  });

  it("gives a confirmed send whose stage is gone back to its task's composer, and leaves another account's send alone", async () => {
    const restoreLocks = installImmediateExclusiveLocks();
    try {
      usePendingSandboxSendStore
        .getState()
        .add(pendingSend({ id: "foreign-send", userId: "user-other" }));
      mount();
      await act(async () => {
        await Promise.resolve();
      });
      // Another account's: this one's driver never takes it up.
      expect(
        usePendingSandboxSendStore.getState().sends["foreign-send"],
      ).toBeDefined();
      cleanup();

      usePendingSandboxSendStore.setState({ sends: {} });
      usePendingSandboxSendStore.getState().add(pendingSend({ id: SEND_ID }));
      mount();

      await waitFor(() => {
        expect(usePendingSandboxSendStore.getState().sends).toEqual({});
      });
      expect(
        useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"],
      ).toMatchObject({ content: MESSAGE_CONTENT, settings: PICKED_SETTINGS });
      expect(createChatCalls()).toEqual([]);
    } finally {
      restoreLocks();
    }
  });

  it("keeps a confirmed record from a reload and takes up its create", async () => {
    seed({
      ...SEEDED,
      send: { epicConfirmed: true },
      phase: "creating",
      created: false,
    });
    mocks.createSandbox.mockResolvedValue(CREDITS_REFUSED);
    mount();

    await waitFor(() => {
      expect(mocks.createSandbox).toHaveBeenCalledTimes(1);
    });
  });

  it("starts a landing send's create only once its task's create has answered", async () => {
    const composerSurface = "landing:draft-1";
    useStagedSandboxStore.getState().stage(composerSurface, NEW_TARGET);
    mocks.createSandbox.mockResolvedValue(CREDITS_REFUSED);
    const id = handPendingSandboxSend({
      fromSurfaceKey: composerSurface,
      epicId: "epic-1",
      request: { kind: "chat", parentId: null, placement: null },
      content: MESSAGE_CONTENT,
      text: "fix the login bug",
      settings: PICKED_SETTINGS,
      epicConfirmed: false,
      now: Date.now(),
    });
    expect(id).not.toBeNull();
    mount();
    await act(async () => {
      await Promise.resolve();
    });

    // The task's create is still on its way: nothing is created, the send stays.
    expect(mocks.createSandbox).not.toHaveBeenCalled();
    expect(Object.keys(usePendingSandboxSendStore.getState().sends)).toEqual([
      id,
    ]);

    act(() => {
      if (id !== null) confirmPendingSandboxSendEpic(id);
    });

    await waitFor(() => {
      expect(mocks.createSandbox).toHaveBeenCalledTimes(1);
    });
  });
});

describe("a send whose sandbox rests while it waits for the agent", () => {
  const FRESH = Date.now() + 60_000;

  function rowIn(state: "suspended" | "stopped" | "awake"): SandboxSummary {
    return sandboxSummaryFixture({
      id: SANDBOX_ID,
      hostId: SANDBOX_HOST,
      state,
    });
  }

  it.each(["suspended", "stopped"] as const)(
    "wakes a %s sandbox once, under the same key, and delivers only when the agent is ready",
    async (state) => {
      seed({ ...SEEDED, phase: "handoff", created: true });
      const keyBefore = readStagedSandbox(SURFACE)?.clientRequestId;
      let finishWake: () => void = () => undefined;
      mocks.wake.mockReturnValue(
        new Promise((resolve) => {
          finishWake = () => resolve({ kind: "awake" });
        }),
      );
      mocks.listReadAt = FRESH;
      mocks.sandboxes = [rowIn(state)];
      mocks.listSandboxes.mockResolvedValue(listAnswers([rowIn("awake")]));
      answerHost(SANDBOX_HOST, CODEX_DOWNLOADING);
      mount();

      await waitFor(() => {
        expect(readStagedSandbox(SURFACE)).toMatchObject({
          phase: "creating",
          step: "booting",
          failure: null,
        });
      });
      expect(mocks.wake).toHaveBeenCalledTimes(1);
      expect(mocks.wake).toHaveBeenCalledWith(SANDBOX_HOST, "send");
      expect(readStagedSandbox(SURFACE)?.clientRequestId).toBe(keyBefore);

      await act(async () => {
        finishWake();
        await Promise.resolve();
      });
      answerSandboxRows([rowIn("awake")], FRESH + 1);
      await waitFor(() => {
        expect(readStagedSandbox(SURFACE)?.phase).toBe("handoff");
      });
      // Awake again, the requested agent is still being prepared.
      expect(createChatCalls()).toEqual([]);

      answerHost(SANDBOX_HOST, CODEX_READY);

      await waitForCreateChats(1);
      expect(mocks.wake).toHaveBeenCalledTimes(1);
      expect(mocks.createSandbox).not.toHaveBeenCalled();
    },
  );

  it("re-wakes a terminal request from a legacy handoff with the open-terminal gesture", async () => {
    seed({
      send: { request: { kind: "terminal" }, text: "" },
      target: NEW_TARGET,
      phase: "handoff",
      created: true,
      elapsedSeconds: 24,
    });
    useStagedSandboxStore.getState().report(SURFACE, { openTerminal: false });
    mocks.listReadAt = FRESH;
    mocks.sandboxes = [rowIn("suspended")];
    mocks.listSandboxes.mockResolvedValue(listAnswers([rowIn("awake")]));
    mocks.wake.mockImplementation((hostId, gesture) =>
      Promise.resolve({ kind: "awake" as const }).then((result) => {
        if (hostId === SANDBOX_HOST && gesture === "open-terminal") {
          mocks.sandboxes = [rowIn("awake")];
        }
        return result;
      }),
    );
    answerHost(SANDBOX_HOST, CODEX_DOWNLOADING);
    mount();

    await waitFor(() => {
      expect(mocks.wake).toHaveBeenCalledWith(SANDBOX_HOST, "open-terminal");
    });
    await waitFor(() => {
      expect(mocks.openTile).toHaveBeenCalledTimes(1);
    });
    expect(usePendingSandboxSendStore.getState().sends).toEqual({});
  });

  it.each(["no row", "a stale awake row"] as const)(
    "waits for a fresh sandbox row before opening after seeing %s",
    async (staleProjection) => {
      seed({
        send: { request: { kind: "terminal" }, text: "" },
        target: NEW_TARGET,
        phase: "handoff",
        created: true,
        elapsedSeconds: 24,
      });
      useStagedSandboxStore.getState().report(SURFACE, { openTerminal: false });
      mocks.listReadAt = 0;
      mocks.sandboxes = staleProjection === "no row" ? [] : [rowIn("awake")];
      mocks.listSandboxes.mockResolvedValue(listAnswers([rowIn("awake")]));
      const wake = deferred<{ readonly kind: "awake" }>();
      mocks.wake.mockReturnValue(wake.promise);
      answerHost(SANDBOX_HOST, CODEX_DOWNLOADING);
      mount();

      await waitFor(() => {
        const current = readStagedSandbox(SURFACE);
        expect(
          current?.openTerminal === true ||
            mocks.openTile.mock.calls.length > 0,
        ).toBe(true);
      });
      expect(mocks.openTile).not.toHaveBeenCalled();
      expect(
        usePendingSandboxSendStore.getState().sends[SEND_ID],
      ).toBeDefined();

      answerSandboxRows([rowIn("suspended")], Date.now() + 60_000);
      await waitFor(() => {
        expect(mocks.wake).toHaveBeenCalledWith(SANDBOX_HOST, "open-terminal");
      });
      expect(mocks.openTile).not.toHaveBeenCalled();

      answerSandboxRows([rowIn("awake")], Date.now() + 60_000);
      await act(async () => {
        wake.resolve({ kind: "awake" });
        await wake.promise;
      });

      await waitFor(() => {
        expect(mocks.openTile).toHaveBeenCalledTimes(1);
      });
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    },
  );

  it("does not wake a sandbox that is awake", async () => {
    seed({ ...SEEDED, phase: "handoff", created: true });
    mocks.listReadAt = FRESH;
    mocks.sandboxes = [rowIn("awake")];
    answerHost(SANDBOX_HOST, CODEX_DOWNLOADING);
    mount();
    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.wake).not.toHaveBeenCalled();
    expect(readStagedSandbox(SURFACE)?.phase).toBe("handoff");
  });

  it("ends the send when the sandbox it woke is reported failed, delivering nothing", async () => {
    seed({ ...SEEDED, phase: "handoff", created: true });
    mocks.listReadAt = FRESH;
    mocks.sandboxes = [rowIn("suspended")];
    mocks.listSandboxes.mockResolvedValue(
      listAnswers([
        sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: SANDBOX_HOST,
          state: "failed",
          failureCode: "PROVIDER_CREATE_FAILED",
        }),
      ]),
    );
    answerHost(SANDBOX_HOST, CODEX_READY);
    mount();

    await waitFor(() => {
      expect(mocks.wake).toHaveBeenCalledWith(SANDBOX_HOST, "send");
    });
    answerSandboxRows(
      [
        sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: SANDBOX_HOST,
          state: "failed",
          failureCode: "PROVIDER_CREATE_FAILED",
        }),
      ],
      FRESH + 1,
    );
    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    expectSendRecovered("chat");
  });
});

describe("a send whose message carries images, delivered on its sandbox", () => {
  const IMAGE_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 7]);

  function withImage(hash: string): JsonContent {
    return {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "see this" }],
        },
        {
          type: "imageAttachment",
          attrs: { hash, byHashEligible: true, mimeType: "image/png" },
        },
      ],
    };
  }

  function imageNodes(content: JsonContent): JsonContent[] {
    const found: JsonContent[] = [];
    const visit = (node: JsonContent): void => {
      if (node.type === "imageAttachment") found.push(node);
      for (const child of node.content ?? []) visit(child);
    };
    visit(content);
    return found;
  }

  function sentMessage(): {
    readonly content: JsonContent;
    readonly attachmentsByHash: boolean;
  } {
    const initial = createChatCalls()[0]?.input.initialMessage;
    if (initial === null || initial === undefined) {
      throw new Error("no first message was sent");
    }
    return {
      content: initial.content,
      attachmentsByHash: "attachmentsByHash" in initial,
    };
  }

  beforeEach(() => {
    installFreshIndexedDb();
  });

  afterEach(() => {
    resetDraftBlobTransportForTests();
    resetNegotiatedManifests();
  });

  it("keeps the message's images rooted against the landing GC while it waits, and lets them go once it ends", async () => {
    const hash = "c".repeat(64);
    const imageContent: JsonContent = {
      type: "doc",
      content: [
        {
          type: "imageAttachment",
          attrs: { id: "img-1", hash, mimeType: "image/png" },
        },
      ],
    };
    seed({
      ...SEEDED,
      send: { content: imageContent },
      phase: "handoff",
      created: true,
    });

    expect(landingLiveImageRootHashes().has(hash)).toBe(true);

    // Only the window that holds the send can claim and settle it.
    const ownership = holdPendingSandboxSendOwnership(SEND_ID);
    await ownership.ready;
    try {
      // Only a claimed send can be accepted: the claim keeps the roots too.
      const delivery = {
        chatId: "chat-1",
        hostId: SANDBOX_HOST,
        sandboxId: SANDBOX_ID,
        readySeconds: 24,
      };
      const claimed = usePendingSandboxSendStore
        .getState()
        .beginDispatch(SEND_ID, {
          input: {
            epicId: "epic-1",
            hostId: SANDBOX_HOST,
            parentId: null,
            title: "",
            chatId: "chat-1",
            workspaceMode: "folderless",
            worktreeIntent: null,
            settings: PICKED_SETTINGS,
            initialMessage: {
              messageId: "message-1",
              clientActionId: "action-1",
              content: imageContent,
              sender: { type: "user", userId: "user-1" },
              settings: PICKED_SETTINGS,
              accountContext: { type: "PERSONAL" },
              sentFromHostId: null,
            },
          },
          status: "sending",
          delivery,
        });
      expect(claimed).toBe(true);
      expect(landingLiveImageRootHashes().has(hash)).toBe(true);

      // Delivered: the agent's chat holds the message now, not the send.
      usePendingSandboxSendStore.getState().markDelivered(SEND_ID, delivery);
      expect(landingLiveImageRootHashes().has(hash)).toBe(false);
    } finally {
      ownership.release();
    }
  });

  it("inlines the bytes from this device when the sandbox does not take images by hash, leaving no hash-only node", async () => {
    const hash = await putImage(IMAGE_BYTES);
    seed({
      ...SEEDED,
      send: { content: withImage(hash) },
      phase: "handoff",
      created: true,
    });
    recordNegotiatedHostManifest(SANDBOX_HOST, {
      "epic.createChat": { major: 1, minor: 1 },
    });
    answerHost(SANDBOX_HOST, CODEX_READY);
    mount();

    await waitFor(() => {
      expect(createChatCalls()).toHaveLength(1);
    });
    const { content, attachmentsByHash } = sentMessage();
    const [node] = imageNodes(content);
    expect(imageNodes(content)).toHaveLength(1);
    expect(typeof node.attrs?.b64content).toBe("string");
    expect(attachmentsByHash).toBe(false);
    expect(
      mocks.wire.filter((entry) => entry.startsWith("drafts.putBlob")),
    ).toEqual([]);
  });

  it("uploads the image to the sandbox before the create, and sends by hash, when it takes them", async () => {
    const hash = await putImage(IMAGE_BYTES);
    seed({
      ...SEEDED,
      send: { content: withImage(hash) },
      phase: "handoff",
      created: true,
    });
    recordNegotiatedHostManifest(SANDBOX_HOST, {
      "epic.createChat": { major: 1, minor: 2 },
    });
    answerHost(SANDBOX_HOST, CODEX_READY);
    mount();

    await waitFor(() => {
      expect(createChatCalls()).toHaveLength(1);
    });
    expect(mocks.wire).toEqual([`drafts.putBlob:${hash}`, "epic.createChat"]);
    const { content, attachmentsByHash } = sentMessage();
    expect(attachmentsByHash).toBe(true);
    expect(imageNodes(content)[0].attrs?.b64content).toBeUndefined();
    expect(imageNodes(content)[0].attrs?.hash).toBe(hash);
  });

  it("sends nothing and offers Retry when an image's bytes are nowhere on this device", async () => {
    const restoreLocks = installImmediateExclusiveLocks();
    try {
      seed({
        ...SEEDED,
        send: { content: withImage("f".repeat(64)) },
        phase: "handoff",
        created: true,
      });
      answerHost(SANDBOX_HOST, CODEX_READY);
      mount();

      await waitFor(() => {
        expect(readStagedSandbox(SURFACE)?.failure).toEqual({
          kind: "not-sent",
        });
      });
      expect(createChatCalls()).toEqual([]);
      const line = screen.getByTestId("sandbox-refusal-line");
      expect(within(line).getByRole("button", { name: "Retry" })).toBeDefined();
      expect(
        within(line).getByRole("button", { name: "Choose another host" }),
      ).toBeDefined();
    } finally {
      restoreLocks();
    }
  });
});

describe("a fork waiting on its sandbox", () => {
  it("keeps a fork wake classified as a send", async () => {
    const request = {
      kind: "fork" as const,
      parentId: null,
      title: "Sandbox fork",
      forkSource: {
        boundary: "assistantMessage" as const,
        sourceChatId: "source-chat",
        assistantMessageId: "assistant-message-1",
        interviewBlockId: null,
        carriedInterviews: "settled" as const,
        sourceOwnerUserId: null,
      },
      tabId: "tab-1",
    };
    seed({ ...SEEDED, send: { request } });
    mocks.listReadAt = Date.now() + 60_000;
    const resting = sandboxSummaryFixture({
      id: SANDBOX_ID,
      hostId: SANDBOX_HOST,
      state: "suspended",
    });
    mocks.sandboxes = [resting];
    mocks.listSandboxes.mockResolvedValue(listAnswers([resting]));
    answerHost(SANDBOX_HOST, CODEX_DOWNLOADING);
    mount();

    await waitFor(() => {
      expect(mocks.wake).toHaveBeenCalledWith(SANDBOX_HOST, "send");
    });
    expect(createChatCalls()).toEqual([]);
  });

  it("retains a fork when its actual sandbox host is v1.0 and dispatches it once only after explicit Retry on v1.1", async () => {
    const request = {
      kind: "fork" as const,
      parentId: null,
      title: "Sandbox fork",
      forkSource: {
        boundary: "assistantMessage" as const,
        sourceChatId: "source-chat",
        assistantMessageId: "assistant-message-1",
        interviewBlockId: null,
        carriedInterviews: "settled" as const,
        sourceOwnerUserId: null,
      },
      tabId: "tab-1",
    };
    seed({ ...SEEDED, send: { request } });
    recordNegotiatedHostManifest(SANDBOX_HOST, {
      "epic.createChat": { major: 1, minor: 0 },
    });
    answerHost(SANDBOX_HOST, CODEX_READY);
    mount();

    await waitFor(() => {
      expect(readStagedSandbox(SURFACE)?.failure).toEqual({ kind: "not-sent" });
    });
    expect(createChatCalls()).toEqual([]);
    expect(
      usePendingSandboxSendStore.getState().sends[SEND_ID]?.request,
    ).toEqual(request);

    recordNegotiatedHostManifest(SANDBOX_HOST, {
      "epic.createChat": { major: 1, minor: 1 },
    });
    expect(createChatCalls()).toEqual([]);
    fireEvent.click(
      within(screen.getByTestId("sandbox-refusal-line")).getByRole("button", {
        name: "Retry",
      }),
    );

    await waitForCreateChats(1);
    expect(createChatCalls()[0].clientHostId).toBe(SANDBOX_HOST);
    expect(createChatCalls()[0].input).toMatchObject({
      hostId: SANDBOX_HOST,
      title: request.title,
      forkSource: request.forkSource,
    });
    expect(
      usePendingSandboxSendStore.getState().sends[SEND_ID]?.delivery,
    ).toMatchObject({ hostId: SANDBOX_HOST, sandboxId: SANDBOX_ID });
    expect(readStagedSandbox(SURFACE)).toBeNull();
    expect(mocks.createSandbox).not.toHaveBeenCalled();
    expect(createChatCalls()).toHaveLength(1);
  });

  it("keeps its staged handoff after a checkpoint-publishing rejection and retries only after Retry", async () => {
    seed({
      ...SEEDED,
      send: {
        request: {
          kind: "fork",
          parentId: null,
          title: "Sandbox fork",
          forkSource: {
            boundary: "assistantMessage",
            sourceChatId: "source-chat",
            assistantMessageId: "assistant-message-1",
            interviewBlockId: null,
            carriedInterviews: "settled",
            sourceOwnerUserId: null,
          },
          tabId: "tab-1",
        },
      },
    });
    mocks.createChatError = new HostRpcError({
      code: "E_FORK_BOUNDARY_NOT_PUBLISHED",
      message: "Checkpoint is still publishing.",
      requestId: "request-1",
      method: "epic.createChat",
      fatalDetails: null,
    });
    answerHost(SANDBOX_HOST, CODEX_READY);
    mount();

    await waitFor(() => {
      expect(readStagedSandbox(SURFACE)?.failure).toEqual({ kind: "not-sent" });
    });
    expect(readStagedSandbox(SURFACE)).toMatchObject({
      phase: "handoff",
      createdHostId: SANDBOX_HOST,
      createdSandboxId: SANDBOX_ID,
      failure: { kind: "not-sent" },
    });
    expect(createChatCalls()).toHaveLength(1);
    expect(usePendingSandboxSendStore.getState().sends[SEND_ID]).toMatchObject({
      delivery: null,
    });
    expect(
      within(screen.getByTestId("sandbox-refusal-line")).getByRole("button", {
        name: "Retry",
      }),
    ).toBeDefined();

    mocks.createChatError = null;
    fireEvent.click(
      within(screen.getByTestId("sandbox-refusal-line")).getByRole("button", {
        name: "Retry",
      }),
    );

    await waitForCreateChats(2);
    expect(createChatCalls()[1]?.input.chatId).toBe(
      createChatCalls()[0]?.input.chatId,
    );
  });

  it("replays an uncertain fork from its saved request after the stage is missing", async () => {
    const request = {
      kind: "fork" as const,
      parentId: null,
      title: "Sandbox fork",
      forkSource: {
        boundary: "assistantMessage" as const,
        sourceChatId: "source-chat",
        assistantMessageId: "assistant-message-1",
        interviewBlockId: null,
        carriedInterviews: "settled" as const,
        sourceOwnerUserId: null,
      },
      tabId: "tab-1",
    };
    seed({ ...SEEDED, send: { request } });
    const create = Promise.withResolvers<CreateChatResponseV12>();
    mocks.createChatDeferred = create.promise;
    answerHost(SANDBOX_HOST, CODEX_READY);
    mount();
    try {
      await waitForCreateChats(1);
      const firstCalls = createChatCalls();
      if (!Object.hasOwn(firstCalls, 0)) {
        throw new Error("expected a fork create");
      }
      const firstInput = firstCalls[0].input;
      await act(async () => {
        create.reject(new Error("The reply was lost."));
        await create.promise.catch(() => undefined);
      });

      const dispatch = await screen.findByTestId("pending-sandbox-dispatch");
      expect(dispatch.textContent).toContain(
        "Couldn't confirm the agent was created.",
      );
      expect(
        usePendingSandboxSendStore.getState().sends[SEND_ID],
      ).toBeDefined();
      expect(createChatCalls()).toHaveLength(1);
      expect(
        screen.getByTestId("pending-sandbox-dispatch-retry"),
      ).toBeDefined();

      useStagedSandboxStore.getState().clear(SURFACE);
      await reloadPendingSandboxStores();
      mount();
      const reloadedDispatch = await screen.findByTestId(
        "pending-sandbox-dispatch",
      );
      expect(reloadedDispatch.textContent).toContain(
        "Couldn't confirm the agent was created.",
      );
      expect(createChatCalls()).toHaveLength(1);

      mocks.createChatDeferred = null;
      mocks.createChatError = null;
      fireEvent.click(screen.getByTestId("pending-sandbox-dispatch-retry"));

      await waitForCreateChats(2);
      expect(createChatCalls()[1]?.clientHostId).toBe(
        createChatCalls()[0]?.clientHostId,
      );
      expect(createChatCalls()[1]?.input).toEqual(firstInput);
      await waitFor(() => {
        expect(
          usePendingSandboxSendStore.getState().sends[SEND_ID]?.delivery,
        ).toMatchObject({ hostId: SANDBOX_HOST, sandboxId: SANDBOX_ID });
      });
    } finally {
      await act(async () => {
        create.resolve({
          chatId: createChatCalls()[0]?.input.chatId ?? "cleanup-chat",
        });
        await create.promise.catch(() => undefined);
      });
    }
  });
});

describe("a terminal request handed to a staged sandbox", () => {
  it("persists its open-terminal intent and uses that gesture on the requested host", async () => {
    const sourceSurface = "modal-terminal-request";
    useStagedSandboxStore.getState().stage(sourceSurface, RESUME_TARGET);
    const sendId = handPendingSandboxSend({
      fromSurfaceKey: sourceSurface,
      epicId: "epic-1",
      request: { kind: "terminal" },
      content: MESSAGE_CONTENT,
      text: "",
      settings: PICKED_SETTINGS,
      epicConfirmed: true,
      now: Date.now(),
    });
    if (sendId === null) throw new Error("expected a staged terminal send");
    const surfaceKey = pendingSendSurfaceKey(sendId);
    expect.soft(readStagedSandbox(surfaceKey)?.openTerminal).toBe(true);
    const ready = sandboxSummaryFixture({
      id: SANDBOX_ID,
      hostId: SANDBOX_HOST,
      state: "awake",
      guestConfigured: true,
    });
    mocks.listReadAt = Date.now() + 60_000;
    mocks.sandboxes = [ready];
    mocks.listSandboxes.mockResolvedValue(listAnswers([ready]));

    mount();

    await waitFor(() => {
      expect(mocks.wake).toHaveBeenCalledWith(SANDBOX_HOST, "open-terminal");
    });
    await waitFor(() => {
      expect(mocks.openTile).toHaveBeenCalledTimes(1);
    });
    expect(JSON.stringify(mocks.openTile.mock.calls[0][0])).toContain(
      SANDBOX_HOST,
    );
    expect(JSON.stringify(mocks.openTile.mock.calls[0][0])).toContain(sendId);
    expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    expect(readStagedSandbox(surfaceKey)).toBeNull();
  });

  it("recovers the open-terminal gesture for a rehydrated record without its intent flag", async () => {
    const sourceSurface = "rehydrated-terminal-request";
    useStagedSandboxStore.getState().stage(sourceSurface, RESUME_TARGET);
    const sendId = handPendingSandboxSend({
      fromSurfaceKey: sourceSurface,
      epicId: "epic-1",
      request: { kind: "terminal" },
      content: MESSAGE_CONTENT,
      text: "",
      settings: PICKED_SETTINGS,
      epicConfirmed: true,
      now: Date.now(),
    });
    if (sendId === null) throw new Error("expected a staged terminal send");
    const surfaceKey = pendingSendSurfaceKey(sendId);
    useStagedSandboxStore.getState().report(surfaceKey, {
      openTerminal: false,
    });
    expect(readStagedSandbox(surfaceKey)?.openTerminal).toBe(false);
    const ready = sandboxSummaryFixture({
      id: SANDBOX_ID,
      hostId: SANDBOX_HOST,
      state: "awake",
      guestConfigured: true,
    });
    mocks.listReadAt = Date.now() + 60_000;
    mocks.sandboxes = [ready];
    mocks.listSandboxes.mockResolvedValue(listAnswers([ready]));

    mount();

    await waitFor(() => {
      expect(mocks.wake).toHaveBeenCalledWith(SANDBOX_HOST, "open-terminal");
    });
    await waitFor(() => {
      expect(mocks.openTile).toHaveBeenCalledTimes(1);
    });
    expect(JSON.stringify(mocks.openTile.mock.calls[0][0])).toContain(sendId);
  });
});

describe("a pending chat create", () => {
  it("keeps the send and its stage until the sandbox accepts the create", async () => {
    seed(SEEDED);
    const create = deferred<CreateChatResponseV12>();
    mocks.createChatDeferred = create.promise;
    answerHost(SANDBOX_HOST, CODEX_READY);
    mount();

    try {
      await waitForCreateChats(1);
      expect(
        usePendingSandboxSendStore.getState().sends[SEND_ID]?.delivery,
      ).toBeNull();
      expect(readStagedSandbox(SURFACE)).toMatchObject({
        phase: "handoff",
        createdHostId: SANDBOX_HOST,
        createdSandboxId: SANDBOX_ID,
      });
    } finally {
      await resolvePendingCreate(create);
    }
    await waitFor(() => {
      expect(
        usePendingSandboxSendStore.getState().sends[SEND_ID]?.delivery,
      ).toMatchObject({ hostId: SANDBOX_HOST, sandboxId: SANDBOX_ID });
    });
    expect(readStagedSandbox(SURFACE)).toBeNull();
  });

  it("does not return a chat while its create is unresolved", async () => {
    seed(SEEDED);
    const create = deferred<CreateChatResponseV12>();
    mocks.createChatDeferred = create.promise;
    answerHost(SANDBOX_HOST, CODEX_READY);
    mount();

    try {
      await waitForCreateChats(1);
      expect(returnPendingSandboxSend(SEND_ID)).toEqual({
        kind: "dispatching",
      });
      endPendingSandboxSend(SEND_ID);
      expect(
        usePendingSandboxSendStore.getState().sends[SEND_ID],
      ).toBeDefined();
    } finally {
      await resolvePendingCreate(create);
    }
    await waitFor(() => {
      expect(
        usePendingSandboxSendStore.getState().sends[SEND_ID]?.delivery,
      ).toMatchObject({ hostId: SANDBOX_HOST, sandboxId: SANDBOX_ID });
    });
    expect(
      usePendingSandboxSendStore.getState().sends[SEND_ID]?.delivery,
    ).toMatchObject({ hostId: SANDBOX_HOST, sandboxId: SANDBOX_ID });
  });

  it.each(["absent", "rejected"] as const)(
    "hides withdrawal and stop actions when native locks are %s",
    async (lockState) => {
      const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
      Reflect.deleteProperty(navigator, "locks");
      if (lockState === "rejected") {
        Object.defineProperty(navigator, "locks", {
          configurable: true,
          value: {
            request: (
              _name: string,
              _options: LockOptions,
              _callback: () => Promise<void>,
            ) => Promise.reject(new Error("Lock service unavailable.")),
          },
        });
      }
      try {
        seed({ ...SEEDED, elapsedSeconds: 120 });
        answerHost(SANDBOX_HOST, CODEX_DOWNLOADING);
        mount();
        await screen.findByTestId("sandbox-setup-line");

        expect(screen.queryByTestId("sandbox-setup-cancel")).toBeNull();
        expect(
          screen.queryByTestId("sandbox-setup-choose-another-host"),
        ).toBeNull();
        expect(returnPendingSandboxSend(SEND_ID)).toEqual({ kind: "none" });
        endPendingSandboxSend(SEND_ID);
        expect(
          usePendingSandboxSendStore.getState().sends[SEND_ID],
        ).toBeDefined();

        act(() => {
          useStagedSandboxStore.getState().report(SURFACE, {
            failure: { kind: "settings", code: "SBX-0520" },
          });
        });
        expect(screen.queryByTestId("sandbox-setup-stop")).toBeNull();
        expect(
          screen.queryByTestId("sandbox-setup-choose-another-host"),
        ).toBeNull();
        act(() => {
          useStagedSandboxStore.getState().report(SURFACE, { failure: null });
        });

        const create = deferred<CreateChatResponseV12>();
        mocks.createChatDeferred = create.promise;
        try {
          answerHost(SANDBOX_HOST, CODEX_READY);
          await waitForCreateChats(1);
          await waitFor(() => {
            expect(
              screen.getByTestId("pending-sandbox-dispatch").textContent,
            ).toContain("Creating agent…");
          });
          expect(screen.queryByTestId("sandbox-setup-cancel")).toBeNull();
          expect(
            screen.queryByTestId("sandbox-setup-choose-another-host"),
          ).toBeNull();
          expect(screen.queryByTestId("sandbox-setup-stop")).toBeNull();
          expect(returnPendingSandboxSend(SEND_ID)).toEqual({
            kind: "dispatching",
          });
          endPendingSandboxSend(SEND_ID);
          expect(
            usePendingSandboxSendStore.getState().sends[SEND_ID],
          ).toBeDefined();
        } finally {
          await resolvePendingCreate(create);
        }
        await waitFor(() => {
          expect(
            usePendingSandboxSendStore.getState().sends[SEND_ID]?.delivery,
          ).toMatchObject({ hostId: SANDBOX_HOST, sandboxId: SANDBOX_ID });
        });
        expect(mocks.stopSandbox).not.toHaveBeenCalled();
      } finally {
        if (originalLocks === undefined) {
          Reflect.deleteProperty(navigator, "locks");
        } else {
          Object.defineProperty(navigator, "locks", originalLocks);
        }
      }
    },
  );

  it("does not stop the sandbox or return its message while createChat is unresolved", async () => {
    seed({ ...SEEDED, elapsedSeconds: 120 });
    const create = deferred<CreateChatResponseV12>();
    mocks.createChatDeferred = create.promise;
    answerHost(SANDBOX_HOST, CODEX_READY);
    mount();

    try {
      await waitForCreateChats(1);
      expect(screen.queryByTestId("sandbox-setup-stop")).toBeNull();
      expect(screen.queryByTestId("sandbox-setup-cancel")).toBeNull();
      expect(
        screen.queryByTestId("sandbox-setup-choose-another-host"),
      ).toBeNull();
      expect(returnPendingSandboxSend(SEND_ID)).toEqual({
        kind: "dispatching",
      });
      endPendingSandboxSend(SEND_ID);
      expect(
        usePendingSandboxSendStore.getState().sends[SEND_ID],
      ).toBeDefined();
    } finally {
      await resolvePendingCreate(create);
    }
    await waitFor(() => {
      expect(
        usePendingSandboxSendStore.getState().sends[SEND_ID]?.delivery,
      ).toMatchObject({ hostId: SANDBOX_HOST, sandboxId: SANDBOX_ID });
    });
    expect(mocks.stopSandbox).not.toHaveBeenCalled();
    expect(readStagedSandbox(SURFACE)).toBeNull();
  });

  it("records an accepted create for its original account after signout without account B UI effects", async () => {
    seed(SEEDED);
    const create = deferred<CreateChatResponseV12>();
    mocks.createChatDeferred = create.promise;
    answerHost(SANDBOX_HOST, CODEX_READY);
    const view = mount();

    try {
      await waitForCreateChats(1);
      act(() => {
        useAuthStore.getState().setSignedOut();
        useStagedSandboxStore.getState().clear(SURFACE);
        useAuthStore
          .getState()
          .setSignedIn(
            { userId: "user-2", userName: "V", email: "v@example.com" },
            { userId: "user-2", username: "V" },
            [],
          );
      });
    } finally {
      await resolvePendingCreate(create);
    }
    expect(usePendingSandboxSendStore.getState().sends[SEND_ID]).toMatchObject({
      userId: "user-1",
      delivery: { hostId: SANDBOX_HOST, sandboxId: SANDBOX_ID },
    });
    expect(readStagedSandbox(SURFACE)).toBeNull();
    expect(mocks.openTile).not.toHaveBeenCalled();
    expect(screen.queryByTestId("pending-sandbox-sends")).toBeNull();
    view.unmount();
  });

  it("retains a fork after a create refusal for explicit Retry", async () => {
    const request = {
      kind: "fork" as const,
      parentId: null,
      title: "Sandbox fork",
      forkSource: {
        boundary: "assistantMessage" as const,
        sourceChatId: "source-chat",
        assistantMessageId: "assistant-message-1",
        interviewBlockId: null,
        carriedInterviews: "settled" as const,
        sourceOwnerUserId: null,
      },
      tabId: "tab-1",
    };
    seed({ ...SEEDED, send: { request } });
    mocks.createChatRefusal = {
      kind: "local-store-unavailable",
      message: "The local store is busy.",
      remedy: "Try again after the other window closes.",
    };
    answerHost(SANDBOX_HOST, CODEX_READY);
    mount();

    await waitForCreateChats(1);
    await waitFor(() => {
      expect(readStagedSandbox(SURFACE)?.failure).toEqual({ kind: "not-sent" });
    });
    expect(usePendingSandboxSendStore.getState().sends[SEND_ID]).toMatchObject({
      request,
      delivery: null,
    });
    expect(readStagedSandbox(SURFACE)).toMatchObject({
      phase: "handoff",
      createdHostId: SANDBOX_HOST,
      createdSandboxId: SANDBOX_ID,
    });
    expect(
      within(screen.getByTestId("sandbox-refusal-line")).getByRole("button", {
        name: "Retry",
      }),
    ).toBeDefined();
  });

  it.each(["refusal", "rejection"] as const)(
    "keeps a chat after RPC %s and retries with the same create IDs",
    async (outcome) => {
      seed(SEEDED);
      if (outcome === "refusal") {
        mocks.createChatRefusal = {
          kind: "local-store-unavailable",
          message: "The local store is busy.",
          remedy: "Try again after the other window closes.",
        };
      } else {
        mocks.createChatError = new HostRpcError({
          code: "RPC_ERROR",
          message: "Chat create failed.",
          requestId: "request-1",
          method: "epic.createChat",
          fatalDetails: null,
        });
      }
      answerHost(SANDBOX_HOST, CODEX_READY);
      mount();

      await waitForCreateChats(1);
      if (outcome === "refusal") {
        await waitFor(() => {
          expect(readStagedSandbox(SURFACE)?.failure).toEqual({
            kind: "not-sent",
          });
        });
      } else {
        await waitFor(() => {
          expect(
            screen.getByTestId("pending-sandbox-dispatch").textContent,
          ).toContain("Couldn't confirm the agent was created.");
        });
      }
      const firstCalls = createChatCalls();
      if (!Object.hasOwn(firstCalls, 0)) {
        throw new Error("expected a chat create");
      }
      const firstInput = firstCalls[0].input;
      expect(
        usePendingSandboxSendStore.getState().sends[SEND_ID]?.delivery,
      ).toBeNull();
      expect(
        usePendingSandboxSendStore.getState().sends[SEND_ID]?.request.kind,
      ).toBe("chat");
      if (outcome === "refusal") {
        expect(
          within(screen.getByTestId("sandbox-refusal-line")).getByRole(
            "button",
            { name: "Retry" },
          ),
        ).toBeDefined();
      } else {
        expect(
          screen.getByTestId("pending-sandbox-dispatch-retry"),
        ).toBeDefined();
      }

      mocks.createChatError = null;
      mocks.createChatRefusal = null;
      if (outcome === "refusal") {
        fireEvent.click(
          within(screen.getByTestId("sandbox-refusal-line")).getByRole(
            "button",
            { name: "Retry" },
          ),
        );
      } else {
        fireEvent.click(screen.getByTestId("pending-sandbox-dispatch-retry"));
      }

      await waitForCreateChats(2);
      const retryCalls = createChatCalls();
      if (!Object.hasOwn(retryCalls, 1))
        throw new Error("expected an explicit retry");
      expect(retryCalls[1].input).toMatchObject({
        chatId: firstInput.chatId,
        initialMessage: {
          messageId: firstInput.initialMessage?.messageId,
          clientActionId: firstInput.initialMessage?.clientActionId,
        },
      });
      await waitFor(() => {
        expect(
          usePendingSandboxSendStore.getState().sends[SEND_ID]?.delivery,
        ).toMatchObject({ hostId: SANDBOX_HOST, sandboxId: SANDBOX_ID });
      });
    },
  );
});

describe("a send that named no model, ready on its sandbox", () => {
  it("reads the host's default model with a live subscription and sends with it, once", async () => {
    seed({
      ...SEEDED,
      send: { settings: { ...PICKED_SETTINGS, model: "" } },
    });
    mocks.modelsByHost.set(SANDBOX_HOST, [
      { slug: "host-default-model" },
      { slug: "another-model" },
    ]);
    answerHost(SANDBOX_HOST, CODEX_READY);
    mount();

    await waitForCreateChats(1);
    const calls = createChatCalls();
    if (!Object.hasOwn(calls, 0)) throw new Error("expected a chat create");
    const call = calls[0];
    expect(call.input.settings?.model).toBe("host-default-model");
    expect(call.input.initialMessage?.settings.model).toBe(
      "host-default-model",
    );
    expect(
      mocks.modelReads.some(
        (read) =>
          read.hostId === SANDBOX_HOST && read.enabled && read.subscribed,
      ),
    ).toBe(true);
  });

  it("reaches Not sent with Retry when the destination lists no model at all, instead of waiting forever, and sends with the default once one is listed", async () => {
    seed({
      ...SEEDED,
      send: { settings: { ...PICKED_SETTINGS, model: "" } },
    });
    mocks.modelsByHost.set(SANDBOX_HOST, []);
    answerHost(SANDBOX_HOST, CODEX_READY);
    mount();

    await waitFor(() => {
      expect(readStagedSandbox(SURFACE)?.failure).toEqual({ kind: "not-sent" });
    });
    expect(createChatCalls()).toEqual([]);
    const retry = within(screen.getByTestId("sandbox-refusal-line")).getByRole(
      "button",
      { name: "Retry" },
    );

    mocks.modelsByHost.set(SANDBOX_HOST, [{ slug: "host-default-model" }]);
    fireEvent.click(retry);

    await waitForCreateChats(1);
    const calls = createChatCalls();
    if (!Object.hasOwn(calls, 0)) throw new Error("expected a chat create");
    expect(calls[0].input.settings?.model).toBe("host-default-model");
    expect(calls[0].input.initialMessage?.settings.model).toBe(
      "host-default-model",
    );
  });

  it("still sends with the cached default model when a refresh of the catalog failed", async () => {
    seed({
      ...SEEDED,
      send: { settings: { ...PICKED_SETTINGS, model: "" } },
    });
    mocks.modelsByHost.set(SANDBOX_HOST, [{ slug: "cached-default-model" }]);
    mocks.modelReadErrorHosts.add(SANDBOX_HOST);
    answerHost(SANDBOX_HOST, CODEX_READY);
    mount();

    await waitForCreateChats(1);
    const calls = createChatCalls();
    if (!Object.hasOwn(calls, 0)) throw new Error("expected a chat create");
    expect(calls[0].input.settings?.model).toBe("cached-default-model");
    expect(calls[0].input.initialMessage?.settings.model).toBe(
      "cached-default-model",
    );
    expect(readStagedSandbox(SURFACE)?.failure ?? null).toBeNull();
  });

  it("reaches Not sent with Retry when the first catalog read failed and there is no cached model", async () => {
    seed({
      ...SEEDED,
      send: { settings: { ...PICKED_SETTINGS, model: "" } },
    });
    mocks.modelReadErrorHosts.add(SANDBOX_HOST);
    answerHost(SANDBOX_HOST, CODEX_READY);
    mount();

    await waitFor(() => {
      expect(readStagedSandbox(SURFACE)?.failure).toEqual({ kind: "not-sent" });
    });
    expect(createChatCalls()).toEqual([]);
    expect(
      within(screen.getByTestId("sandbox-refusal-line")).getByRole("button", {
        name: "Retry",
      }),
    ).toBeDefined();
  });

  it("reads no model and sends the saved one when the send named its model", async () => {
    seed(SEEDED);
    mocks.modelsByHost.set(SANDBOX_HOST, [{ slug: "host-default-model" }]);
    answerHost(SANDBOX_HOST, CODEX_READY);
    mount();

    await waitForCreateChats(1);
    expect(createChatCalls()[0]?.input.settings?.model).toBe(
      PICKED_SETTINGS.model,
    );
    expect(mocks.modelReads.every((read) => read.hostId === null)).toBe(true);
  });
});

describe("an unclaimed send at its handoff whose sandbox is frozen or unconfigured", () => {
  const FRESH = Date.now() + 60_000;
  const BLOCKERS = [
    ["frozen", { frozen: true }, /credits/i],
    ["unconfigured", { guestConfigured: false }, /retry applying/i],
  ] as const;

  it.each(
    (["chat", "fork"] as const).flatMap((kind) =>
      BLOCKERS.map(
        ([label, row, remedy]) => [kind, label, row, remedy] as const,
      ),
    ),
  )(
    "shows the %s send's %s remedy, keeps the message, sends and wakes nothing, then resumes once when repaired",
    async (kind, label, row, remedy) => {
      seed({
        ...SEEDED,
        send: kind === "fork" ? { request: FORK_REQUEST } : {},
        phase: "handoff",
        created: true,
      });
      answerSandboxRows(
        [
          sandboxSummaryFixture({
            id: SANDBOX_ID,
            hostId: SANDBOX_HOST,
            state: "awake",
            ...row,
          }),
        ],
        FRESH,
      );
      answerHost(SANDBOX_HOST, CODEX_READY);
      mount();

      await waitFor(() => {
        expect(screen.getByTestId("pending-sandbox-sends").textContent).toMatch(
          remedy,
        );
      });
      if (label === "unconfigured") {
        expect(
          screen.getByTestId("sandbox-setup-retry-applying"),
        ).toBeDefined();
      }
      if (kind === "chat") {
        expect(screen.getByTestId("pending-sandbox-message").textContent).toBe(
          "fix the login bug",
        );
      }
      expect(createChatCalls()).toEqual([]);
      expect(mocks.wake).not.toHaveBeenCalled();
      expect(mocks.createSandbox).not.toHaveBeenCalled();
      expect(
        usePendingSandboxSendStore.getState().sends[SEND_ID],
      ).toBeDefined();

      // Repaired: a fresh awake row without the blocker resumes it, once.
      answerSandboxRows(
        [
          sandboxSummaryFixture({
            id: SANDBOX_ID,
            hostId: SANDBOX_HOST,
            state: "awake",
          }),
        ],
        FRESH + 1,
      );
      await waitForCreateChats(1);
      expect(createChatCalls()).toHaveLength(1);
      expect(mocks.wake).not.toHaveBeenCalled();
    },
  );
  it.each(BLOCKERS)(
    "keeps a terminal ask's %s remedy, opens and wakes nothing, then opens exactly one tile and ends when repaired",
    async (label, row, remedy) => {
      seed({
        ...SEEDED,
        send: { request: { kind: "terminal" }, text: "" },
        phase: "handoff",
        created: true,
      });
      answerSandboxRows(
        [
          sandboxSummaryFixture({
            id: SANDBOX_ID,
            hostId: SANDBOX_HOST,
            state: "awake",
            ...row,
          }),
        ],
        FRESH,
      );
      mount();

      await waitFor(() => {
        expect(screen.getByTestId("pending-sandbox-sends").textContent).toMatch(
          remedy,
        );
      });
      if (label === "unconfigured") {
        expect(
          screen.getByTestId("sandbox-setup-retry-applying"),
        ).toBeDefined();
      }
      expect(mocks.openTile).not.toHaveBeenCalled();
      expect(mocks.wake).not.toHaveBeenCalled();
      expect(mocks.createSandbox).not.toHaveBeenCalled();
      expect(createChatCalls()).toEqual([]);
      expect(
        usePendingSandboxSendStore.getState().sends[SEND_ID],
      ).toBeDefined();

      // Repaired: a fresh awake row without the blocker opens it, once.
      answerSandboxRows(
        [
          sandboxSummaryFixture({
            id: SANDBOX_ID,
            hostId: SANDBOX_HOST,
            state: "awake",
            guestConfigured: true,
          }),
        ],
        FRESH + 1,
      );
      await waitFor(() => {
        expect(mocks.openTile).toHaveBeenCalledTimes(1);
      });
      await waitFor(() => {
        expect(usePendingSandboxSendStore.getState().sends).toEqual({});
      });
      expect(mocks.openTile).toHaveBeenCalledTimes(1);
      expect(createChatCalls()).toEqual([]);
    },
  );
});

describe("a send whose stored record says its sandbox ended while local memory still waits", () => {
  it.each(["chat", "fork"] as const)(
    "sends no %s create, keeps the stored ending, and recovers it after a delayed storage write with no event",
    async (kind) => {
      seed({
        ...SEEDED,
        send: kind === "fork" ? { request: FORK_REQUEST } : {},
        phase: "handoff",
        created: true,
      });
      // Another window ended it: the record key changes, no storage event fires.
      const key = recordMapStorageKey(
        persistKey(STORE_KEYS.pendingSandboxSend),
        SEND_ID,
      );
      const raw = localStorage.getItem(key);
      if (raw === null) throw new Error("expected the persisted send");
      const ended = { ...sendOf(raw), dispatch: null, ended: true };
      localStorage.setItem(key, JSON.stringify(ended));
      answerHost(SANDBOX_HOST, CODEX_READY);
      mount();

      await waitFor(() => {
        expect(usePendingSandboxSendStore.getState().sends).toEqual({});
      });
      expectSendRecovered(kind);
      const after = localStorage.getItem(key);
      // Removed once recovered; never rewritten as a live record.
      expect(
        after === null || after === "null" || sendOf(after).ended === true,
      ).toBe(true);
    },
  );
});

describe("a durable dispatch claim and its sandbox's lifecycle", () => {
  const FRESH = Date.now() + 60_000;
  const KINDS = ["chat", "fork"] as const;
  type Kind = (typeof KINDS)[number];
  const RESTING = ["suspended", "stopped"] as const;
  const GONE = ["failed", "destroying", "destroyed", "gone"] as const;
  const byKind = <T,>(values: ReadonlyArray<T>) =>
    KINDS.flatMap((kind) => values.map((value) => [kind, value] as const));

  function rowIn(
    state:
      | "suspended"
      | "stopped"
      | "awake"
      | "failed"
      | "destroying"
      | "destroyed",
  ): SandboxSummary {
    return sandboxSummaryFixture({
      id: SANDBOX_ID,
      hostId: SANDBOX_HOST,
      state,
    });
  }

  /** The same sandbox id, reported by a different host: not this claim's sandbox. */
  function rowOn(state: "awake" | "destroyed"): SandboxSummary {
    return sandboxSummaryFixture({
      id: SANDBOX_ID,
      hostId: "another-host",
      state,
    });
  }

  function claimInput(kind: Kind): PendingSandboxSendDispatch["input"] {
    const common = {
      epicId: "epic-1",
      hostId: SANDBOX_HOST,
      parentId: null,
      chatId: `saved-${kind}-chat-id`,
      workspaceMode: "folderless" as const,
      worktreeIntent: null,
      settings: PICKED_SETTINGS,
    };
    if (kind === "fork") {
      return {
        ...common,
        title: FORK_REQUEST.title,
        initialMessage: null,
        forkSource: FORK_REQUEST.forkSource,
      };
    }
    return {
      ...common,
      title: "",
      initialMessage: {
        messageId: "saved-message-id",
        clientActionId: "saved-action-id",
        content: MESSAGE_CONTENT,
        sender: { type: "user", userId: "user-1" },
        settings: PICKED_SETTINGS,
        accountContext: { type: "PERSONAL" },
        sentFromHostId: null,
      },
    };
  }

  /** A claim as a reload finds it: its exact request saved, its stage gone. */
  async function seedClaim(
    kind: Kind,
    status: PendingSandboxSendDispatch["status"],
    sandboxId: string,
  ): Promise<PendingSandboxSendDispatch["input"]> {
    const input = claimInput(kind);
    usePendingSandboxSendStore.getState().add(
      pendingSend({
        id: SEND_ID,
        request:
          kind === "fork"
            ? FORK_REQUEST
            : { kind: "chat", parentId: null, placement: null },
        dispatch: {
          input,
          status,
          delivery: {
            chatId: input.chatId,
            hostId: SANDBOX_HOST,
            sandboxId,
            readySeconds: 24,
          },
        },
      }),
    );
    await reloadPendingSandboxStores();
    return input;
  }

  function rowsFor(state: (typeof GONE)[number]): SandboxSummary[] {
    return state === "gone" ? [] : [rowIn(state)];
  }

  /** The claim ends: a chat's message waits in a closed Draft, a fork just ends. */
  function expectClaimReleased(kind: Kind): void {
    expect(screen.queryByText("Creating agent…")).toBeNull();
    expect(mocks.wake).not.toHaveBeenCalled();
    expectSendRecovered(kind);
  }

  async function waitForRelease(): Promise<void> {
    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
  }

  it.each(byKind(RESTING))(
    "wakes a %s sandbox for a saved %s claim whose stage is missing, before any create, then replays its exact input once awake",
    async (kind, state) => {
      const input = await seedClaim(kind, "sending", SANDBOX_ID);
      answerSandboxRows([rowIn(state)], FRESH);
      answerHost(SANDBOX_HOST, CODEX_READY);
      mount();

      await waitFor(() => {
        expect(mocks.wake).toHaveBeenCalledWith(SANDBOX_HOST, "send");
      });
      expect(createChatCalls()).toEqual([]);

      answerSandboxRows([rowIn("awake")], FRESH + 1);
      await waitForCreateChats(1);
      expect(createChatCalls()[0]?.input).toEqual(input);
      expect(mocks.wake).toHaveBeenCalledTimes(1);
    },
  );

  it.each(byKind(RESTING))(
    "wakes a %s sandbox when Retry replays an uncertain %s claim, and only then repeats its exact input",
    async (kind, state) => {
      const input = await seedClaim(kind, "uncertain", SANDBOX_ID);
      answerSandboxRows([rowIn(state)], FRESH);
      answerHost(SANDBOX_HOST, CODEX_READY);
      mount();

      const retry = await screen.findByTestId("pending-sandbox-dispatch-retry");
      expect(mocks.wake).not.toHaveBeenCalled();
      expect(createChatCalls()).toEqual([]);
      fireEvent.click(retry);
      await waitFor(() => {
        expect(mocks.wake).toHaveBeenCalledWith(SANDBOX_HOST, "send");
      });
      expect(createChatCalls()).toEqual([]);

      answerSandboxRows([rowIn("awake")], FRESH + 1);
      await waitForCreateChats(1);
      expect(createChatCalls()[0]?.input).toEqual(input);
    },
  );

  it.each(byKind(GONE))(
    "resolves a sending %s claim into a closed Draft or an ended fork when its sandbox is %s, with no client to send on",
    async (kind, state) => {
      await seedClaim(kind, "sending", SANDBOX_ID);
      mocks.nullClientHosts.add(SANDBOX_HOST);
      answerSandboxRows(rowsFor(state), FRESH);
      mount();

      await waitForRelease();
      expectClaimReleased(kind);
    },
  );

  it.each(KINDS)(
    "resolves an uncertain %s claim into a closed Draft or an ended fork once its sandbox is destroyed",
    async (kind) => {
      await seedClaim(kind, "uncertain", SANDBOX_ID);
      mocks.nullClientHosts.add(SANDBOX_HOST);
      answerSandboxRows([rowIn("destroyed")], FRESH);
      mount();

      await waitForRelease();
      expectClaimReleased(kind);
    },
  );

  it.each(
    byKind([
      "no row",
      "a stale suspended row",
      "a stale destroyed row",
    ] as const),
  )(
    "keeps a saved %s claim untouched while the list shows %s, and replays it once only on the first fresh awake row",
    async (kind, staleProjection) => {
      const input = await seedClaim(kind, "sending", SANDBOX_ID);
      answerSandboxRows(
        staleProjection === "no row"
          ? []
          : [
              rowIn(
                staleProjection === "a stale suspended row"
                  ? "suspended"
                  : "destroyed",
              ),
            ],
        0,
      );
      answerHost(SANDBOX_HOST, CODEX_READY);
      mount();
      await act(async () => {
        await Promise.resolve();
      });

      expect(createChatCalls()).toEqual([]);
      expect(mocks.wake).not.toHaveBeenCalled();
      const sends = usePendingSandboxSendStore.getState().sends;
      expect(sends[SEND_ID].dispatch).toMatchObject({ input });

      answerSandboxRows([rowIn("awake")], FRESH);
      await waitForCreateChats(1);
      expect(createChatCalls()[0]?.input).toEqual(input);
      expect(mocks.wake).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["an awake row", [rowIn("awake")], FRESH],
    ["a list not read since mount", [], 0],
  ] as const)(
    "turns a claim with no client and %s into an uncertain claim with Retry, never a release, and sends only on an explicit Retry once the client is back",
    async (_label, rows, readAt) => {
      const input = await seedClaim("chat", "sending", SANDBOX_ID);
      mocks.nullClientHosts.add(SANDBOX_HOST);
      answerSandboxRows([...rows], readAt);
      const view = mount();
      await screen.findByTestId("pending-sandbox-dispatch-retry");

      expect(createChatCalls()).toEqual([]);
      expect(mocks.wake).not.toHaveBeenCalled();
      expect(
        usePendingSandboxSendStore.getState().sends[SEND_ID].dispatch,
      ).toMatchObject({ input, status: "uncertain" });
      expect(useLandingDraftStore.getState().drafts).toEqual([]);
      expect(useNewConversationModalOpenStore.getState().request).toBeNull();

      view.unmount();
      mocks.nullClientHosts.clear();
      answerSandboxRows([rowIn("awake")], FRESH);
      answerHost(SANDBOX_HOST, CODEX_READY);
      mount();
      const retry = await screen.findByTestId("pending-sandbox-dispatch-retry");
      expect(createChatCalls()).toEqual([]);
      fireEvent.click(retry);
      await waitForCreateChats(1);
      expect(createChatCalls()[0]?.input).toEqual(input);
    },
  );

  it.each(
    KINDS.flatMap((kind) =>
      [
        { label: "frozen", row: { frozen: true }, remedy: /credits/i },
        {
          label: "unconfigured",
          row: { guestConfigured: false },
          remedy: /repair/i,
        },
      ].map((variant) => [kind, variant.label, variant] as const),
    ),
  )(
    "keeps a %s claim on a %s awake sandbox with its remedy and Retry, and wakes and sends nothing",
    async (kind, _label, variant) => {
      const input = await seedClaim(kind, "sending", SANDBOX_ID);
      answerSandboxRows(
        [
          sandboxSummaryFixture({
            id: SANDBOX_ID,
            hostId: SANDBOX_HOST,
            state: "awake",
            ...variant.row,
          }),
        ],
        FRESH,
      );
      mocks.nullClientHosts.add(SANDBOX_HOST);
      mount();
      await screen.findByTestId("pending-sandbox-dispatch-retry");

      expect(screen.getByTestId("pending-sandbox-sends").textContent).toMatch(
        variant.remedy,
      );
      expect(mocks.wake).not.toHaveBeenCalled();
      expect(createChatCalls()).toEqual([]);
      expect(
        usePendingSandboxSendStore.getState().sends[SEND_ID].dispatch,
      ).toMatchObject({ input, status: "sending" });
      expect(useLandingDraftStore.getState().drafts).toEqual([]);
    },
  );

  it.each(
    byKind([
      ["an empty sandbox id", "", []],
      ["another host's awake row", SANDBOX_ID, [rowOn("awake")]],
      ["another host's destroyed row", SANDBOX_ID, [rowOn("destroyed")]],
    ] as const),
  )(
    "keeps a saved %s claim, sending and releasing nothing, when its sandbox is identified by %s",
    async (kind, [, sandboxId, rows]) => {
      const input = await seedClaim(kind, "sending", sandboxId);
      answerSandboxRows([...rows], FRESH);
      answerHost(SANDBOX_HOST, CODEX_READY);
      mount();
      await act(async () => {
        await Promise.resolve();
      });

      expect(createChatCalls()).toEqual([]);
      expect(mocks.wake).not.toHaveBeenCalled();
      expect(
        usePendingSandboxSendStore.getState().sends[SEND_ID].dispatch,
      ).toMatchObject({ input });
      expect(useLandingDraftStore.getState().drafts).toEqual([]);
    },
  );

  describe("when the account changes", () => {
    function switchToOtherAccount(): void {
      act(() => {
        useAuthStore.getState().setSignedOut();
        useAuthStore
          .getState()
          .setSignedIn(
            { userId: "user-2", userName: "V", email: "v@example.com" },
            { userId: "user-2", username: "V" },
            [],
          );
      });
    }

    it.each(KINDS)(
      "lets only the owner of a %s claim wake its resting sandbox",
      async (kind) => {
        const input = await seedClaim(kind, "sending", SANDBOX_ID);
        answerSandboxRows([rowIn("suspended")], FRESH);
        answerHost(SANDBOX_HOST, CODEX_READY);
        switchToOtherAccount();
        const view = mount();
        await act(async () => {
          await Promise.resolve();
        });

        expect(mocks.wake).not.toHaveBeenCalled();
        expect(createChatCalls()).toEqual([]);
        expect(screen.queryByTestId("pending-sandbox-sends")).toBeNull();

        view.unmount();
        act(() => {
          useAuthStore.getState().setSignedOut();
        });
        userSignedIn();
        mount();
        await waitFor(() => {
          expect(mocks.wake).toHaveBeenCalledWith(SANDBOX_HOST, "send");
        });
        expect(createChatCalls()).toEqual([]);
        expect(
          usePendingSandboxSendStore.getState().sends[SEND_ID].dispatch,
        ).toMatchObject({ input });
      },
    );

    it.each(KINDS)(
      "lets another account's fresh list missing the sandbox release nothing, and releases the %s claim to its owner when they return",
      async (kind) => {
        await seedClaim(kind, "sending", SANDBOX_ID);
        mocks.nullClientHosts.add(SANDBOX_HOST);
        answerSandboxRows([], FRESH);
        switchToOtherAccount();
        const view = mount();
        await act(async () => {
          await Promise.resolve();
        });

        expect(
          usePendingSandboxSendStore.getState().sends[SEND_ID].dispatch,
        ).not.toBeNull();
        expect(mocks.wake).not.toHaveBeenCalled();
        expect(createChatCalls()).toEqual([]);
        expect(useLandingDraftStore.getState().drafts).toEqual([]);

        view.unmount();
        act(() => {
          useAuthStore.getState().setSignedOut();
        });
        userSignedIn();
        answerSandboxRows([], FRESH + 1);
        mount();
        await waitForRelease();
        expectClaimReleased(kind);
      },
    );

    it.each(KINDS)(
      "gives a %s claim back for its owner only, never from another account's window",
      async (kind) => {
        await seedClaim(kind, "sending", SANDBOX_ID);
        mocks.nullClientHosts.add(SANDBOX_HOST);
        answerSandboxRows([rowIn("destroyed")], FRESH);
        switchToOtherAccount();
        mount();
        await act(async () => {
          await Promise.resolve();
        });

        expect(
          usePendingSandboxSendStore.getState().sends[SEND_ID].dispatch,
        ).not.toBeNull();
        expect(useNewConversationModalOpenStore.getState().request).toBeNull();
        expect(mocks.openTile).not.toHaveBeenCalled();
        expect(
          useNewConversationModalStore.getState().draftPatchesByEpicId[
            "epic-1"
          ],
        ).toBeUndefined();
      },
    );

    it.each(KINDS)(
      "keeps an uncertain %s claim on a live awake host as it was: no withdrawal, no new create until Retry",
      async (kind) => {
        await seedClaim(kind, "uncertain", SANDBOX_ID);
        answerSandboxRows([rowIn("awake")], FRESH);
        answerHost(SANDBOX_HOST, CODEX_READY);
        mount();

        const line = await screen.findByTestId("pending-sandbox-dispatch");
        expect(line.textContent).toContain(
          "Couldn't confirm the agent was created.",
        );
        answerSandboxRows([rowIn("awake")], FRESH + 1);
        expect(createChatCalls()).toEqual([]);
        expect(mocks.wake).not.toHaveBeenCalled();
        expect(
          usePendingSandboxSendStore.getState().sends[SEND_ID].dispatch,
        ).toMatchObject({ status: "uncertain" });
        expect(useNewConversationModalOpenStore.getState().request).toBeNull();
      },
    );
  });
});

describe("a task deleted while its message waits on a sandbox", () => {
  const KINDS = ["chat", "fork"] as const;
  const STATES = ["waiting", "sending", "uncertain"] as const;
  type Kind = (typeof KINDS)[number];
  type State = (typeof STATES)[number];
  /** A create the test holds open; released after each case so none outlives its page. */
  let heldCreate: Deferred<CreateChatResponseV12> | null = null;
  afterEach(async () => {
    const held = heldCreate;
    heldCreate = null;
    if (held !== null) await resolvePendingCreate(held);
  });
  const cases = KINDS.flatMap((kind) =>
    STATES.map((state) => [kind, state] as const),
  );

  function chatInput(kind: Kind): PendingSandboxSendDispatch["input"] {
    const common = {
      epicId: "epic-1",
      hostId: SANDBOX_HOST,
      parentId: null,
      chatId: `saved-${kind}-chat-id`,
      workspaceMode: "folderless" as const,
      worktreeIntent: null,
      settings: PICKED_SETTINGS,
    };
    if (kind === "fork") {
      return {
        ...common,
        title: FORK_REQUEST.title,
        initialMessage: null,
        forkSource: FORK_REQUEST.forkSource,
      };
    }
    return {
      ...common,
      title: "",
      initialMessage: {
        messageId: "saved-message-id",
        clientActionId: "saved-action-id",
        content: MESSAGE_CONTENT,
        sender: { type: "user", userId: "user-1" },
        settings: PICKED_SETTINGS,
        accountContext: { type: "PERSONAL" },
        sentFromHostId: null,
      },
    };
  }

  /** Leaves the send in `state` on a mounted page; a sending claim holds its create open. */
  async function arrange(
    kind: Kind,
    state: State,
  ): Promise<Deferred<CreateChatResponseV12> | null> {
    if (state === "waiting") {
      seed({
        ...SEEDED,
        send: kind === "fork" ? { request: FORK_REQUEST } : {},
      });
      mount();
      await screen.findByTestId("pending-sandbox-sends");
      return null;
    }
    const input = chatInput(kind);
    usePendingSandboxSendStore.getState().add(
      pendingSend({
        id: SEND_ID,
        request:
          kind === "fork"
            ? FORK_REQUEST
            : { kind: "chat", parentId: null, placement: null },
        dispatch: {
          input,
          status: state === "sending" ? "sending" : "uncertain",
          delivery: {
            chatId: input.chatId,
            hostId: SANDBOX_HOST,
            sandboxId: SANDBOX_ID,
            readySeconds: 24,
          },
        },
      }),
    );
    await reloadPendingSandboxStores();
    answerSandboxRows(
      [
        sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: SANDBOX_HOST,
          state: "awake",
        }),
      ],
      Date.now() + 60_000,
    );
    answerHost(SANDBOX_HOST, CODEX_READY);
    if (state === "uncertain") {
      mount();
      await screen.findByTestId("pending-sandbox-dispatch-retry");
      return null;
    }
    const create = deferred<CreateChatResponseV12>();
    mocks.createChatDeferred = create.promise;
    heldCreate = create;
    mount();
    await waitForCreateChats(1);
    return create;
  }

  function loseEpic(epicIds: string[], userId: string | null): void {
    act(() => {
      tabCommandCoordinator.handleEpicAccessLoss(epicIds, userId);
    });
  }

  function expectRecoveredDraftOnly(kind: Kind): void {
    expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    expect(readStagedSandbox(SURFACE)).toBeNull();
    expect(mocks.openTile).not.toHaveBeenCalled();
    const { drafts } = useLandingDraftStore.getState();
    if (kind === "chat") {
      expect(drafts).toHaveLength(1);
      expect(drafts[0]).toMatchObject({
        content: MESSAGE_CONTENT,
        closed: true,
      });
    } else {
      expect(drafts).toEqual([]);
    }
  }

  it.each(cases)(
    "recovers a %s send that is %s into a closed Draft or an ended fork when its original account loses the task",
    async (kind, state) => {
      await arrange(kind, state);
      loseEpic(["epic-1"], "user-1");

      await waitFor(() => {
        expect(usePendingSandboxSendStore.getState().sends).toEqual({});
      });
      expectRecoveredDraftOnly(kind);
    },
  );

  it.each(cases)(
    "leaves a %s send that is %s alone when another account loses the task",
    async (kind, state) => {
      await arrange(kind, state);
      loseEpic(["epic-1"], "user-2");

      expect(
        usePendingSandboxSendStore.getState().sends[SEND_ID],
      ).toBeDefined();
      expect(useLandingDraftStore.getState().drafts).toEqual([]);
    },
  );

  it.each(cases)(
    "leaves a %s send that is %s alone when a different task is lost",
    async (kind, state) => {
      await arrange(kind, state);
      loseEpic(["epic-2"], "user-1");

      expect(
        usePendingSandboxSendStore.getState().sends[SEND_ID],
      ).toBeDefined();
      expect(useLandingDraftStore.getState().drafts).toEqual([]);
    },
  );

  it.each(KINDS)(
    "recovers a stale unclaimed %s send whose stored record already holds a dispatch claim, with no event and no create",
    async (kind) => {
      seed({
        ...SEEDED,
        send: kind === "fork" ? { request: FORK_REQUEST } : {},
      });
      // Another window claimed it: the record key changes, no storage event fires.
      const key = recordMapStorageKey(
        persistKey(STORE_KEYS.pendingSandboxSend),
        SEND_ID,
      );
      const raw = localStorage.getItem(key);
      if (raw === null) throw new Error("expected the persisted send");
      const input = chatInput(kind);
      localStorage.setItem(
        key,
        JSON.stringify({
          ...sendOf(raw),
          dispatch: {
            input,
            status: "sending",
            delivery: {
              chatId: input.chatId,
              hostId: SANDBOX_HOST,
              sandboxId: SANDBOX_ID,
              readySeconds: 24,
            },
          },
        }),
      );

      loseEpic(["epic-1"], "user-1");

      await waitFor(() => {
        expect(usePendingSandboxSendStore.getState().sends).toEqual({});
      });
      expectSendRecovered(kind);
    },
  );

  it.each(KINDS)(
    "does not resurrect a %s send when the host accepts its create after the task was lost",
    async (kind) => {
      const create = await arrange(kind, "sending");
      loseEpic(["epic-1"], "user-1");
      await waitFor(() => {
        expect(usePendingSandboxSendStore.getState().sends).toEqual({});
      });
      const draftsBefore = useLandingDraftStore.getState().drafts;

      await act(async () => {
        create?.resolve({ chatId: `saved-${kind}-chat-id` });
        await create?.promise;
      });

      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
      expect(readStagedSandbox(SURFACE)).toBeNull();
      expect(mocks.openTile).not.toHaveBeenCalled();
      expect(useLandingDraftStore.getState().drafts).toEqual(draftsBefore);
      expect(createChatCalls()).toHaveLength(1);
    },
  );
});

describe("the ready line above an agent whose first message waited", () => {
  function delivered(): PendingSandboxSend {
    return pendingSend({
      id: SEND_ID,
      delivery: {
        chatId: "chat-1",
        hostId: SANDBOX_HOST,
        sandboxId: SANDBOX_ID,
        readySeconds: 24,
      },
    });
  }

  it("reads the sandbox's name and seconds to ready, and opens to the idle rule with the sandbox's own period", () => {
    usePendingSandboxSendStore.getState().add(delivered());
    mocks.sandboxes = [
      sandboxSummaryFixture({
        id: SANDBOX_ID,
        hostId: SANDBOX_HOST,
        displayName: "e2e-sbx-p1",
        idleMinutes: 45,
      }),
    ];
    render(<SandboxReadyLineForChat chatId="chat-1" />);

    expect(screen.getByTestId("sandbox-ready-line-toggle").textContent).toBe(
      "Sandbox ready·e2e-sbx-p1·24 s",
    );

    fireEvent.click(screen.getByTestId("sandbox-ready-line-toggle"));

    expect(screen.getByTestId("sandbox-ready-line-detail").textContent).toBe(
      "After 45 minutes with no agent turn, running shell or attached tab, this sandbox suspends. Closing this tab does not stop running work or immediately stop charges; storage is charged while it rests.",
    );
  });

  it("shows nothing above an agent that was not a waiting send's", () => {
    usePendingSandboxSendStore.getState().add(delivered());

    render(<SandboxReadyLineForChat chatId="chat-other" />);

    expect(screen.queryByTestId("sandbox-ready-line")).toBeNull();
  });
});

/** Every key at any depth of a parsed JSON value. */
function flattenKeys(value: unknown): Record<string, true> {
  const keys: Record<string, true> = {};
  const visit = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return;
    for (const [key, child] of Object.entries(node)) {
      keys[key] = true;
      visit(child);
    }
  };
  visit(value);
  return keys;
}

/** The one send in its own persisted record. */
function sendOf(json: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("unexpected persisted shape");
  }
  return Object.fromEntries(Object.entries(parsed));
}

function snapshotRecordMapStorage(
  name: string,
): ReadonlyArray<readonly [string, string]> {
  const prefix = recordMapStoragePrefix(name);
  const entries: Array<readonly [string, string]> = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key === null || (key !== name && !key.startsWith(prefix))) continue;
    const value = localStorage.getItem(key);
    if (value !== null) entries.push([key, value]);
  }
  return entries;
}

function restoreRecordMapStorage(
  name: string,
  entries: ReadonlyArray<readonly [string, string]>,
): void {
  const prefix = recordMapStoragePrefix(name);
  const keys: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key === name || (key !== null && key.startsWith(prefix)))
      keys.push(key);
  }
  for (const key of keys) localStorage.removeItem(key);
  for (const [key, value] of entries) localStorage.setItem(key, value);
}

/** Rehydrates the two pending-send stores the way a new window does. */
async function reloadPendingSandboxStores(): Promise<void> {
  const staged = snapshotRecordMapStorage(
    persistKey(STORE_KEYS.stagedSandboxSend),
  );
  const sends = snapshotRecordMapStorage(
    persistKey(STORE_KEYS.pendingSandboxSend),
  );
  cleanup();
  useStagedSandboxStore.setState({ bySurface: {} });
  usePendingSandboxSendStore.setState({ sends: {} });
  restoreRecordMapStorage(persistKey(STORE_KEYS.stagedSandboxSend), staged);
  restoreRecordMapStorage(persistKey(STORE_KEYS.pendingSandboxSend), sends);
  await useStagedSandboxStore.persist.rehydrate();
  await usePendingSandboxSendStore.persist.rehydrate();
}

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
    if (hostId === null) return null;
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
  useGuiHarnessModelsQueryForClient: () => ({ data: undefined }),
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
  mocks.sandboxes = [];
  mocks.listReadAt = 0;
  mocks.refetchSandboxes.mockReset();
  mocks.refetchSandboxes.mockResolvedValue(undefined);
  mocks.wire.length = 0;
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

  it("refuses a Personal send whose agent cannot run there with the sign-in sentence, uses no other agent, and opens Personal's Providers", () => {
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

    const line = screen.getByTestId("sandbox-refusal-line");
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

    it("refuses with the team's sentence and opens that team's own Providers, by its environment", () => {
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

      const line = screen.getByTestId("sandbox-refusal-line");
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

    it("offers no Providers link when the team's environment is not among the account's", () => {
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

      const line = screen.getByTestId("sandbox-refusal-line");
      expect(
        within(line).queryByRole("button", { name: "Open Acme's Providers" }),
      ).toBeNull();
    });
  });

  it("refuses an agent whose install failed with the host's sentence, offers Open terminal instead and no sign-in, and opens a terminal on the sandbox", () => {
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

    const line = screen.getByTestId("sandbox-refusal-line");
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

  it("settles to the failure in place with Choose another host when the sandbox failed, and never delivers", async () => {
    const restoreLocks = installImmediateExclusiveLocks();
    try {
      seed({ ...SEEDED, phase: "creating", created: true });
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
      const view = mount();

      await waitFor(() => {
        expect(readStagedSandbox(SURFACE)?.failure).toMatchObject({
          kind: "failed",
        });
      });
      const line = screen.getByTestId("sandbox-setup-line");
      expect(
        within(line).getByRole("button", { name: "Choose another host" }),
      ).toBeDefined();
      expect(screen.getByTestId("pending-sandbox-message")).toBeDefined();

      // Nothing resumes it into delivery, however often it is mounted again.
      view.unmount();
      mount();
      await act(async () => {
        await Promise.resolve();
      });
      expect(createChatCalls()).toEqual([]);
      expect(mocks.createSandbox).not.toHaveBeenCalled();
    } finally {
      restoreLocks();
    }
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

  it("re-reads a sandbox gone while the record waited, follows the failure, and sends nothing into it", async () => {
    seed({ ...SEEDED, phase: "creating", created: true });
    // The list no longer holds the sandbox: it was destroyed in the gap.
    mocks.listSandboxes.mockResolvedValue(listAnswers([]));
    answerHost(SANDBOX_HOST, CODEX_READY);
    mount();

    await waitFor(() => {
      expect(readStagedSandbox(SURFACE)?.failure).toMatchObject({
        kind: "failed",
        code: "gone",
      });
    });
    expect(mocks.listSandboxes).toHaveBeenCalled();
    expect(createChatCalls()).toEqual([]);
  });
});

describe("a send at its handoff whose sandbox is gone", () => {
  const FRESH = Date.now() + 60_000;

  it("settles to the failure in place with Choose another host when a fresh read lacks the sandbox, and sends nothing", async () => {
    const restoreLocks = installImmediateExclusiveLocks();
    try {
      seed({ ...SEEDED, phase: "handoff", created: true });
      mocks.listReadAt = FRESH;
      mocks.sandboxes = [];
      // The destroyed sandbox's host never answers.
      mount();

      await waitFor(() => {
        expect(readStagedSandbox(SURFACE)?.failure).toMatchObject({
          kind: "failed",
          code: "gone",
          step: "delivering",
        });
      });
      const line = screen.getByTestId("sandbox-setup-line");
      expect(
        within(line).getByRole("button", { name: "Choose another host" }),
      ).toBeDefined();
      expect(createChatCalls()).toEqual([]);
    } finally {
      restoreLocks();
    }
  });

  it.each(["failed", "destroying", "destroyed"] as const)(
    "settles to the failure when the row is %s",
    async (state) => {
      seed({ ...SEEDED, phase: "handoff", created: true });
      mocks.listReadAt = FRESH;
      mocks.sandboxes = [
        sandboxSummaryFixture({ id: SANDBOX_ID, hostId: SANDBOX_HOST, state }),
      ];
      mount();

      await waitFor(() => {
        expect(readStagedSandbox(SURFACE)?.failure).not.toBeNull();
      });
      expect(createChatCalls()).toEqual([]);
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

  it("reads the list again on the poll tick while it waits for the agent", () => {
    vi.useFakeTimers();
    try {
      seed({ ...SEEDED, phase: "handoff", created: true });
      answerHost(SANDBOX_HOST, CODEX_DOWNLOADING);
      mount();
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

  it("fails the line in place when the sandbox it woke is reported failed, delivering nothing", async () => {
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
      expect(readStagedSandbox(SURFACE)?.failure).toMatchObject({
        kind: "failed",
      });
    });
    expect(createChatCalls()).toEqual([]);
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

  it("keeps the message's images rooted against the landing GC while it waits, and lets them go once it ends", () => {
    const hash = "c".repeat(64);
    seed({
      ...SEEDED,
      send: {
        content: {
          type: "doc",
          content: [
            {
              type: "imageAttachment",
              attrs: { id: "img-1", hash, mimeType: "image/png" },
            },
          ],
        },
      },
      phase: "creating",
      created: false,
    });

    expect(landingLiveImageRootHashes().has(hash)).toBe(true);

    // Delivered: the agent's chat holds the message now, not the send.
    usePendingSandboxSendStore.getState().markDelivered(SEND_ID, {
      chatId: "chat-1",
      hostId: SANDBOX_HOST,
      sandboxId: SANDBOX_ID,
      readySeconds: 24,
    });
    expect(landingLiveImageRootHashes().has(hash)).toBe(false);
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

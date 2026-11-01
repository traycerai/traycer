/**
 * A message sent to a staged sandbox waits in its task, behind the setup line,
 * until the agent the person asked for is ready on the sandbox.
 *
 * The driver, the strip, the stores and the staged run are the real ones. What
 * is faked is what lives outside the window: the control plane's create and
 * list, the account's host directory, and each host's `harnesses` and
 * `providers` answers, `epic.createChat` and the terminal create.
 */
import type { TaskHostRow } from "@traycer/protocol/host/task-host-summary";
import { useSyncExternalStore } from "react";
import { TabHostContext } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import {
  createMessageSessionHarness,
  type MessageSessionHarness,
} from "./message-session-harness";
import type { ReactNode } from "react";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ExternalToast } from "sonner";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import { putImage } from "@/lib/composer/landing-image-store";
import { resetDraftBlobTransportForTests } from "@/lib/drafts/draft-blob-transport";
import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
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
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import type { GuiHarnessOption } from "@traycer/protocol/host/index";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import type {
  SandboxCreateRequest,
  SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import type { SandboxWakeOutcome } from "@traycer-clients/shared/host-client/sandbox-control";
import type { SandboxVerbGesture } from "@traycer/protocol/host/sandbox-control";
import type { SandboxVerbOutcome } from "@/hooks/sandboxes/use-sandbox-verb-mutation";
import type { CreateChatResponseV12 } from "@traycer/protocol/host/epic/unary-schemas";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type {
  SandboxCreateFetchResult,
  SandboxListFetchResult,
} from "@traycer-clients/shared/host-client/sandbox-control";
import type { CreateChatMutationInput } from "@/hooks/epic/use-epic-chat-mutations";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import type {
  EpicStreamClientFactory,
  OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import { RunnerHostContext } from "@/providers/runner-host-context";
import { createFakeRunnerHost } from "../../../../__tests__/create-fake-runner-host";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import {
  MESSAGE_CONTENT,
  PICKED_SETTINGS,
  harnessRow,
  opencodeProviderRow,
  pendingSend,
  providerRow,
} from "@/lib/sandboxes/__tests__/pending-send-fixtures";
import {
  holdPendingSandboxSendOwnership,
  ownsPendingSandboxSend,
} from "@/lib/sandboxes/pending-sandbox-send-ownership";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import {
  endPendingSandboxSend,
  confirmPendingSandboxSendEpic,
  handPendingSandboxSend,
  returnPendingSandboxSend,
  returnPendingSandboxSendToSandbox,
  recoverPendingSandboxSendsAfterTaskLoss,
} from "@/lib/sandboxes/pending-sandbox-send";
import { useNewConversationReturnedSandbox } from "@/hooks/sandboxes/use-returned-sandbox-stage";
import { openNewChatDraftRow } from "@/lib/drafts/draft-inventory-actions";
import { takeReturnedSandboxRestored } from "@/lib/sandboxes/returned-sandbox";
import type { UseNavigateResult } from "@tanstack/react-router";
import { useAccountContextStore } from "@/stores/auth/account-context-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { PendingSandboxObservation } from "@/lib/sandboxes/pending-sandbox-observation";
import {
  readStagedSandbox,
  useStagedSandboxStore,
  type StagedSandbox,
  type StagedSandboxFailure,
  type StagedSandboxTarget,
} from "@/stores/composer/staged-sandbox-store";
import { useInitialChatHandoffStore } from "@/stores/epics/initial-chat-handoff-store";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import {
  emptyLandingDraftWorkspaceSnapshot,
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";
import { useLandingReturnedSandbox } from "@/hooks/sandboxes/use-returned-sandbox-stage";
import { landingLiveImageRootHashes } from "@/lib/composer/landing-image-budget";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";
import {
  pendingSendSurfaceKey,
  usePendingSandboxSendStore,
  type PendingSandboxSend,
  type PendingSandboxSendDispatch,
} from "@/stores/sandboxes/pending-sandbox-send-store";
import {
  recordCancelledSandboxSend,
  recordStoppedSandboxSend,
  useStoppedSandboxSendReceiptStore,
} from "@/stores/sandboxes/stopped-sandbox-send-receipt-store";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import {
  composerSurfaceKey,
  newConversationSurfaceKey,
  useSurfaceHostSelectionStore,
} from "@/stores/host/surface-host-selection-store";
import { persistKey, STORE_KEYS } from "@/lib/persist";
import { createRecordMapStorage } from "@/lib/persist/record-map-storage";
import {
  recordMapStorageKey,
  recordMapStoragePrefix,
} from "@/lib/persist/keys";
import {
  PendingSandboxSendForChat,
  PendingSandboxSendStrip,
  PendingSandboxSendsDriver,
  SandboxReadyLineForChat,
} from "../pending-sandbox-sends";
import { registerChatCloneOpener } from "@/lib/chats/chat-clone-registry";
import { registerActiveModelPicker } from "@/lib/commands/active-model-picker-registry";
import { StoppedSandboxSendReceiptStrip } from "../stopped-sandbox-send-receipts";
import { stagedRunActive } from "@/lib/sandboxes/staged-sandbox-run";
import { TileCanvas } from "@/components/epic-canvas/canvas/tile-canvas";
import type { SplitPaneComponentProps } from "@/components/epic-canvas/canvas/split-container";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  makeOpenableNodeRef,
  type EpicCanvasTileRef,
} from "@/stores/epics/canvas/types";
import { makeBlankTileRef } from "@/stores/epics/canvas/tile-schema/blank-tile";
import { PaneOpener } from "@/components/epic-canvas/canvas/pane-opener";
import type { KeybindingRouter } from "@/lib/keybindings/dispatch";
import {
  requestPaneOpenerFocus,
  resetPaneOpenerFocusForTests,
} from "@/lib/canvas/focus-pane-opener";

vi.mock("@dnd-kit/core", () => ({
  useDroppable: () => ({ setNodeRef: () => undefined }),
}));

vi.mock(
  "@/components/epic-canvas/snapshots/snapshot-loading-context-value",
  () => ({
    useSnapshotLoading: () => ({
      snapshotLoaded: true,
      snapshotFetchError: null,
    }),
  }),
);

vi.mock("@/lib/epic-selectors", () => ({
  useEpicHasArtifactRecords: () => false,
}));

vi.mock("@/lib/commands/registry", () => ({ getOpenerItems: () => [] }));
vi.mock("@/hooks/epic/use-epic-session-host-id", () => ({
  useEpicSessionHostId: () => SANDBOX_HOST,
}));
vi.mock("@/hooks/epic/use-deleted-artifacts-available", () => ({
  useDeletedArtifactsAvailable: () => false,
}));
vi.mock(
  "@/components/command-palette/command-palette-context",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/command-palette/command-palette-context")
      >();
    return {
      ...actual,
      useCommandPaletteRouter: (): KeybindingRouter => ({
        getPathname: () => "/",
        navigateHome: () => undefined,
        navigateSettings: () => undefined,
        navigateToEpic: () => undefined,
        navigateToEpicTab: () => undefined,
        navigateToEpicList: () => undefined,
        navigateSettingsSection: () => undefined,
        navigateToTabIntent: () => undefined,
        goBack: () => undefined,
        goForward: () => undefined,
        isHistoryNavAvailable: () => false,
        canGoBack: () => false,
        canGoForward: () => false,
      }),
    };
  },
);

// Keep the canvas, opener, pending strip and send lifecycle real; stand in
// for the pane's heavyweight chat presentation at the canvas boundary.
vi.mock("@/components/epic-canvas/canvas/tab-group-view", () => ({
  TabGroupView: (
    props: SplitPaneComponentProps & { epicId: string; tabId: string },
  ) => {
    const tile = useEpicCanvasStore((state) =>
      props.pane.activeTabId === null
        ? null
        : state.canvasByTabId[props.tabId]?.tilesByInstanceId[
            props.pane.activeTabId
          ],
    );
    return tile === null || tile?.type === "blank" ? (
      <PaneOpener
        epicId={props.epicId}
        tabId={props.tabId}
        groupId={props.pane.id}
        active
      />
    ) : (
      <div data-testid="canvas-chat">{tile?.id}</div>
    );
  },
}));

const toastSpies = vi.hoisted(() => {
  const dismissalQueue = {
    deferred: false,
    callbacks: [] as Array<() => void>,
  };
  // Sonner invokes onDismiss for programmatic dismissal as well as user close.
  const activeReceiptToasts = new Map<
    string | number,
    {
      readonly content: ReactNode;
      readonly options: ExternalToast | undefined;
    }
  >();
  const dismissToast = (id: string | number | undefined): void => {
    if (id === undefined) return;
    const active = activeReceiptToasts.get(id);
    if (active === undefined) return;
    activeReceiptToasts.delete(id);
    const onDismiss = active.options?.onDismiss;
    if (onDismiss === undefined) return;
    const notifyDismiss = (): void => {
      Reflect.apply(onDismiss, undefined, []);
    };
    if (dismissalQueue.deferred) dismissalQueue.callbacks.push(notifyDismiss);
    else notifyDismiss();
  };
  return {
    activeReceiptToasts,
    dismissalQueue,
    show: vi.fn<
      (message: ReactNode, options: ExternalToast | undefined) => string
    >((content, options) => {
      const id = options?.id;
      if (typeof id === "string" && id.startsWith("sandbox-stopped:"))
        activeReceiptToasts.set(id, { content, options });
      return typeof id === "string" || typeof id === "number"
        ? String(id)
        : "sandbox-stopped-toast";
    }),
    dismiss: vi.fn<(id: string | number | undefined) => void>(dismissToast),
    dismissByUser: vi.fn<(id: string | number) => void>(dismissToast),
  };
});

// The existing chat's session, handed to the message dispatch driver: a real
// session store over a fake stream (message-session-harness.ts), or none.
const sessionBridge = vi.hoisted(
  (): { handle: ChatSessionStoreHandle | null } => ({ handle: null }),
);
vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  useChatSessionHandleForContainer: () => sessionBridge.handle,
}));

// The unrecorded-prompt handoff, held open on request: the one place a Cancel
// of a message to an existing chat can stay "returning" long enough to read.
const handoffHold = vi.hoisted((): { held: Promise<void> | null } => ({
  held: null,
}));
vi.mock("@/lib/drafts/unrecorded-prompt-handoff", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("@/lib/drafts/unrecorded-prompt-handoff")
    >();
  return {
    ...original,
    buildUnrecordedPromptHandoff: async (
      args: Parameters<typeof original.buildUnrecordedPromptHandoff>[0],
    ) => {
      if (handoffHold.held !== null) await handoffHold.held;
      return original.buildUnrecordedPromptHandoff(args);
    },
  };
});

vi.mock("sonner", async (importOriginal) => {
  const original = await importOriginal<typeof import("sonner")>();
  return {
    ...original,
    toast: Object.assign(toastSpies.show, original.toast, {
      dismiss: toastSpies.dismiss,
    }),
  };
});

const SANDBOX_HOST = "sbx-host";
const SANDBOX_ID = "sbx-1";
const SEND_ID = "send-1";
const SURFACE = pendingSendSurfaceKey(SEND_ID);
const OCCUPIED_NEW_CHAT_CONTENT: JsonContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "keep my other draft" }],
    },
  ],
};
const NO_AGENT_SENTENCE = "Agents can't run on api-refactor.";

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
  /** The hosts the task lists; none unless a case names a sandbox. */
  taskHosts: [] as TaskHostRow[],
  /** What each host's `harnesses` and `providers` queries answer. */
  hostAnswers: new Map<string, unknown>(),
  answerListeners: new Set<() => void>(),
  answerVersion: 0,
  createChatCalls: [] as unknown[],
  createChatError: null as Error | null,
  createChatDeferred: null as Promise<CreateChatResponseV12> | null,
  createChatRefusal: null as CreateChatResponseV12["refusal"] | null,
  openTile: vi.fn<(intent: unknown) => void>(),
  /** The control plane. */
  createSandbox:
    vi.fn<
      (request: SandboxCreateRequest) => Promise<SandboxCreateFetchResult>
    >(),
  stopSandbox: vi.fn<(verb: string) => void>(),
  /** Repairs started and not finished; calling one succeeds that repair. */
  repairFinishers: [] as Array<() => void>,
  retrySupported: true,
  legacySupported: false,
  legacyMutate: vi.fn(),
  settingsStatus: undefined as
    | {
        readonly principal: { readonly kind: "personal" };
        readonly items: readonly {
          readonly kind: string;
          readonly status: string;
        }[];
      }
    | undefined,
  /** The held answer of the next sandbox verb; `null` settles it at rest. */
  verbAnswer: null as Promise<SandboxVerbOutcome> | null,
  /** The verb mutation's reactive state, as `useMutation` reports it. */
  verbState: { isPending: false, error: null } as {
    isPending: boolean;
    error: Error | null;
  },
  listSandboxes: vi.fn<() => Promise<SandboxListFetchResult>>(),
  findById: vi.fn<(hostId: string) => HostDirectoryEntry | null>(),
  /** The account's sandbox rows the ready line is read from. */
  sandboxes: [] as SandboxSummary[],
  /** When the list was last read (epoch ms); `0` is a read before any mount. */
  listReadAt: 0,
  /** When the answered list request was SENT; `null` is its arrival. */
  listReadSentAt: null as number | null,
  refetchSandboxes: vi.fn<() => Promise<undefined>>(),
  /** The sandbox wake the staged run asks for, by host. */
  wake: vi.fn<
    (
      hostId: string,
      gesture: SandboxVerbGesture,
    ) => Promise<SandboxWakeOutcome | null>
  >(),
  /** What reached the sandbox's client, in order: puts, then the create. */
  wire: [] as string[],
  /** Hosts whose client is not available here, as a host not dialled yet. */
  nullClientHosts: new Set<string>(),
  /**
   * What the backend answers to the NEXT model read, per host. A query keeps
   * its first answer fixed (like the host catalog's, which never goes stale)
   * until its returned `refetch` is called.
   */
  modelsByHost: new Map<string, ReadonlyArray<{ readonly slug: string }>>(),
  /** Hosts whose model observer reports a failed refresh (cached data may remain). */
  modelReadErrorHosts: new Set<string>(),
  /** The catalog each host's query holds: its last answer, kept until a refetch. */
  modelCache: new Map<
    string,
    {
      readonly data: ReadonlyArray<{ readonly slug: string }> | undefined;
      readonly isError: boolean;
    }
  >(),
  /** Hosts whose model query was refetched explicitly. */
  modelRefetches: [] as string[],
  /** Every readiness refetch of the harness catalog. */
  harnessRefetches: 0,
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
  useHostDirectoryEntryForHostId: () => null,
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

// The staged run reads the sandbox host's environment.status; an older build
// answers it with the typed unsupported-method error (a network failure would hold).
vi.mock("@/lib/host/binding-host-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host/binding-host-client")>()),
  resolveNamedHostClient: () => ({
    request: () =>
      Promise.reject(
        new HostRpcError({
          code: "E_HOST_UNSUPPORTED",
          message: "Unsupported.",
          requestId: "request-1",
          method: "environment.status",
          fatalDetails: null,
        }),
      ),
  }),
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
      refetch: () => {
        mocks.harnessRefetches += 1;
        return Promise.resolve(undefined);
      },
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
    const hostId = client === null ? null : client.hostId;
    // The backend's answer now; a failed refresh keeps the previous data.
    const answer = (
      previous: ReadonlyArray<{ readonly slug: string }> | undefined,
    ) => ({
      data:
        hostId === null
          ? undefined
          : (mocks.modelsByHost.get(hostId) ?? previous),
      isError: hostId !== null && mocks.modelReadErrorHosts.has(hostId),
    });
    if (
      hostId !== null &&
      activity.enabled &&
      activity.subscribed &&
      !mocks.modelCache.has(hostId)
    )
      mocks.modelCache.set(hostId, answer(undefined));
    // An observer reads what the cache holds while it is subscribed, enabled or not.
    const held =
      hostId === null || !activity.subscribed
        ? undefined
        : mocks.modelCache.get(hostId);
    return {
      data: held?.data === undefined ? undefined : { models: held.data },
      isError: held?.isError ?? false,
      refetch: () => {
        if (hostId === null) return Promise.resolve(undefined);
        mocks.modelRefetches.push(hostId);
        mocks.modelCache.set(
          hostId,
          answer(mocks.modelCache.get(hostId)?.data),
        );
        // A query tells its observers when the read lands, never inside the
        // effect that asked for it.
        return Promise.resolve().then(() => {
          notifyAnswerListeners();
          return undefined;
        });
      },
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
// The failed line's actions read it through their tab host's client: it
// records the host of each client it is handed.
const environmentListClientHosts = vi.hoisted(() => [] as Array<string | null>);
vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: (client: { readonly hostId: string } | null) => {
    environmentListClientHosts.push(client === null ? null : client.hostId);
    return { data: { environments: [] } };
  },
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
  // The failed line's real actions read the control plane through it.
  useAuthService: () => hostBinding.auth,
}));
// The real TabHostProvider mounts a draft mirror that needs a live stream client.
// Only the mount is replaced: it records the host each mirror would bind.
const mirrorMountHosts = vi.hoisted(() => [] as string[]);
vi.mock("@/hooks/drafts/use-tab-draft-mirror", async () => {
  const { useEffect } = await import("react");
  const { useTabHostId } =
    await import("@/components/epic-canvas/hooks/use-tab-host-id");
  return {
    TabDraftMirrorMount: () => {
      const hostId = useTabHostId();
      useEffect(() => {
        mirrorMountHosts.push(hostId);
      }, [hostId]);
      return null;
    },
  };
});
vi.mock("@/hooks/epic/use-task-hosts-view", () => ({
  useTaskHostsView: () =>
    mocks.taskHosts.length === 0
      ? { kind: "none" }
      : { kind: "hosts", hosts: mocks.taskHosts },
}));
// A rested receipt reads its sandbox's state like the chat does; no host row is needed.
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => null,
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
  // The answered request's send time; an old fixture's read is sent when it arrives.
  sandboxListReadSentAt: () => mocks.listReadSentAt ?? mocks.listReadAt,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-verb-mutation", () => ({
  // A verb as the real mutation reports it: the call is recorded, the result
  // is pending until it answers, and a failure stays readable as `error`.
  useSandboxVerb: () => {
    // A mutation hook must stay in its provider tree when its button moves into a toast.
    useQueryClient();
    useAnswerVersion();
    const run = (verb: string): Promise<SandboxVerbOutcome> => {
      mocks.stopSandbox(verb);
      mocks.verbState = { isPending: true, error: null };
      notifyAnswerListeners();
      const answer =
        mocks.verbAnswer !== null
          ? mocks.verbAnswer
          : Promise.resolve<SandboxVerbOutcome>({
              kind: "settled",
              state: "stopped",
            });
      return answer.then(
        (outcome) => {
          mocks.verbState = { isPending: false, error: null };
          notifyAnswerListeners();
          return outcome;
        },
        (error: Error) => {
          mocks.verbState = { isPending: false, error };
          notifyAnswerListeners();
          throw error;
        },
      );
    };
    return {
      mutateAsync: run,
      mutate: (verb: string) => {
        void run(verb).catch(() => undefined);
      },
      isPending: mocks.verbState.isPending,
      error: mocks.verbState.error,
    };
  },
}));
vi.mock("@/hooks/sandboxes/use-configuration-billing-url", () => ({
  useConfigurationBillingUrl: () => "https://example.test/billing",
}));
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => vi.fn(),
}));
// The isolated fixtures read the host's settings as ready; a settings hold is
// exercised by its own test, not by every send.
vi.mock("@/hooks/sandboxes/use-sandbox-settings-status", () => ({
  useSandboxSettingsStatus: () => ({
    // A failed item keeps the host's settings unready, as the real read does.
    ready: mocks.settingsStatus === undefined,
    data: mocks.settingsStatus,
  }),
}));
vi.mock(
  "@/hooks/sandboxes/use-sandbox-repair-guest-configuration-mutation",
  () => ({
    useSandboxSettingsOperation: () => null,
    useSandboxRetryApplyingSupported: () => mocks.retrySupported,
    useSandboxGuestSetupRepairSupported: () => mocks.legacySupported,
    useSandboxRepairGuestSetupOnHost: () => ({
      isPending: false,
      mutate: mocks.legacyMutate,
    }),
    // A repair stays out until the test finishes it, as a slow host would.
    useSandboxRepairGuestConfigurationOnHost: () => ({
      mutate: (
        _variables: Record<string, never>,
        options: {
          readonly onSuccess:
            | ((outcome: {
                readonly guestConfigured: boolean;
                readonly settingsApplied: boolean;
              }) => void)
            | undefined;
        },
      ) => {
        mocks.repairFinishers.push(() =>
          options.onSuccess?.({ guestConfigured: true, settingsApplied: true }),
        );
      },
    }),
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

const CODEX_NOT_OFFERED: HostAnswers = {
  harnesses: [harnessRow("claude", { available: true })],
  providers: [providerRow("claude-code", { status: "installed" })],
};

/** The woken sandbox's own Traycer Inference switch is off. */
const TRAYCER_OFF: HostAnswers = {
  harnesses: [harnessRow("traycer", { enabled: false })],
  providers: [{ ...providerRow("traycer", null), enabled: false }],
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

/** The send each kind of request starts from. */
const SEND_BY_KIND: Readonly<
  Record<"chat" | "fork" | "terminal", SeedOptions["send"]>
> = {
  chat: {},
  fork: { request: FORK_REQUEST },
  terminal: { request: { kind: "terminal" }, text: "" },
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

// The failed line's real actions build their mutations over the runner host.
const RUNNER_HOST = createFakeRunnerHost({});

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <RunnerHostContext.Provider value={RUNNER_HOST}>
      <QueryClientProvider client={client}>
        <PendingSandboxSendsDriver />
        <PendingSandboxSendStrip epicId="epic-1" tabId="tab-1" />
      </QueryClientProvider>
    </RunnerHostContext.Provider>,
  );
}

/** `mount`, inside a tile bound to another host than the strip's receipt. */
function mountInTileBoundTo(tileHostId: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <RunnerHostContext.Provider value={RUNNER_HOST}>
      <QueryClientProvider client={client}>
        <TabHostContext.Provider value={tileHostId}>
          <PendingSandboxSendsDriver />
          <PendingSandboxSendStrip epicId="epic-1" tabId="tab-1" />
        </TabHostContext.Provider>
      </QueryClientProvider>
    </RunnerHostContext.Provider>,
  );
}

/** The driver beside the setup line of the existing chat the message was sent in. */
function mountInChat() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <PendingSandboxSendsDriver />
      <PendingSandboxSendForChat
        epicId="epic-1"
        chatId="existing-chat"
        tabId="tab-1"
      />
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

/** Every composer surface's stage; a pending send's own stage is not one. */
function composerStages(): Readonly<Record<string, StagedSandbox | undefined>> {
  const pending = pendingSendSurfaceKey("");
  return Object.fromEntries(
    Object.entries(useStagedSandboxStore.getState().bySurface).filter(
      ([key]) => !key.startsWith(pending),
    ),
  );
}

/**
 * A give-back writes only the record on the draft that takes the message: no
 * composer surface is staged, and the task composer holds no restored mark
 * for it. The composer showing the draft stages it.
 */
function expectOnlyTheRecordWritten(
  before: Readonly<Record<string, StagedSandbox | undefined>>,
): void {
  expect(composerStages()).toEqual(before);
  const records = [
    useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"]
      ?.returnedSandbox,
    ...useLandingDraftStore
      .getState()
      .drafts.map((draft) => draft.returnedSandbox),
  ];
  for (const record of records)
    if (record !== undefined && record !== null)
      expect(
        takeReturnedSandboxRestored(
          newConversationSurfaceKey("epic-1"),
          record,
        ),
      ).toBe(false);
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
  mocks.createSandbox.mockReset();
  mocks.stopSandbox.mockReset();
  toastSpies.show.mockClear();
  toastSpies.dismiss.mockClear();
  toastSpies.dismissByUser.mockClear();
  toastSpies.activeReceiptToasts.clear();
  toastSpies.dismissalQueue.deferred = false;
  toastSpies.dismissalQueue.callbacks.length = 0;
  mocks.verbAnswer = null;
  mocks.repairFinishers.length = 0;
  mocks.retrySupported = true;
  mocks.legacySupported = false;
  mocks.legacyMutate.mockReset();
  mocks.settingsStatus = undefined;
  mocks.verbState = { isPending: false, error: null };
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
  mocks.listReadSentAt = null;
  mocks.refetchSandboxes.mockReset();
  mocks.refetchSandboxes.mockResolvedValue(undefined);
  mocks.wire.length = 0;
  mocks.nullClientHosts.clear();
  mocks.modelsByHost.clear();
  mocks.modelReadErrorHosts.clear();
  mocks.modelReads.length = 0;
  mocks.modelCache.clear();
  mocks.modelRefetches.length = 0;
  mocks.harnessRefetches = 0;
  mocks.wake.mockReset();
  mocks.wake.mockResolvedValue({ kind: "awake" });
  resetNegotiatedManifests();
  // The sandbox's host is a known older build: it serves forks and has no
  // environment.status, which the staged run reads as an unsupported method (an
  // unrecorded manifest would hold the send).
  recordNegotiatedHostManifest(SANDBOX_HOST, {
    "epic.createChat": { major: 1, minor: 2 },
  });
  useStagedSandboxStore.setState({ bySurface: {} });
  usePendingSandboxSendStore.setState({ sends: {} });
  useStoppedSandboxSendReceiptStore.setState({ receipts: {}, strips: {} });
  useInitialChatHandoffStore.getState().resetForTests();
  useEpicCanvasStore.setState({ pendingChatTitles: {} });
  useNewConversationModalStore.getState().resetForTests();
  useNewConversationModalOpenStore.getState().close();
  useSurfaceHostSelectionStore.getState().resetForTests();
  useSettingsEnvironmentPickStore.setState({ pick: null });
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useComposerDraftStore.setState({ drafts: {} });
});

afterEach(() => {
  cleanup();
  useAuthStore.getState().setSignedOut();
});

describe("the empty task canvas while its first sandbox send waits", () => {
  beforeEach(() => {
    useEpicCanvasStore.setState({ tabsById: {}, canvasByTabId: {} });
    useEpicCanvasStore
      .getState()
      .seedEpic("epic-1", { tabId: "tab-1", name: "Sandbox task" }, []);
  });

  afterEach(() => {
    resetPaneOpenerFocusForTests();
    useEpicCanvasStore.setState({ tabsById: {}, canvasByTabId: {} });
  });

  function mountCanvas(drive: boolean) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    return render(
      <QueryClientProvider client={client}>
        {drive ? <PendingSandboxSendsDriver /> : null}
        <TileCanvas epicId="epic-1" tabId="tab-1" />
      </QueryClientProvider>,
    );
  }

  function projectChat(chatId: string): void {
    const store = useEpicCanvasStore.getState();
    store.ensureEmptyPaneInTab("tab-1");
    const root = useEpicCanvasStore.getState().canvasByTabId["tab-1"]?.root;
    if (root?.kind !== "pane") throw new Error("expected the task's pane");
    const chat: EpicCanvasTileRef = makeOpenableNodeRef({
      type: "chat",
      id: chatId,
      instanceId: `sandbox-chat-${chatId}`,
      name: "Sandbox chat",
      hostId: SANDBOX_HOST,
    });
    store.openTileInPane("tab-1", root.id, chat, {
      mode: "permanent",
      index: null,
    });
  }

  it.each([
    ["resuming", RESUME_TARGET],
    ["starting", START_TARGET],
    ["creating", NEW_TARGET],
  ] as const)(
    "shows only the pending send on a %s sandbox",
    async (_name, target) => {
      seed({ ...SEEDED, target, phase: "creating", created: false });
      mountCanvas(false);

      expect(await screen.findByTestId("sandbox-setup-line")).toBeDefined();
      expect(screen.getByText("fix the login bug")).toBeDefined();
      expect(
        screen.queryByRole("combobox", { name: "Open into pane" }),
      ).toBeNull();
    },
  );

  it("returns the picker after cancelling the message with the pane still empty", async () => {
    const restoreLocks = installImmediateExclusiveLocks();
    try {
      seed({
        ...SEEDED,
        target: RESUME_TARGET,
        phase: "creating",
      });
      useStagedSandboxStore.getState().report(SURFACE, {
        failure: { kind: "timed-out", step: "booting" },
      });
      mountCanvas(false);
      expect(
        screen.queryByRole("combobox", { name: "Open into pane" }),
      ).toBeNull();
      const cancel = await screen.findByRole("button", {
        name: "Cancel the message",
      });
      await waitFor(() => expect(cancel).not.toHaveProperty("disabled", true));
      fireEvent.click(cancel);

      expect(
        await screen.findByRole("combobox", { name: "Open into pane" }),
      ).toBeDefined();
      expect(screen.queryByTestId("pending-sandbox-sends")).toBeNull();
    } finally {
      restoreLocks();
    }
  });

  it("returns the picker when sandbox creation is refused", async () => {
    seed({ ...SEEDED, phase: "creating", created: false });
    const creation = deferred<SandboxCreateFetchResult>();
    mocks.createSandbox.mockReturnValue(creation.promise);
    mountCanvas(true);
    const pickerWhilePending = screen.queryByRole("combobox", {
      name: "Open into pane",
    });

    act(() =>
      creation.resolve({
        kind: "refused",
        status: 402,
        code: "insufficient_credit",
        reason: null,
        shortfallMc: 120,
        newRateMcPerHour: null,
        currentAwakeBurnMcPerHour: null,
        message: "refused",
      }),
    );

    expect(await screen.findByTestId("sandbox-refusal-line")).toBeDefined();
    expect(pickerWhilePending).toBeNull();
    expect(
      await screen.findByRole("combobox", { name: "Open into pane" }),
    ).toBeDefined();
    expect(screen.getByText("fix the login bug")).toBeDefined();
  });

  it("returns the picker after a terminal failure with no chat", async () => {
    seed({ ...SEEDED, phase: "creating" });
    mountCanvas(false);
    expect(
      screen.queryByRole("combobox", { name: "Open into pane" }),
    ).toBeNull();

    act(() =>
      useStagedSandboxStore.getState().report(SURFACE, {
        failure: { kind: "failed", code: "boot-failed", step: "booting" },
      }),
    );

    expect(
      await screen.findByRole("combobox", { name: "Open into pane" }),
    ).toBeDefined();
  });

  it("shows the chat after delivery", async () => {
    seed(SEEDED);
    answerHost(SANDBOX_HOST, CODEX_DOWNLOADING);
    mountCanvas(true);
    expect(
      screen.queryByRole("combobox", { name: "Open into pane" }),
    ).toBeNull();

    answerHost(SANDBOX_HOST, CODEX_READY);
    await waitFor(() => {
      expect(
        usePendingSandboxSendStore.getState().sends[SEND_ID].delivery,
      ).not.toBeNull();
    });
    const delivery =
      usePendingSandboxSendStore.getState().sends[SEND_ID].delivery;
    if (delivery === null) throw new Error("expected the delivered chat");
    act(() => projectChat(delivery.chatId));

    expect(screen.getByTestId("canvas-chat").textContent).toBe(delivery.chatId);
    expect(screen.queryByTestId("pending-sandbox-sends")).toBeNull();
    expect(
      screen.queryByRole("combobox", { name: "Open into pane" }),
    ).toBeNull();
  });

  it("keeps the picker unmounted after rehydrating a pending send and reconnecting", async () => {
    seed({ ...SEEDED, target: RESUME_TARGET, phase: "creating" });
    mountCanvas(false);
    await reloadPendingSandboxStores();
    mountCanvas(false);
    notifyAnswerListeners();

    expect(await screen.findByTestId("sandbox-setup-line")).toBeDefined();
    expect(screen.getByText("fix the login bug")).toBeDefined();
    expect(
      screen.queryByRole("combobox", { name: "Open into pane" }),
    ).toBeNull();
  });

  it("leaves another task's empty pane available while this task's send waits", async () => {
    seed({ ...SEEDED, send: { epicId: "other-task" }, phase: "creating" });
    mountCanvas(false);

    expect(
      await screen.findByRole("combobox", { name: "Open into pane" }),
    ).toBeDefined();
    expect(screen.queryByTestId("pending-sandbox-sends")).toBeNull();
  });

  it("does not register a picker that can take focus from the composer", () => {
    seed({ ...SEEDED, phase: "creating" });
    render(<textarea aria-label="Composer" />);
    const composer = screen.getByRole("textbox", { name: "Composer" });
    composer.focus();
    mountCanvas(false);
    const root = useEpicCanvasStore.getState().canvasByTabId["tab-1"]?.root;
    if (root?.kind !== "pane") throw new Error("expected the task's pane");
    requestPaneOpenerFocus("tab-1", root.id);

    expect(document.activeElement).toBe(composer);
    expect(
      screen.queryByRole("combobox", { name: "Open into pane" }),
    ).toBeNull();
  });

  it("treats a saved blank tab as empty while the first send waits", () => {
    seed({ ...SEEDED, phase: "creating" });
    const store = useEpicCanvasStore.getState();
    store.ensureEmptyPaneInTab("tab-1");
    const root = useEpicCanvasStore.getState().canvasByTabId["tab-1"]?.root;
    if (root?.kind !== "pane") throw new Error("expected the task's pane");
    store.openTileInPane("tab-1", root.id, makeBlankTileRef(), {
      mode: "permanent",
      index: null,
    });
    mountCanvas(false);

    expect(
      screen.queryByRole("combobox", { name: "Open into pane" }),
    ).toBeNull();
  });

  it("suppresses only the pane explicitly named by the send", () => {
    useEpicCanvasStore.getState().ensureEmptyPaneInTab("tab-1");
    const root = useEpicCanvasStore.getState().canvasByTabId["tab-1"]?.root;
    if (root?.kind !== "pane") throw new Error("expected the task's pane");
    seed({
      ...SEEDED,
      phase: "creating",
      send: {
        request: {
          kind: "chat",
          parentId: null,
          placement: {
            kind: "tab",
            paneId: root.id,
            index: null,
          },
        },
      },
    });
    const task = mountCanvas(false);
    const otherPane = render(
      <PaneOpener
        epicId="epic-1"
        tabId="tab-1"
        groupId="other-pane"
        active={false}
      />,
    );

    expect(within(task.container).queryByRole("combobox")).toBeNull();
    expect(
      within(otherPane.container).getByRole("combobox", {
        name: "Open into pane",
      }),
    ).toBeDefined();
  });

  it.each(["timeout", "held-stop", "uncertain-dispatch"] as const)(
    "keeps the picker suppressed for a %s with no definite outcome",
    async (outcome) => {
      seed({ ...SEEDED, send: { stopRequested: outcome === "held-stop" } });
      if (outcome === "uncertain-dispatch") {
        answerHost(SANDBOX_HOST, CODEX_READY);
        mocks.createChatError = new Error("connection lost");
      } else {
        useStagedSandboxStore.getState().report(SURFACE, {
          failure:
            outcome === "timeout"
              ? { kind: "timed-out", step: "booting" }
              : { kind: "settings", code: "pending-send-stop" },
        });
      }
      mountCanvas(outcome === "uncertain-dispatch");

      if (outcome === "uncertain-dispatch") {
        await waitFor(() =>
          expect(
            usePendingSandboxSendStore.getState().sends[SEND_ID].dispatch
              ?.status,
          ).toBe("uncertain"),
        );
      }
      expect(
        screen.queryByRole("combobox", { name: "Open into pane" }),
      ).toBeNull();
      expect(screen.getByText("fix the login bug")).toBeDefined();
    },
  );

  it("keeps an existing chat visible while another message waits", () => {
    seed({ ...SEEDED, phase: "creating" });
    projectChat("existing-chat");
    mountCanvas(false);

    expect(screen.getByTestId("canvas-chat").textContent).toBe("existing-chat");
  });
});

describe("a send waiting for the requested agent on its sandbox", () => {
  it.each(["chat", "fork"] as const)(
    "waits for Traycer's Managed 2 engine before a %s, then creates on that exact line",
    async (kind) => {
      const create = deferred<CreateChatResponseV12>();
      mocks.createChatDeferred = create.promise;
      onTestFinished(() => resolvePendingCreate(create));
      seed({
        ...SEEDED,
        send: {
          ...SEND_BY_KIND[kind],
          settings: { ...PICKED_SETTINGS, harnessId: "traycer" },
        },
      });
      answerHost(SANDBOX_HOST, {
        harnesses: [harnessRow("traycer", {})],
        providers: [
          providerRow("traycer", { status: "installed" }),
          opencodeProviderRow({ status: "downloading", percent: 40 }, {}),
        ],
      });
      mount();

      expect(createChatCalls()).toEqual([]);
      expect(screen.getByTestId("sandbox-setup-line")).toBeDefined();
      expect(screen.queryByTestId("sandbox-ready-line")).toBeNull();
      expect(screen.queryByTestId("sandbox-refusal-line")).toBeNull();

      answerHost(SANDBOX_HOST, {
        harnesses: [harnessRow("traycer", {})],
        providers: [
          providerRow("traycer", { status: "installed" }),
          opencodeProviderRow({ status: "installed" }, {}),
        ],
      });

      await waitForCreateChats(1);
      expect(createChatCalls()[0]).toMatchObject({
        clientHostId: SANDBOX_HOST,
        input: { opencodeLine: 2, settings: { harnessId: "traycer" } },
      });
      render(
        <SandboxReadyLineForChat chatId={createChatCalls()[0].input.chatId} />,
      );
      expect(screen.queryByTestId("sandbox-ready-line")).toBeNull();
      await resolvePendingCreate(create);
      expect(await screen.findByTestId("sandbox-ready-line")).toBeDefined();
      expect(screen.queryByTestId("pending-sandbox-message")).toBeNull();
    },
  );

  it("refuses Traycer's failed Managed 2 setup even though Managed 1 is installed and its catalog is available", async () => {
    seed({
      ...SEEDED,
      send: { settings: { ...PICKED_SETTINGS, harnessId: "traycer" } },
    });
    answerHost(SANDBOX_HOST, {
      harnesses: [harnessRow("traycer", {})],
      providers: [
        providerRow("traycer", { status: "installed" }),
        opencodeProviderRow(
          {
            status: "error",
            reason: "disk-full",
            message: "ENOSPC",
            retryAtMs: null,
          },
          {},
        ),
      ],
    });
    mount();

    await waitFor(() => {
      expect(readStagedSandbox(SURFACE)?.failure).toMatchObject({
        kind: "agent-setup-failed",
      });
    });
    const failure = readStagedSandbox(SURFACE)?.failure;
    if (failure?.kind !== "agent-setup-failed")
      throw new Error("expected failed setup");
    expect(failure.detail).toContain("disk space");
    expect(createChatCalls()).toEqual([]);
  });

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
      providers: [
        providerRow("codex", { status: "installed" }),
        providerRow("claude-code", null),
      ],
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
    expect(within(line).getByText(NO_AGENT_SENTENCE)).toBeDefined();
    expect(readStagedSandbox(SURFACE)?.failure).toEqual({
      kind: "no-provider",
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(createChatCalls()).toEqual([]);
  });

  it("refuses a Personal send whose agent cannot run there, uses no other agent, offers Choose a model, and links no Providers", async () => {
    onTestFinished(installImmediateExclusiveLocks());
    seed({
      ...SEEDED,
      send: { settings: { ...PICKED_SETTINGS, harnessId: "traycer" } },
    });
    // Traycer is present but unavailable; another ready agent is not a fallback.
    answerHost(SANDBOX_HOST, {
      harnesses: [
        harnessRow("traycer", {
          available: false,
          availabilityPending: false,
        }),
        harnessRow("claude", { available: true }),
      ],
      providers: [providerRow("claude-code", null)],
    });
    mount();

    const line = await screen.findByTestId("sandbox-refusal-line");
    expect(within(line).getByText(NO_AGENT_SENTENCE)).toBeDefined();
    expect(createChatCalls()).toEqual([]);
    expect(readStagedSandbox(SURFACE)?.failure).toEqual({
      kind: "no-provider",
    });
    // The message stays, pending.
    expect(screen.getByTestId("pending-sandbox-message").textContent).toBe(
      "fix the login bug",
    );

    expect(
      await within(line).findByRole("button", { name: "Choose a model" }),
    ).toBeDefined();
    expect(line.textContent).not.toContain("Providers");
  });

  it("keeps the Traycer picker remedy out of an occupied new-chat draft until it clears", async () => {
    const restoreLocks = installImmediateExclusiveLocks();
    try {
      seed(SEEDED);
      answerHost(SANDBOX_HOST, CODEX_NOT_OFFERED);
      mount();

      const line = await screen.findByTestId("sandbox-refusal-line");
      await waitFor(() => {
        expect(readStagedSandbox(SURFACE)?.failure).toEqual({
          kind: "agent-not-offered",
          harnessId: "codex",
        });
        expect(
          within(line).getByRole("button", { name: "Choose another host" }),
        ).toBeDefined();
      });
      expect(
        within(line).getByText(
          "Codex doesn't run on sandboxes. Choose a Traycer model to run agents here.",
        ),
      ).toBeDefined();
      expect(
        within(line).getByRole("button", { name: "Choose a model" }),
      ).toBeDefined();
      expect(
        within(line).getByRole("button", { name: "Open terminal instead" }),
      ).toBeDefined();
      expect(createChatCalls()).toEqual([]);
      expect(mocks.createSandbox).not.toHaveBeenCalled();
      expect(mocks.wake).not.toHaveBeenCalled();
      expect(screen.getByTestId("pending-sandbox-message").textContent).toBe(
        "fix the login bug",
      );

      act(() => {
        useNewConversationModalStore
          .getState()
          .setContent("epic-1", OCCUPIED_NEW_CHAT_CONTENT);
        useNewConversationModalStore
          .getState()
          .setSelection("epic-1", { from: 1, to: 1 });
      });
      await waitFor(() => {
        expect(
          within(line).queryByRole("button", { name: "Choose a model" }),
        ).toBeNull();
      });
      expect(
        useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"],
      ).toMatchObject({ content: OCCUPIED_NEW_CHAT_CONTENT });
      const openTerminalButton = within(line).getByRole("button", {
        name: "Open terminal instead",
      });
      expect(
        openTerminalButton instanceof HTMLButtonElement &&
          openTerminalButton.disabled,
      ).toBe(false);
      const chooseAnotherHostButton = within(line).getByRole("button", {
        name: "Choose another host",
      });
      expect(
        chooseAnotherHostButton instanceof HTMLButtonElement &&
          chooseAnotherHostButton.disabled,
      ).toBe(false);

      act(() => {
        useNewConversationModalStore.getState().clearDraft("epic-1");
        useNewConversationModalStore
          .getState()
          .setSelection("epic-1", { from: 1, to: 1 });
      });
      expect(
        useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"],
      ).toMatchObject({ content: null, selection: { from: 1, to: 1 } });
      await within(line).findByRole("button", { name: "Choose a model" });

      fireEvent.click(
        within(line).getByRole("button", { name: "Choose a model" }),
      );

      await waitFor(() => {
        expect(usePendingSandboxSendStore.getState().sends).toEqual({});
      });
      expect(
        useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"],
      ).toMatchObject({ content: MESSAGE_CONTENT, settings: PICKED_SETTINGS });
      expect(useNewConversationModalOpenStore.getState().request).toMatchObject(
        {
          epicId: "epic-1",
          modelPickerHarnessId: "traycer",
        },
      );
    } finally {
      restoreLocks();
    }
  });

  it.each([
    ["no-provider", CODEX_UNAVAILABLE, { kind: "no-provider" }],
    [
      "not offered",
      CODEX_NOT_OFFERED,
      { kind: "agent-not-offered", harnessId: "codex" },
    ],
    [
      "offered but off",
      {
        harnesses: [harnessRow("codex", { enabled: false, available: false })],
        providers: [{ ...providerRow("codex", null), enabled: false }],
      },
      { kind: "no-provider" },
    ],
    ["failed install", CODEX_SETUP_FAILED, { kind: "agent-setup-failed" }],
  ] as const satisfies ReadonlyArray<
    readonly [string, HostAnswers, Partial<StagedSandboxFailure>]
  >)(
    "keeps a %s message and its remedy without waking when its sandbox suspends",
    async (_label, answers, failure) => {
      seed(SEEDED);
      answerHost(SANDBOX_HOST, answers);
      const view = mount();
      await waitFor(() => {
        expect(readStagedSandbox(SURFACE)?.failure).toMatchObject(failure);
      });

      // A fresh idle suspension reaches the root driver even with no task open.
      view.unmount();
      answerSandboxRows(
        [
          sandboxSummaryFixture({
            id: SANDBOX_ID,
            hostId: SANDBOX_HOST,
            state: "suspended",
          }),
        ],
        Date.now() + 120_000,
      );
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      render(
        <QueryClientProvider client={client}>
          <PendingSandboxSendsDriver />
        </QueryClientProvider>,
      );

      expect(mocks.wake).not.toHaveBeenCalled();
      expect(mocks.createSandbox).not.toHaveBeenCalled();
      expect(createChatCalls()).toEqual([]);
      expect(readStagedSandbox(SURFACE)).toMatchObject({
        phase: "handoff",
        failure,
      });
      expect(
        usePendingSandboxSendStore.getState().sends[SEND_ID],
      ).toMatchObject({
        content: MESSAGE_CONTENT,
        settings: PICKED_SETTINGS,
        delivery: null,
      });
    },
  );

  it("brings the message back and wakes nothing when the sandbox rests while a pack installs", async () => {
    onTestFinished(installImmediateExclusiveLocks());
    seed(SEEDED);
    answerHost(SANDBOX_HOST, CODEX_DOWNLOADING);
    mount();
    expect(readStagedSandbox(SURFACE)?.failure).toBeNull();

    const awake = sandboxSummaryFixture({
      id: SANDBOX_ID,
      hostId: SANDBOX_HOST,
      state: "awake",
    });
    mocks.listSandboxes.mockResolvedValue(listAnswers([awake]));
    answerSandboxRows([{ ...awake, state: "suspended" }], Date.now() + 120_000);

    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    expect(mocks.wake).not.toHaveBeenCalled();
    expect(createChatCalls()).toEqual([]);
    expect(mocks.createSandbox).not.toHaveBeenCalled();
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"],
    ).toMatchObject({ content: MESSAGE_CONTENT });
  });

  it("delivers the requested agent after its Personal provider is repaired, without a manual retry or a second sandbox", async () => {
    seed(SEEDED);
    answerHost(SANDBOX_HOST, CODEX_UNAVAILABLE);
    mount();

    const line = await screen.findByTestId("sandbox-refusal-line");
    expect(readStagedSandbox(SURFACE)?.failure).toEqual({
      kind: "no-provider",
    });
    expect(within(line).getByText(NO_AGENT_SENTENCE)).toBeDefined();

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

  // Traycer Inference is that sandbox's own switch, so the line names the
  // sandbox, not its configuration, and no Settings page reaches it.
  describe("on a woken sandbox whose own Traycer Inference is off", () => {
    it.each([
      ["Personal's", NEW_TARGET],
      ["a team's", TEAM_TARGET],
    ] as const)(
      "on %s sandbox, names its switch, offers Choose a model, links no Providers, and delivers nothing",
      async (_label, target) => {
        onTestFinished(installImmediateExclusiveLocks());
        seed({
          ...SEEDED,
          target,
          send: { settings: { ...PICKED_SETTINGS, harnessId: "traycer" } },
        });
        answerHost(SANDBOX_HOST, TRAYCER_OFF);
        mount();

        const line = await screen.findByTestId("sandbox-refusal-line");
        expect(
          within(line).getByText(
            "Traycer Inference is off on api-refactor, so agents can't run on it.",
          ),
        ).toBeDefined();
        expect(
          await within(line).findByRole("button", { name: "Choose a model" }),
        ).toBeDefined();
        expect(line.textContent).not.toContain("Providers");
        expect(readStagedSandbox(SURFACE)?.failure).toEqual({
          kind: "traycer-off",
        });
        expect(createChatCalls()).toEqual([]);
      },
    );
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
    seed({ ...SEEDED, target: TEAM_TARGET });
    answerHost(SANDBOX_HOST, CODEX_UNAVAILABLE);
    mount();

    const line = await screen.findByTestId("sandbox-refusal-line");
    expect(readStagedSandbox(SURFACE)?.failure).toEqual({
      kind: "no-provider",
    });
    expect(within(line).getByText(NO_AGENT_SENTENCE)).toBeDefined();

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
        send: {
          ...(kind === "fork" ? { request: FORK_REQUEST } : {}),
          // A row the list once showed: its absence now is real.
          createdSandbox: { sandboxId: SANDBOX_ID, rowSeen: true },
        },
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

describe("a send whose task may not exist yet", () => {
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
      const key = readStagedSandbox(SURFACE)?.clientRequestId;
      mocks.createSandbox.mockResolvedValue(CREDITS_REFUSED);
      const before = composerStages();
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
      // It keeps its sandbox, and the create's key: that create may have
      // been accepted, and the draft's Send must name it again.
      expect(useLandingDraftStore.getState().drafts).toMatchObject([
        {
          content: MESSAGE_CONTENT,
          settings: PICKED_SETTINGS,
          closed: true,
          returnedSandbox: { target: NEW_TARGET, clientRequestId: key },
        },
      ]);
      expectOnlyTheRecordWritten(before);
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

  it("waits through reads that have not listed the accepted create yet, and calls it gone only after a read has seen it", async () => {
    const restoreLocks = installImmediateExclusiveLocks();
    try {
      const fresh = Date.now() + 60_000;
      // An accepted create still booting (not the handoff, which implies a seen row).
      seed({ ...SEEDED, phase: "creating", created: true });
      answerHost(SANDBOX_HOST, CODEX_READY);
      mocks.listSandboxes.mockResolvedValue(listAnswers([]));
      // Reads so far predate the request, so they prove nothing either way.
      mocks.listReadSentAt = 0;
      answerSandboxRows([], 0);
      mount();
      // The runner records the accepted create under the owner the driver holds.
      await waitFor(() => {
        expect(
          usePendingSandboxSendStore
            .getState()
            .recordCreatedSandbox(SEND_ID, SANDBOX_ID),
        ).toBe(true);
      });
      expect(
        usePendingSandboxSendStore.getState().sends[SEND_ID]?.createdSandbox,
      ).toEqual({ sandboxId: SANDBOX_ID, rowSeen: false });

      mocks.listReadSentAt = fresh;
      answerSandboxRows([], fresh);
      // Fresh reads miss the row: it has never been seen, so it is not gone.
      mocks.listReadSentAt = fresh + 1;
      answerSandboxRows([], fresh + 1);
      await act(async () => {
        await Promise.resolve();
      });
      expect(
        usePendingSandboxSendStore.getState().sends[SEND_ID],
      ).toBeDefined();
      expect(useLandingDraftStore.getState().drafts).toEqual([]);

      const row = sandboxSummaryFixture({
        id: SANDBOX_ID,
        hostId: SANDBOX_HOST,
        state: "awake",
      });
      mocks.listSandboxes.mockResolvedValue(listAnswers([row]));
      mocks.listReadSentAt = fresh + 2;
      answerSandboxRows([row], fresh + 2);
      await act(async () => {
        await Promise.resolve();
      });
      expect(
        usePendingSandboxSendStore.getState().sends[SEND_ID],
      ).toBeDefined();
      await waitFor(() => {
        expect(
          usePendingSandboxSendStore.getState().sends[SEND_ID]?.createdSandbox,
        ).toEqual({ sandboxId: SANDBOX_ID, rowSeen: true });
      });

      // Seen once, then missing: now it is gone.
      mocks.listSandboxes.mockResolvedValue(listAnswers([]));
      mocks.listReadSentAt = fresh + 3;
      answerSandboxRows([], fresh + 3);
      await waitFor(() => {
        expect(usePendingSandboxSendStore.getState().sends).toEqual({});
      });
      expect(createChatCalls()).toEqual([]);
    } finally {
      cleanup();
      // The run the driver took up must end before the shared surface is reused.
      await waitFor(
        () => {
          expect(stagedRunActive(SURFACE)).toBe(false);
        },
        { timeout: 8000 },
      );
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

describe("a send recovered without its message going back to a task", () => {
  const SAVED_LINE = "Your message wasn't sent; it's saved in your drafts.";
  let restoreLocks: () => void = () => undefined;
  beforeEach(() => {
    restoreLocks = installImmediateExclusiveLocks();
  });
  afterEach(() => {
    restoreLocks();
  });

  /** The driver, which carries the app's receipts, as a window with no task open has it. */
  function mountDriverWithReceipts(): void {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    render(
      <RunnerHostContext.Provider value={RUNNER_HOST}>
        <QueryClientProvider client={client}>
          <PendingSandboxSendsDriver />
        </QueryClientProvider>
      </RunnerHostContext.Provider>,
    );
  }

  async function sendRecovered(): Promise<void> {
    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
  }

  it("records a receipt for an unconfirmed send recovered into a landing draft", async () => {
    // Seeded the way a rehydrated record is: this window never handed it.
    seed({
      ...SEEDED,
      send: { epicConfirmed: false },
      phase: "creating",
      created: false,
    });
    mountDriverWithReceipts();

    await sendRecovered();
    const [draft] = useLandingDraftStore.getState().drafts;
    expect(draft).toMatchObject({ content: MESSAGE_CONTENT, closed: true });
    expect(
      useStoppedSandboxSendReceiptStore.getState().receipts[SEND_ID],
    ).toMatchObject({
      kind: "recovered",
      epicId: "epic-1",
      userId: "user-1",
      returned: { kind: "landing-draft", draftId: draft.id },
    });
  });

  it("says the message is saved in Drafts after a reload, and Open draft opens that draft", async () => {
    seed({
      ...SEEDED,
      send: { epicConfirmed: false },
      phase: "creating",
      created: false,
    });
    await reloadPendingSandboxStores();
    expect(useStoppedSandboxSendReceiptStore.getState().receipts).toEqual({});
    mountDriverWithReceipts();

    const toastId = `sandbox-stopped:${SEND_ID}`;
    await waitFor(() => {
      expect(toastSpies.activeReceiptToasts.has(toastId)).toBe(true);
    });
    await sendRecovered();
    const [draft] = useLandingDraftStore.getState().drafts;
    const shown = toastSpies.activeReceiptToasts.get(toastId);
    if (shown === undefined) throw new Error("expected the receipt's toast");
    const view = render(shown.content);
    expect(view.container.textContent).toContain(SAVED_LINE);
    // The receipt did not dismiss itself while the stores settled.
    expect(
      useStoppedSandboxSendReceiptStore.getState().receipts[SEND_ID],
    ).toBeDefined();
    expect(toastSpies.activeReceiptToasts.has(toastId)).toBe(true);

    fireEvent.click(
      within(view.container).getByRole("button", { name: "Open draft" }),
    );

    expect(useLandingDraftStore.getState().activeDraftId).toBe(draft.id);
    expect(
      useStoppedSandboxSendReceiptStore.getState().receipts[SEND_ID],
    ).toBeUndefined();
  });

  it("keeps the recovered line when the boot restores another draft's sandbox as a composer stage, and Open draft still opens its draft", async () => {
    seed({
      ...SEEDED,
      send: { epicConfirmed: false },
      phase: "creating",
      created: false,
    });
    await reloadPendingSandboxStores();
    mountDriverWithReceipts();
    const toastId = `sandbox-stopped:${SEND_ID}`;
    await waitFor(() => {
      expect(toastSpies.activeReceiptToasts.has(toastId)).toBe(true);
    });
    await sendRecovered();
    const [draft] = useLandingDraftStore.getState().drafts;

    // Another open draft names a sandbox, and the landing composer stages it.
    useLandingDraftStore.getState().installLandingDraft({
      id: "other-draft",
      content: MESSAGE_CONTENT,
      selection: null,
      lastTouchedAt: Date.now(),
      settings: PICKED_SETTINGS,
      composerMode: "chat",
      workspace: emptyLandingDraftWorkspaceSnapshot(),
      closed: false,
      returnedSandbox: { target: NEW_TARGET, clientRequestId: null },
      durability: "saved",
    });
    const composerSurface = composerSurfaceKey(null);
    renderHook(() =>
      useLandingReturnedSandbox(composerSurface, "other-draft", true),
    );
    await waitFor(() => {
      expect(readStagedSandbox(composerSurface)).toMatchObject({
        target: NEW_TARGET,
      });
    });

    expect(
      useStoppedSandboxSendReceiptStore.getState().receipts[SEND_ID],
    ).toBeDefined();
    expect(toastSpies.activeReceiptToasts.has(toastId)).toBe(true);
    const shown = toastSpies.activeReceiptToasts.get(toastId);
    if (shown === undefined) throw new Error("expected the receipt's toast");
    const view = render(shown.content);
    fireEvent.click(
      within(view.container).getByRole("button", { name: "Open draft" }),
    );
    expect(useLandingDraftStore.getState().activeDraftId).toBe(draft.id);
  });

  it("dismisses a cancelled receipt when a composer stage appears", async () => {
    const restoreCreate = deferred<SandboxCreateFetchResult>();
    seed({ ...SEEDED, phase: "creating", created: false });
    mocks.createSandbox.mockReturnValue(restoreCreate.promise);
    mount();
    act(() => {
      useStagedSandboxStore.getState().report(SURFACE, {
        failure: { kind: "timed-out", step: "creating" },
      });
    });
    const cancel = await screen.findByRole("button", {
      name: "Cancel the message",
    });
    await waitFor(() => expect(cancel).not.toHaveProperty("disabled", true));
    fireEvent.click(cancel);
    // The task is open, so its strip says it.
    await screen.findByTestId("sandbox-stopped-line");
    expect(
      useStoppedSandboxSendReceiptStore.getState().receipts[SEND_ID],
    ).toMatchObject({ kind: "cancelled" });

    act(() => {
      useStagedSandboxStore
        .getState()
        .stage(composerSurfaceKey(null), NEW_TARGET);
    });

    await waitFor(() => {
      expect(
        useStoppedSandboxSendReceiptStore.getState().receipts[SEND_ID],
      ).toBeUndefined();
    });
    expect(screen.queryByTestId("sandbox-stopped-line")).toBeNull();
    await act(async () => {
      restoreCreate.resolve(CREDITS_REFUSED);
      await restoreCreate.promise;
    });
  });

  it("adds no receipt for a confirmed send whose message went to Drafts because the composer was occupied", async () => {
    // Its stage is gone and its task confirmed: the composer holds another
    // message, so this one is saved in Drafts.
    usePendingSandboxSendStore
      .getState()
      .add(pendingSend({ id: SEND_ID, epicConfirmed: true }));
    useNewConversationModalStore
      .getState()
      .setContent("epic-1", OCCUPIED_NEW_CHAT_CONTENT);
    mountDriverWithReceipts();

    await sendRecovered();
    expect(useLandingDraftStore.getState().drafts).toMatchObject([
      { content: MESSAGE_CONTENT, closed: true },
    ]);
    expect(useStoppedSandboxSendReceiptStore.getState().receipts).toEqual({});
    expect(toastSpies.activeReceiptToasts.size).toBe(0);
  });

  it("adds no receipt for an ended send saved to Drafts", async () => {
    seed({
      ...SEEDED,
      send: { epicConfirmed: false, ended: true },
      phase: "creating",
      created: false,
    });
    mountDriverWithReceipts();

    await sendRecovered();
    expect(useLandingDraftStore.getState().drafts).toMatchObject([
      { content: MESSAGE_CONTENT, closed: true },
    ]);
    expect(useStoppedSandboxSendReceiptStore.getState().receipts).toEqual({});
    expect(toastSpies.activeReceiptToasts.size).toBe(0);
  });

  it("neither withdraws nor records a receipt for an unconfirmed send this window handed in", async () => {
    const composerSurface = "landing:draft-1";
    useStagedSandboxStore.getState().stage(composerSurface, NEW_TARGET);
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
    if (id === null) throw new Error("expected the Send to hand over");
    mountDriverWithReceipts();
    // The driver has taken the send up once it holds its ownership.
    const ownership = holdPendingSandboxSendOwnership(id);
    try {
      await act(async () => {
        await ownership.ready;
      });
    } finally {
      ownership.release();
    }

    expect(Object.keys(usePendingSandboxSendStore.getState().sends)).toEqual([
      id,
    ]);
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
    expect(useStoppedSandboxSendReceiptStore.getState().receipts).toEqual({});
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
    "brings the message back past handoff when a %s sandbox rests, and wakes nothing",
    async (state) => {
      onTestFinished(installImmediateExclusiveLocks());
      seed({ ...SEEDED, phase: "handoff", created: true });
      mocks.listReadAt = FRESH;
      mocks.sandboxes = [rowIn(state)];
      mocks.listSandboxes.mockResolvedValue(listAnswers([rowIn("awake")]));
      answerHost(SANDBOX_HOST, CODEX_DOWNLOADING);
      mount();

      await waitFor(() => {
        expect(usePendingSandboxSendStore.getState().sends).toEqual({});
      });
      expect(mocks.wake).not.toHaveBeenCalled();
      expect(createChatCalls()).toEqual([]);
      expect(mocks.createSandbox).not.toHaveBeenCalled();
      expect(
        useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"],
      ).toMatchObject({ content: MESSAGE_CONTENT });
    },
  );

  it("mounted fresh as after a reload, never wakes a sandbox found at rest: the message goes back on it and the footer says so", async () => {
    onTestFinished(installImmediateExclusiveLocks());
    seed({
      ...SEEDED,
      target: RESUME_TARGET,
      send: { request: { kind: "chat", parentId: null, placement: null } },
      phase: "creating",
      created: true,
    });
    expect(readStagedSandbox(SURFACE)).toMatchObject({
      phase: "creating",
      step: "booting",
      failure: null,
    });
    mocks.listReadAt = FRESH;
    mocks.sandboxes = [rowIn("suspended")];
    mocks.listSandboxes.mockResolvedValue(listAnswers([rowIn("suspended")]));
    answerHost(SANDBOX_HOST, CODEX_READY);
    mount();

    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    expect(mocks.wake).not.toHaveBeenCalled();
    expect(createChatCalls()).toEqual([]);
    expect(screen.queryByTestId("sandbox-setup-line")).toBeNull();
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"],
    ).toMatchObject({
      content: MESSAGE_CONTENT,
      returnedSandbox: {
        target: {
          kind: "existing",
          hostId: SANDBOX_HOST,
          sandboxId: SANDBOX_ID,
          verb: "resume",
        },
      },
    });
    const line = await screen.findByTestId("sandbox-stopped-line");
    expect(line.textContent).toContain(
      "build-box is suspended · your next message resumes it",
    );
  });

  it("cancels a terminal request from a legacy handoff whose sandbox rests, waking nothing", async () => {
    onTestFinished(installImmediateExclusiveLocks());
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
    answerHost(SANDBOX_HOST, CODEX_DOWNLOADING);
    mount();

    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    expect(mocks.wake).not.toHaveBeenCalled();
    expect(mocks.openTile).not.toHaveBeenCalled();
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

      answerSandboxRows([rowIn("awake")], Date.now() + 60_000);

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

  it("ends the send when its sandbox is reported failed past handoff, delivering nothing", async () => {
    seed({ ...SEEDED, phase: "handoff", created: true });
    mocks.listReadAt = FRESH;
    mocks.sandboxes = [
      sandboxSummaryFixture({
        id: SANDBOX_ID,
        hostId: SANDBOX_HOST,
        state: "failed",
        failureCode: "PROVIDER_CREATE_FAILED",
      }),
    ];
    answerHost(SANDBOX_HOST, CODEX_READY);
    mount();

    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    expect(mocks.wake).not.toHaveBeenCalled();
    expectSendRecovered("chat");
  });
});

describe("a message for an existing chat whose sandbox rests", () => {
  const FRESH = Date.now() + 60_000;
  const MESSAGE_REQUEST = { kind: "message", chatId: "existing-chat" } as const;

  function rowIn(state: "suspended" | "stopped" | "awake"): SandboxSummary {
    return sandboxSummaryFixture({
      id: SANDBOX_ID,
      hostId: SANDBOX_HOST,
      state,
    });
  }

  it.each([
    ["suspended", RESUME_TARGET],
    ["stopped", START_TARGET],
  ] as const)(
    "returns the message to the chat's composer when a %s sandbox rests past handoff: no wake, no dispatch, no new chat",
    async (state, target) => {
      const restoreLocks = installImmediateExclusiveLocks();
      try {
        seed({
          ...SEEDED,
          target,
          send: { request: MESSAGE_REQUEST },
          phase: "handoff",
          created: true,
        });
        mocks.listReadAt = FRESH;
        mocks.sandboxes = [rowIn(state)];
        answerHost(SANDBOX_HOST, CODEX_READY);
        mountInChat();

        await waitFor(() => {
          expect(usePendingSandboxSendStore.getState().sends).toEqual({});
        });
        expect(
          useComposerDraftStore.getState().drafts["existing-chat"]?.content,
        ).toEqual(MESSAGE_CONTENT);
        expect(mocks.wake).not.toHaveBeenCalled();
        expect(createChatCalls()).toEqual([]);
        expect(mocks.createSandbox).not.toHaveBeenCalled();
      } finally {
        restoreLocks();
      }
    },
  );

  describe("refused by its woken sandbox", () => {
    const BOUND_REMEDIES = [
      "Choose a model",
      "Open terminal instead",
      "Choose another host",
      "Cancel the message",
      "Details",
    ];

    function seedRefused(answers: HostAnswers): void {
      seed({
        ...SEEDED,
        target: RESUME_TARGET,
        send: { request: MESSAGE_REQUEST },
        phase: "handoff",
        created: true,
      });
      mocks.wake.mockResolvedValue({ kind: "awake" });
      mocks.listReadAt = FRESH;
      mocks.sandboxes = [rowIn("awake")];
      mocks.listSandboxes.mockResolvedValue(listAnswers([rowIn("awake")]));
      answerHost(SANDBOX_HOST, answers);
    }

    async function refusalLine(
      failure: Partial<StagedSandboxFailure>,
    ): Promise<HTMLElement> {
      const line = await screen.findByTestId("sandbox-refusal-line");
      await waitFor(() => {
        expect(readStagedSandbox(SURFACE)?.failure).toMatchObject(failure);
      });
      return line;
    }

    const NOT_OFFERED: StagedSandboxFailure = {
      kind: "agent-not-offered",
      harnessId: "codex",
    };

    it.each([
      ["an agent sandboxes don't offer", CODEX_NOT_OFFERED, NOT_OFFERED],
      ["its own Traycer Inference off", TRAYCER_OFF, { kind: "traycer-off" }],
      ["no agent it can run", CODEX_UNAVAILABLE, { kind: "no-provider" }],
      ["a failed install", CODEX_SETUP_FAILED, { kind: "agent-setup-failed" }],
    ] as const)(
      "offers the bound chat's remedies in order, and no shape change, for %s",
      async (_label, answers, failure) => {
        const restoreLocks = installImmediateExclusiveLocks();
        try {
          seedRefused(answers);
          mountInChat();

          const line = await refusalLine(failure);

          await waitFor(() => {
            expect(
              within(line)
                .getAllByRole("button")
                .map((button) => button.textContent)
                .filter((label) => BOUND_REMEDIES.includes(label)),
            ).toEqual(BOUND_REMEDIES);
          });
          expect(
            within(line).queryByRole("button", { name: /Change shape/ }),
          ).toBeNull();
          expect(createChatCalls()).toEqual([]);
        } finally {
          restoreLocks();
        }
      },
    );

    it("Choose another host hands the message back to the chat's composer, then opens the chat's clone flow", async () => {
      const restoreLocks = installImmediateExclusiveLocks();
      const openClone = vi.fn<() => void>();
      const unregister = registerChatCloneOpener("existing-chat", openClone);
      try {
        seedRefused(CODEX_NOT_OFFERED);
        mountInChat();
        const line = await refusalLine(NOT_OFFERED);

        fireEvent.click(
          await within(line).findByRole("button", {
            name: "Choose another host",
          }),
        );

        await waitFor(() => {
          expect(openClone).toHaveBeenCalledOnce();
        });
        expect(usePendingSandboxSendStore.getState().sends).toEqual({});
        expect(
          useComposerDraftStore.getState().drafts["existing-chat"]?.content,
        ).toEqual(MESSAGE_CONTENT);
        expect(createChatCalls()).toEqual([]);
      } finally {
        unregister();
        restoreLocks();
      }
    });

    it("Choose a model hands the message back to the chat's composer and opens its picker on Traycer", async () => {
      const restoreLocks = installImmediateExclusiveLocks();
      const openForHarness =
        vi.fn<
          (
            harnessId: string,
            offeredAgents: ReadonlyArray<string> | null,
          ) => void
        >();
      const unregister = registerActiveModelPicker({
        toggle: () => undefined,
        openForHarness,
        getSelectionSummary: () => null,
      });
      try {
        seedRefused(CODEX_NOT_OFFERED);
        mountInChat();
        const line = await refusalLine(NOT_OFFERED);

        fireEvent.click(
          await within(line).findByRole("button", { name: "Choose a model" }),
        );

        expect(openForHarness).toHaveBeenCalledWith("traycer", null);
        await waitFor(() => {
          expect(usePendingSandboxSendStore.getState().sends).toEqual({});
        });
        expect(
          useComposerDraftStore.getState().drafts["existing-chat"]?.content,
        ).toEqual(MESSAGE_CONTENT);
      } finally {
        unregister();
        restoreLocks();
      }
    });
  });

  describe("cancelling while its sandbox rests", () => {
    const OCCUPIED_CHAT_DOC = {
      type: "doc" as const,
      content: [
        {
          type: "paragraph" as const,
          content: [{ type: "text" as const, text: "keep my newer draft" }],
        },
      ],
    };

    function seedWaking(): void {
      seed({
        ...SEEDED,
        target: RESUME_TARGET,
        send: { request: MESSAGE_REQUEST },
        phase: "handoff",
        created: true,
      });
      mocks.wake.mockReturnValue(new Promise(() => undefined));
      mocks.listReadAt = FRESH;
      mocks.sandboxes = [rowIn("suspended")];
      answerHost(SANDBOX_HOST, CODEX_READY);
      // Cancel is an exit of a failed or timed-out wake only: the
      // failure is on the stage before mount, which also auto-expands it.
      useStagedSandboxStore.getState().report(SURFACE, {
        failure: { kind: "timed-out", step: "booting" },
      });
    }

    afterEach(() => {
      handoffHold.held = null;
    });

    it("returns the message to the chat's composer on its own when the sandbox rests, and never sends", async () => {
      const restoreLocks = installImmediateExclusiveLocks();
      try {
        seedWaking();
        mountInChat();

        await waitFor(() =>
          expect(usePendingSandboxSendStore.getState().sends).toEqual({}),
        );
        expect(
          useComposerDraftStore.getState().drafts["existing-chat"]?.content,
        ).toEqual(MESSAGE_CONTENT);
        expect(mocks.wake).not.toHaveBeenCalled();
        expect(createChatCalls()).toEqual([]);
      } finally {
        restoreLocks();
      }
    });

    it("shows a busy, disabled Cancel with 'Returning your message…' while the saved-draft import is held, then the saved-drafts receipt with Open draft", async () => {
      const restoreLocks = installImmediateExclusiveLocks();
      try {
        useComposerDraftStore
          .getState()
          .replaceDraft("existing-chat", OCCUPIED_CHAT_DOC, null);
        let releaseHold: () => void = () => undefined;
        handoffHold.held = new Promise<void>((resolve) => {
          releaseHold = resolve;
        });
        seedWaking();
        mountInChat();

        fireEvent.click(
          await screen.findByRole("button", { name: "Cancel the message" }),
        );

        const cancel = await screen.findByRole("button", {
          name: "Cancel the message",
        });
        expect(cancel.getAttribute("aria-busy")).toBe("true");
        expect(cancel.hasAttribute("disabled")).toBe(true);
        expect(screen.getByText("Returning your message…")).toBeDefined();
        // Held: the record is still the message's only copy and nothing woke or sent.
        expect(
          usePendingSandboxSendStore.getState().sends[SEND_ID],
        ).toBeDefined();
        expect(createChatCalls()).toEqual([]);

        releaseHold();

        await waitFor(() =>
          expect(usePendingSandboxSendStore.getState().sends).toEqual({}),
        );
        expect(
          screen.getByText(
            "Your message wasn't sent; it's saved in your drafts.",
          ),
        ).toBeDefined();
        expect(
          screen.getByRole("button", { name: "Open draft" }),
        ).toBeDefined();
        expect(
          useComposerDraftStore.getState().drafts["existing-chat"]?.content,
        ).toEqual(OCCUPIED_CHAT_DOC);
      } finally {
        restoreLocks();
      }
    });

    it("resumes a return that was requested before a reload: saves the draft, never wakes or sends it", async () => {
      const restoreLocks = installImmediateExclusiveLocks();
      try {
        seedWaking();
        usePendingSandboxSendStore.setState((state) => ({
          sends: {
            ...state.sends,
            [SEND_ID]: {
              ...state.sends[SEND_ID],
              returnRequested: { saveInDrafts: true },
            },
          },
        }));
        await reloadPendingSandboxStores();
        mountInChat();

        await waitFor(() =>
          expect(usePendingSandboxSendStore.getState().sends).toEqual({}),
        );
        const saved = useLandingDraftStore.getState().drafts;
        expect(saved).toHaveLength(1);
        expect(saved[0]?.closed).toBe(true);
        // The handoff appends its Unsent qualification, so the original text
        // is retained rather than the document being equal to it.
        expect(JSON.stringify(saved[0]?.content)).toContain(
          "fix the login bug",
        );
        expect(mocks.wake).not.toHaveBeenCalled();
        expect(createChatCalls()).toEqual([]);
      } finally {
        restoreLocks();
      }
    });

    // The sandbox decision was made when the return began, by Choose another
    // host (none) or Cancel (the sandbox): the driver finishing it after a
    // reload keeps that decision, whatever the stage now says.
    it.each([
      ["no sandbox, as Choose another host decided", null],
      [
        "the sandbox, as Cancel decided",
        { target: RESUME_TARGET, clientRequestId: null },
      ],
    ] as const)(
      "resumes a return requested before a reload with %s on its saved draft",
      async (_label, destination) => {
        const restoreLocks = installImmediateExclusiveLocks();
        try {
          seedWaking();
          useComposerDraftStore
            .getState()
            .replaceDraft("existing-chat", OCCUPIED_CHAT_DOC, null);
          usePendingSandboxSendStore.setState((state) => ({
            sends: {
              ...state.sends,
              [SEND_ID]: {
                ...state.sends[SEND_ID],
                returnRequested: { saveInDrafts: false, destination },
              },
            },
          }));
          await reloadPendingSandboxStores();
          mountInChat();

          await waitFor(() =>
            expect(usePendingSandboxSendStore.getState().sends).toEqual({}),
          );
          const saved = useLandingDraftStore.getState().drafts;
          expect(saved).toHaveLength(1);
          expect(saved[0]?.returnedSandbox ?? null).toEqual(
            destination === null ? null : expect.objectContaining(destination),
          );
        } finally {
          restoreLocks();
        }
      },
    );
  });

  describe("once its sandbox is awake", () => {
    let session: MessageSessionHarness;

    beforeEach(() => {
      session = createMessageSessionHarness({
        epicId: "epic-1",
        chatId: "existing-chat",
        hostId: SANDBOX_HOST,
        userId: "user-1",
        settings: PICKED_SETTINGS,
      });
      sessionBridge.handle = session.handle;
    });

    afterEach(() => {
      sessionBridge.handle = null;
    });

    function seedAwakeMessage(): void {
      seed({
        ...SEEDED,
        target: RESUME_TARGET,
        send: { request: MESSAGE_REQUEST },
        phase: "handoff",
        created: true,
      });
      mocks.wake.mockResolvedValue({ kind: "awake" });
      mocks.listReadAt = FRESH;
      mocks.sandboxes = [rowIn("awake")];
      mocks.listSandboxes.mockResolvedValue(listAnswers([rowIn("awake")]));
      answerHost(SANDBOX_HOST, CODEX_READY);
    }

    function sendFrames() {
      return session.sent.filter((frame) => frame.kind === "send");
    }

    /** The one action the session is waiting on. */
    function onlyPendingActionId(): string {
      const ids = Object.keys(session.handle.store.getState().pendingActions);
      expect(ids).toHaveLength(1);
      return ids.join("");
    }

    it("sends the one message through the chat's own session and keeps the record until the host accepts it", async () => {
      seedAwakeMessage();
      session.openAsOwner();
      mount();

      await waitFor(() => {
        expect(sendFrames()).toHaveLength(1);
      });
      expect(createChatCalls()).toEqual([]);
      // Sent is not delivered: the record stays, undelivered, until the ack.
      expect(
        usePendingSandboxSendStore.getState().sends[SEND_ID].delivery,
      ).toBeNull();

      session.acknowledgeSend(onlyPendingActionId());

      await waitFor(() => {
        const { sends } = usePendingSandboxSendStore.getState();
        expect(
          Object.hasOwn(sends, SEND_ID) && sends[SEND_ID].delivery === null,
        ).toBe(false);
      });
      expect(sendFrames()).toHaveLength(1);
    });

    it("owns a rejection of its message: one staged Not sent, no automatic second send, and the composer is not restored behind it", async () => {
      seedAwakeMessage();
      session.openAsOwner();
      mountInChat();

      await waitFor(() => {
        expect(sendFrames()).toHaveLength(1);
      });
      session.rejectSend(onlyPendingActionId(), "the host refused it");

      await waitFor(() => {
        expect(readStagedSandbox(SURFACE)?.failure).toEqual({
          kind: "not-sent",
        });
      });
      await act(async () => {
        await Promise.resolve();
      });
      // The durable pending message owns the rejection: the generic restore
      // must not also put it back in the chat's composer, and nothing resends.
      expect(sendFrames()).toHaveLength(1);
      expect(Object.keys(usePendingSandboxSendStore.getState().sends)).toEqual([
        SEND_ID,
      ]);
      expect(
        useComposerDraftStore.getState().drafts["existing-chat"]?.content ??
          null,
      ).not.toEqual(MESSAGE_CONTENT);
      expect(createChatCalls()).toEqual([]);
    });

    it("keeps its own rejection when an ordinary send already holds the restoration slot: one Not sent, no retry, the first send's restoration untouched, no duplicate recovery copy", async () => {
      seedAwakeMessage();
      session.openAsOwner();
      const ordinary = session.handle.store.getState().sendMessage({
        content: MESSAGE_CONTENT,
        sender: { type: "user", userId: "user-1" },
        settings: PICKED_SETTINGS,
        attachments: [],
        deliveryPolicy: "auto",
        restore: { content: MESSAGE_CONTENT, browserAnnotations: [] },
      });
      if (ordinary === null) throw new Error("expected the ordinary send");
      session.rejectSend(ordinary.clientActionId, "the first was refused");
      expect(
        session.handle.store.getState().failedSendRestoration?.clientActionId,
      ).toBe(ordinary.clientActionId);

      mountInChat();
      await waitFor(() => {
        expect(sendFrames()).toHaveLength(2);
      });
      const boundActionId = onlyPendingActionId();
      session.rejectSend(boundActionId, "the bound one was refused");

      await waitFor(() => {
        expect(readStagedSandbox(SURFACE)?.failure).toEqual({
          kind: "not-sent",
        });
      });
      await act(async () => {
        await Promise.resolve();
      });
      const state = session.handle.store.getState();
      // The durable record keeps the bound message; nothing retried it.
      expect(sendFrames()).toHaveLength(2);
      expect(Object.keys(usePendingSandboxSendStore.getState().sends)).toEqual([
        SEND_ID,
      ]);
      // The ordinary send still owns the slot, unconsumed, and the bound
      // rejection left no second recovery copy behind.
      expect(state.failedSendRestoration?.clientActionId).toBe(
        ordinary.clientActionId,
      );
      expect(Object.hasOwn(state.lastCopyPrompts, boundActionId)).toBe(false);
      expect(
        state.errorNotices.some(
          (notice) => notice.clientActionId === boundActionId,
        ),
      ).toBe(false);
      expect(createChatCalls()).toEqual([]);
    });

    it("sends once for a chat bound to OpenCode 1 even though the destination's new-chat Managed 2 setup failed", async () => {
      const traycerSettings = {
        ...PICKED_SETTINGS,
        harnessId: "traycer",
      } as const;
      session = createMessageSessionHarness({
        epicId: "epic-1",
        chatId: "existing-chat",
        hostId: SANDBOX_HOST,
        userId: "user-1",
        settings: traycerSettings,
      });
      sessionBridge.handle = session.handle;
      seed({
        ...SEEDED,
        target: RESUME_TARGET,
        send: { request: MESSAGE_REQUEST, settings: traycerSettings },
        phase: "handoff",
        created: true,
      });
      mocks.wake.mockResolvedValue({ kind: "awake" });
      mocks.listReadAt = FRESH;
      mocks.sandboxes = [rowIn("awake")];
      mocks.listSandboxes.mockResolvedValue(listAnswers([rowIn("awake")]));
      // Managed 1 is installed; the line a new chat would start on, Managed 2,
      // failed to set up. The chat itself is recorded on line 1.
      answerHost(SANDBOX_HOST, {
        harnesses: [harnessRow("traycer", {})],
        providers: [
          providerRow("traycer", { status: "installed" }),
          opencodeProviderRow(
            {
              status: "error",
              reason: "disk-full",
              message: "ENOSPC",
              retryAtMs: null,
            },
            {},
          ),
        ],
      });
      session.openAsOwner();
      session.handle.store.setState((state) =>
        state.chat === null
          ? state
          : { chat: { ...state.chat, opencodeLine: 1 } },
      );
      expect(session.handle.store.getState().chat?.opencodeLine).toBe(1);
      mount();

      await waitFor(() => {
        expect(sendFrames()).toHaveLength(1);
      });
      expect(readStagedSandbox(SURFACE)?.failure).toBeNull();
      expect(createChatCalls()).toEqual([]);
    });

    it("keeps the same message and action ids when the driver mounts again before any acknowledgement", async () => {
      seedAwakeMessage();
      session.openAsOwner();
      const first = mount();

      await waitFor(() => {
        expect(sendFrames()).toHaveLength(1);
      });
      first.unmount();
      mount();
      await act(async () => {
        await Promise.resolve();
      });

      const ids = new Set(sendFrames().map((frame) => frame.messageId));
      expect([...ids]).toHaveLength(1);
      expect(
        Object.keys(session.handle.store.getState().pendingActions),
      ).toHaveLength(1);
      expect(createChatCalls()).toEqual([]);
    });
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
  it("does not reopen a model picker when a pending fork's sandbox lacks its agent", async () => {
    seed({ ...SEEDED, send: { request: FORK_REQUEST } });
    answerHost(SANDBOX_HOST, CODEX_NOT_OFFERED);
    mount();

    await waitFor(() => {
      expect(readStagedSandbox(SURFACE)?.failure).toEqual({
        kind: "agent-not-offered",
        harnessId: "codex",
      });
    });
    const line = screen.getByTestId("sandbox-refusal-line");
    expect(
      within(line).queryByRole("button", { name: "Choose a model" }),
    ).toBeNull();
    expect(createChatCalls()).toEqual([]);
    expect(
      usePendingSandboxSendStore.getState().sends[SEND_ID]?.request,
    ).toEqual(FORK_REQUEST);
  });

  it("withdraws a fork whose sandbox rests past handoff and wakes nothing", async () => {
    onTestFinished(installImmediateExclusiveLocks());
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
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    expect(mocks.wake).not.toHaveBeenCalled();
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

  it("shows only the setup line and the message until the remote sandbox accepts the create, and registers the agent's handoff, with no pending chat title, only once it does", async () => {
    seed(SEEDED);
    const create = deferred<CreateChatResponseV12>();
    mocks.createChatDeferred = create.promise;
    answerHost(SANDBOX_HOST, CODEX_READY);
    mount();

    let chatId = "";
    try {
      await waitForCreateChats(1);
      chatId = createChatCalls()[0]?.input.chatId ?? "";
      await waitFor(() => {
        expect(
          usePendingSandboxSendStore.getState().sends[SEND_ID]?.dispatch,
        ).toMatchObject({ status: "sending" });
      });
      expect(screen.getByTestId("sandbox-setup-line")).toBeDefined();
      expect(screen.getByTestId("pending-sandbox-message").textContent).toBe(
        "fix the login bug",
      );
      expect(screen.queryByTestId("pending-sandbox-dispatch")).toBeNull();
      expect(screen.queryByText("Waiting for the sandbox…")).toBeNull();
      // The agent's tile opens from the handoff; none is registered yet.
      expect(useInitialChatHandoffStore.getState().handoffs).toEqual({});
      expect(
        useEpicCanvasStore.getState().pendingChatTitles[chatId],
      ).toBeUndefined();
    } finally {
      await resolvePendingCreate(create);
    }
    await waitFor(() => {
      expect(
        Object.values(useInitialChatHandoffStore.getState().handoffs),
      ).toMatchObject([{ epicId: "epic-1", hostId: SANDBOX_HOST, chatId }]);
    });
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
              usePendingSandboxSendStore.getState().sends[SEND_ID]?.dispatch,
            ).toMatchObject({ status: "sending" });
          });
          expect(screen.getByTestId("sandbox-setup-line")).toBeDefined();
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

describe("cancelling a refused pending message", () => {
  it.each([false, true])(
    "returns the message with occupied composer=%s and leaves its sandbox alone",
    async (occupied) => {
      const restoreLocks = installImmediateExclusiveLocks();
      try {
        seed(SEEDED);
        answerHost(SANDBOX_HOST, CODEX_UNAVAILABLE);
        if (occupied)
          useNewConversationModalStore
            .getState()
            .setContent("epic-1", OCCUPIED_NEW_CHAT_CONTENT);
        mount();
        const line = await screen.findByTestId("sandbox-refusal-line");
        fireEvent.click(
          within(line).getByRole("button", { name: "Cancel the message" }),
        );
        await waitFor(() =>
          expect(usePendingSandboxSendStore.getState().sends).toEqual({}),
        );
        expect(readStagedSandbox(SURFACE)).toBeNull();
        // The sandbox rests after the cancel: the receipt stays the cancel's.
        const resting = sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: SANDBOX_HOST,
          state: "suspended",
        });
        answerSandboxRows([resting], Date.now() + 120_000);
        const receipt = occupied
          ? "Your message wasn't sent; it's saved in your drafts."
          : "Your message wasn't sent; it's back in the composer.";
        expect(screen.getByText(receipt)).toBeDefined();
        expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
        expect(
          screen.queryByRole("button", { name: "Choose another host" }),
        ).toBeNull();
        if (occupied) {
          expect(
            useNewConversationModalStore.getState().draftPatchesByEpicId[
              "epic-1"
            ],
          ).toMatchObject({ content: OCCUPIED_NEW_CHAT_CONTENT });
          expect(useLandingDraftStore.getState().drafts).toMatchObject([
            {
              content: MESSAGE_CONTENT,
              settings: PICKED_SETTINGS,
              closed: true,
            },
          ]);
          expect(
            useNewConversationModalOpenStore.getState().request,
          ).toBeNull();
          const draft = useLandingDraftStore.getState().drafts[0];
          fireEvent.click(screen.getByRole("button", { name: "Open draft" }));
          expect(useLandingDraftStore.getState().activeDraftId).toBe(draft.id);
        } else {
          expect(
            useNewConversationModalStore.getState().draftPatchesByEpicId[
              "epic-1"
            ],
          ).toMatchObject({
            content: MESSAGE_CONTENT,
            settings: PICKED_SETTINGS,
          });
          expect(
            useNewConversationModalOpenStore.getState().request,
          ).toMatchObject({ epicId: "epic-1", tabId: "tab-1", hostId: null });
          // Still on the resting sandbox: the task draft records it for its
          // composer to stage, so the composer's Send wakes it. Nothing is
          // staged until that composer shows it.
          expect(
            useNewConversationModalStore.getState().draftPatchesByEpicId[
              "epic-1"
            ]?.returnedSandbox,
          ).toMatchObject({
            target: { kind: "existing", sandboxId: SANDBOX_ID, verb: "resume" },
            clientRequestId: null,
          });
          expect(
            readStagedSandbox(newConversationSurfaceKey("epic-1")),
          ).toBeNull();
          expect(
            screen.getByRole("button", { name: "Open draft" }),
          ).toBeDefined();
          answerSandboxRows(
            [{ ...resting, state: "awake" }],
            Date.now() + 120_001,
          );
          expect(screen.getByText(receipt)).toBeDefined();
        }
        expect(mocks.wake).not.toHaveBeenCalled();
        expect(mocks.stopSandbox).not.toHaveBeenCalled();
        expect(mocks.createSandbox).not.toHaveBeenCalled();
        expect(createChatCalls()).toEqual([]);
      } finally {
        restoreLocks();
      }
    },
  );
});

describe("cancelling a send whose create was accepted but not answered", () => {
  it("keeps the create's key on the task composer, so its next Send names the same sandbox", async () => {
    const restoreLocks = installImmediateExclusiveLocks();
    try {
      seed({ ...SEEDED, phase: "creating", created: false });
      const key = readStagedSandbox(SURFACE)?.clientRequestId;
      if (key === null || key === undefined)
        throw new Error("expected the create's key");
      const creation = deferred<SandboxCreateFetchResult>();
      mocks.createSandbox.mockReturnValue(creation.promise);
      mount();
      // The create still unanswered past its wait: the line offers Cancel.
      act(() => {
        useStagedSandboxStore.getState().report(SURFACE, {
          failure: { kind: "timed-out", step: "creating" },
        });
      });
      const cancel = await screen.findByRole("button", {
        name: "Cancel the message",
      });
      await waitFor(() => expect(cancel).not.toHaveProperty("disabled", true));

      fireEvent.click(cancel);

      await waitFor(() =>
        expect(usePendingSandboxSendStore.getState().sends).toEqual({}),
      );
      const taskSurface = newConversationSurfaceKey("epic-1");
      // The task draft records the sandbox and the create's key; nothing is
      // staged until its composer shows it.
      expect(
        useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"]
          ?.returnedSandbox,
      ).toMatchObject({ target: NEW_TARGET, clientRequestId: key });
      expect(readStagedSandbox(taskSurface)).toBeNull();
      // A reload before the Send. Reopened from Drafts, the draft brings the
      // sandbox back, key and all.
      await reloadPendingSandboxStores();
      await reloadTaskDrafts();
      expect(readStagedSandbox(taskSurface)).toBeNull();
      mount();
      act(() => {
        openNewChatDraftRow(navigateNowhere, {
          epicId: "epic-1",
          epicTitle: null,
          ownerHostId: "owner-host",
        });
      });
      const reopened = useNewConversationModalOpenStore.getState().request;
      expect(reopened).toMatchObject({ epicId: "epic-1", hostId: null });
      renderHook(() =>
        useNewConversationReturnedSandbox("epic-1", reopened?.hostId ?? null),
      );
      expect(readStagedSandbox(taskSurface)).toMatchObject({
        phase: "staged",
        clientRequestId: key,
        target: NEW_TARGET,
      });

      const createsBeforeSend = mocks.createSandbox.mock.calls.length;
      // The composer's Send hands its stage over, as the modal does.
      act(() => {
        handPendingSandboxSend({
          fromSurfaceKey: taskSurface,
          epicId: "epic-1",
          request: { kind: "chat", parentId: null, placement: null },
          content: MESSAGE_CONTENT,
          text: "fix the login bug",
          settings: PICKED_SETTINGS,
          epicConfirmed: true,
          now: Date.now(),
        });
      });

      await waitFor(() =>
        expect(usePendingSandboxSendStore.getState().sends).not.toEqual({}),
      );
      const handed = Object.values(
        usePendingSandboxSendStore.getState().sends,
      )[0];
      await waitFor(() =>
        expect(mocks.createSandbox.mock.calls.length).toBeGreaterThan(
          createsBeforeSend,
        ),
      );
      // The Send's create names the accepted one again.
      expect(
        mocks.createSandbox.mock.calls
          .slice(createsBeforeSend)
          .map(([request]) => request.clientRequestId),
      ).toEqual([key]);
      expect(
        readStagedSandbox(pendingSendSurfaceKey(handed.id))?.clientRequestId,
      ).toBe(key);
      await act(async () => {
        creation.resolve(CREDITS_REFUSED);
        await creation.promise;
      });
    } finally {
      restoreLocks();
    }
  });
});

describe("cancelling a send whose sandbox was never created, with the same sandbox picked again", () => {
  it("leaves the person's new pick in the task's composer, and saves the message in drafts", async () => {
    const restoreLocks = installImmediateExclusiveLocks();
    try {
      seed({ ...SEEDED, phase: "creating", created: false });
      const creation = deferred<SandboxCreateFetchResult>();
      mocks.createSandbox.mockReturnValue(creation.promise);
      mount();
      act(() => {
        useStagedSandboxStore.getState().report(SURFACE, {
          failure: { kind: "timed-out", step: "creating" },
        });
      });
      // The person picks a new sandbox with the same name and shape: a new
      // one, which no create has named yet.
      const taskSurface = newConversationSurfaceKey("epic-1");
      act(() => {
        useStagedSandboxStore.getState().stage(taskSurface, NEW_TARGET);
      });
      const cancel = await screen.findByRole("button", {
        name: "Cancel the message",
      });
      await waitFor(() => expect(cancel).not.toHaveProperty("disabled", true));

      fireEvent.click(cancel);

      await waitFor(() =>
        expect(usePendingSandboxSendStore.getState().sends).toEqual({}),
      );
      expect(readStagedSandbox(taskSurface)).toMatchObject({
        phase: "staged",
        target: NEW_TARGET,
        clientRequestId: null,
      });
      expect(useLandingDraftStore.getState().drafts).toMatchObject([
        { content: MESSAGE_CONTENT, settings: PICKED_SETTINGS, closed: true },
      ]);
      expect(
        useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"],
      ).toBeUndefined();
      await act(async () => {
        creation.resolve(CREDITS_REFUSED);
        await creation.promise;
      });
    } finally {
      restoreLocks();
    }
  });
});

describe("a message whose sandbox may still be created, put in a draft", () => {
  it("keeps the create's key on the draft when Cancel finds the task's composer holding another message", async () => {
    const restoreLocks = installImmediateExclusiveLocks();
    try {
      seed({ ...SEEDED, phase: "creating", created: false });
      const key = readStagedSandbox(SURFACE)?.clientRequestId;
      const creation = deferred<SandboxCreateFetchResult>();
      mocks.createSandbox.mockReturnValue(creation.promise);
      useNewConversationModalStore
        .getState()
        .setContent("epic-1", OCCUPIED_NEW_CHAT_CONTENT);
      mount();
      act(() => {
        useStagedSandboxStore.getState().report(SURFACE, {
          failure: { kind: "timed-out", step: "creating" },
        });
      });
      const cancel = await screen.findByRole("button", {
        name: "Cancel the message",
      });
      await waitFor(() => expect(cancel).not.toHaveProperty("disabled", true));
      const before = composerStages();

      fireEvent.click(cancel);

      await waitFor(() =>
        expect(usePendingSandboxSendStore.getState().sends).toEqual({}),
      );
      expect(useLandingDraftStore.getState().drafts).toMatchObject([
        {
          content: MESSAGE_CONTENT,
          returnedSandbox: { target: NEW_TARGET, clientRequestId: key },
        },
      ]);
      expectOnlyTheRecordWritten(before);
      await act(async () => {
        creation.resolve(CREDITS_REFUSED);
        await creation.promise;
      });
    } finally {
      restoreLocks();
    }
  });

  it("keeps the sandbox and the create's key on the draft when its task is deleted", async () => {
    const restoreLocks = installImmediateExclusiveLocks();
    try {
      seed({ ...SEEDED, phase: "creating", created: false });
      const key = readStagedSandbox(SURFACE)?.clientRequestId;
      const before = composerStages();

      recoverPendingSandboxSendsAfterTaskLoss(["epic-1"], "user-1");

      await waitFor(() =>
        expect(usePendingSandboxSendStore.getState().sends).toEqual({}),
      );
      expect(useLandingDraftStore.getState().drafts).toMatchObject([
        {
          content: MESSAGE_CONTENT,
          returnedSandbox: { target: NEW_TARGET, clientRequestId: key },
        },
      ]);
      expectOnlyTheRecordWritten(before);
    } finally {
      restoreLocks();
    }
  });

  it("keeps the awake sandbox on the draft when its task is deleted and the first draft write fails", async () => {
    const restoreLocks = installImmediateExclusiveLocks();
    const install = useLandingDraftStore.getState().installLandingDraft;
    let writes = 0;
    useLandingDraftStore.setState({
      installLandingDraft: (draft) => {
        writes += 1;
        if (writes === 1) throw new Error("storage full");
        return install(draft);
      },
    });
    try {
      seed({ ...SEEDED, phase: "creating", created: true });
      const awake = sandboxSummaryFixture({
        id: SANDBOX_ID,
        hostId: SANDBOX_HOST,
        state: "awake",
      });
      mocks.listSandboxes.mockResolvedValue(listAnswers([awake]));
      answerSandboxRows([awake], Date.now() + 60_000);
      mount();
      await screen.findByTestId("pending-sandbox-sends");
      const before = composerStages();

      recoverPendingSandboxSendsAfterTaskLoss(["epic-1"], "user-1");

      await waitFor(() =>
        expect(usePendingSandboxSendStore.getState().sends).toEqual({}),
      );
      expect(writes).toBe(2);
      expect(useLandingDraftStore.getState().drafts).toMatchObject([
        {
          content: MESSAGE_CONTENT,
          returnedSandbox: {
            target: {
              kind: "existing",
              hostId: SANDBOX_HOST,
              sandboxId: SANDBOX_ID,
            },
            clientRequestId: null,
          },
        },
      ]);
      expectOnlyTheRecordWritten(before);
    } finally {
      useLandingDraftStore.setState({ installLandingDraft: install });
      restoreLocks();
    }
  });
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
    // Subscribed to the host's cache, but only the kernel's fetch starts a read.
    expect(
      mocks.modelReads.some(
        (read) =>
          read.hostId === SANDBOX_HOST && !read.enabled && read.subscribed,
      ),
    ).toBe(true);
    expect(mocks.modelRefetches).toContain(SANDBOX_HOST);
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
    // The catalog was read before, and its latest refresh failed.
    mocks.modelCache.set(SANDBOX_HOST, {
      data: [{ slug: "cached-default-model" }],
      isError: true,
    });
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

  it("refetches the catalog on Retry after the first read failed, and sends with the default it then lists", async () => {
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
    const retry = within(screen.getByTestId("sandbox-refusal-line")).getByRole(
      "button",
      { name: "Retry" },
    );

    mocks.modelReadErrorHosts.delete(SANDBOX_HOST);
    mocks.modelsByHost.set(SANDBOX_HOST, [{ slug: "host-default-model" }]);
    fireEvent.click(retry);

    await waitForCreateChats(1);
    expect(mocks.modelRefetches).toContain(SANDBOX_HOST);
    expect(createChatCalls()[0]?.input.settings?.model).toBe(
      "host-default-model",
    );
  });

  it.each([
    ["no-provider", CODEX_UNAVAILABLE, { kind: "no-provider" }],
    ["agent-setup-failed", CODEX_SETUP_FAILED, { kind: "agent-setup-failed" }],
  ] as const)(
    "says the %s remedy and keeps polling the agent while the model read has failed",
    async (_label, answers, failure) => {
      seed({
        ...SEEDED,
        send: { settings: { ...PICKED_SETTINGS, model: "" } },
      });
      mocks.modelReadErrorHosts.add(SANDBOX_HOST);
      // The model read failed before the agent was ready to be asked.
      mocks.modelCache.set(SANDBOX_HOST, { data: undefined, isError: true });
      answerHost(SANDBOX_HOST, answers);
      mount();

      await waitFor(() => {
        expect(readStagedSandbox(SURFACE)?.failure).toMatchObject(failure);
      });
      expect(createChatCalls()).toEqual([]);
      const polled = mocks.harnessRefetches;
      await waitFor(
        () => {
          expect(mocks.harnessRefetches).toBeGreaterThan(polled);
        },
        { timeout: 5_000 },
      );
    },
  );

  it.each([
    ["a failed read", { data: undefined, isError: true }],
    ["an empty catalog", { data: [], isError: false }],
  ] as const)(
    "reads the catalog afresh once for a new send when an earlier send left %s cached, before it can reach Not sent",
    async (_label, cached) => {
      seed({
        ...SEEDED,
        send: { settings: { ...PICKED_SETTINGS, model: "" } },
      });
      mocks.modelCache.set(SANDBOX_HOST, cached);
      mocks.modelsByHost.set(SANDBOX_HOST, [{ slug: "host-default-model" }]);
      answerHost(SANDBOX_HOST, CODEX_READY);
      mount();

      await waitForCreateChats(1);
      expect(mocks.modelRefetches).toEqual([SANDBOX_HOST]);
      expect(createChatCalls()[0]?.input.settings?.model).toBe(
        "host-default-model",
      );
      expect(readStagedSandbox(SURFACE)?.failure ?? null).toBeNull();
    },
  );

  it("refetches the catalog on Retry from a latched Not sent even when the sandbox row is not known, and dispatches only once a fresh row says awake", async () => {
    seed({
      ...SEEDED,
      send: { settings: { ...PICKED_SETTINGS, model: "" } },
    });
    // A list read before this page mounted: the row's freshness is unknown.
    mocks.listReadAt = 1;
    mocks.modelCache.set(SANDBOX_HOST, { data: undefined, isError: true });
    mocks.modelReadErrorHosts.add(SANDBOX_HOST);
    answerHost(SANDBOX_HOST, CODEX_READY);
    mount();
    await screen.findByTestId("sandbox-setup-line");
    act(() => {
      useStagedSandboxStore.getState().report(SURFACE, {
        failure: { kind: "not-sent" },
      });
    });
    const retry = within(
      await screen.findByTestId("sandbox-refusal-line"),
    ).getByRole("button", { name: "Retry" });
    const before = mocks.modelRefetches.length;
    mocks.modelReadErrorHosts.delete(SANDBOX_HOST);
    mocks.modelsByHost.set(SANDBOX_HOST, [{ slug: "host-default-model" }]);

    fireEvent.click(retry);

    await waitFor(() => {
      expect(mocks.modelRefetches.length).toBeGreaterThan(before);
    });
    expect(createChatCalls()).toEqual([]);

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
    await waitForCreateChats(1);
    expect(createChatCalls()[0]?.input.settings?.model).toBe(
      "host-default-model",
    );
  });

  describe("a Retry chosen in a window that does not own the send", () => {
    function latchNotSent(): void {
      seed({
        ...SEEDED,
        send: { settings: { ...PICKED_SETTINGS, model: "" } },
      });
      mocks.modelCache.set(SANDBOX_HOST, { data: undefined, isError: true });
      mocks.modelReadErrorHosts.add(SANDBOX_HOST);
      answerHost(SANDBOX_HOST, CODEX_READY);
    }

    it("persists a request on the stage and touches nothing, then the owner consumes it as one Retry that refetches and delivers", async () => {
      latchNotSent();
      const restoreQueued = queueBehindForeignHolder();
      try {
        const view = mount();
        await screen.findByTestId("sandbox-setup-line");
        act(() => {
          useStagedSandboxStore.getState().report(SURFACE, {
            failure: { kind: "not-sent" },
          });
        });
        const retry = within(
          await screen.findByTestId("sandbox-refusal-line"),
        ).getByRole("button", { name: "Retry" });
        // Queued behind a foreign holder: this window does not own the send.
        expect(ownsPendingSandboxSend(SEND_ID)).toBe(false);
        const before = mocks.modelRefetches.length;

        fireEvent.click(retry);

        await waitFor(() => {
          expect(readStagedSandbox(SURFACE)?.retryRequest).toMatchObject({
            userId: "user-1",
            action: "send-again",
          });
        });
        expect(mocks.modelRefetches.length).toBe(before);
        expect(mocks.wake).not.toHaveBeenCalled();
        expect(createChatCalls()).toEqual([]);
        expect(mocks.createSandbox).not.toHaveBeenCalled();
        view.unmount();
      } finally {
        restoreQueued();
      }

      // A window that owns the send takes the request up as one Retry.
      const requestId = readStagedSandbox(SURFACE)?.retryRequest?.id;
      const handled: Array<string | undefined> = [];
      const unsubscribe = useStagedSandboxStore.subscribe((state) => {
        handled.push(state.bySurface[SURFACE]?.retryHandledId);
      });
      const restoreLocks = installImmediateExclusiveLocks();
      try {
        mocks.modelReadErrorHosts.delete(SANDBOX_HOST);
        mocks.modelsByHost.set(SANDBOX_HOST, [{ slug: "host-default-model" }]);
        const before = mocks.modelRefetches.length;
        await reloadPendingSandboxStores();
        mount();

        await waitForCreateChats(1);
        expect(mocks.modelRefetches.length - before).toBe(1);
        expect(createChatCalls()[0]?.input.settings?.model).toBe(
          "host-default-model",
        );
        expect(requestId).toBeDefined();
        expect(handled).toContain(requestId);
      } finally {
        unsubscribe();
        restoreLocks();
      }
    });

    it("takes a request stored without an action as a send-again Retry", async () => {
      latchNotSent();
      useStagedSandboxStore.getState().report(SURFACE, {
        failure: { kind: "not-sent" },
      });
      const requestId = await useStagedSandboxStore
        .getState()
        .requestRetry(SURFACE, "user-1", "send-again");
      const registerKey = recordMapStorageKey(
        persistKey(STORE_KEYS.stagedSandboxSend),
        `retry-request:${SURFACE}`,
      );
      const stored: unknown = JSON.parse(
        localStorage.getItem(registerKey) ?? "",
      );
      if (typeof stored !== "object" || stored === null)
        throw new Error("the request was not stored");
      const { action: _action, ...legacy } = { action: undefined, ...stored };
      localStorage.setItem(registerKey, JSON.stringify(legacy));

      const handled: Array<string | undefined> = [];
      const unsubscribe = useStagedSandboxStore.subscribe((state) => {
        handled.push(state.bySurface[SURFACE]?.retryHandledId);
      });
      const restoreLocks = installImmediateExclusiveLocks();
      try {
        mocks.modelReadErrorHosts.delete(SANDBOX_HOST);
        mocks.modelsByHost.set(SANDBOX_HOST, [{ slug: "host-default-model" }]);
        const before = mocks.modelRefetches.length;
        await reloadPendingSandboxStores();
        expect(readStagedSandbox(SURFACE)?.retryRequest?.id).toBe(requestId);
        mount();

        await waitForCreateChats(1);
        expect(mocks.modelRefetches.length - before).toBe(1);
        expect(handled).toContain(requestId);
      } finally {
        unsubscribe();
        restoreLocks();
      }
    });

    it("records no request when the window's account is not the send's", async () => {
      latchNotSent();
      useAuthStore.getState().setSignedOut();
      useAuthStore
        .getState()
        .setSignedIn(
          { userId: "user-2", userName: "V", email: "v@example.com" },
          { userId: "user-2", username: "V" },
          [],
        );

      const foreign = await useStagedSandboxStore
        .getState()
        .requestRetry(SURFACE, "user-2", "send-again");
      const claimed = await useStagedSandboxStore
        .getState()
        .requestRetry(SURFACE, "user-1", "send-again");

      expect(foreign).toBeNull();
      expect(claimed).toBeNull();
      expect(readStagedSandbox(SURFACE)?.retryRequest).toBeUndefined();
    });
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

describe("a send whose created sandbox stalled on settings, on a host with only the guest-only repair", () => {
  const FRESH = Date.now() + 60_000;
  const ENVIRONMENT_FAILED = {
    principal: { kind: "personal" },
    items: [{ kind: "variable", status: "failed" }],
  } as const;

  async function mountStalled(
    guestConfigured: boolean | null,
    environmentFailed: boolean,
  ): Promise<void> {
    mocks.retrySupported = false;
    mocks.legacySupported = true;
    mocks.settingsStatus = environmentFailed ? ENVIRONMENT_FAILED : undefined;
    seed({
      ...SEEDED,
      send: SEND_BY_KIND.chat,
      phase: "creating",
      created: true,
    });
    const stalled = sandboxSummaryFixture({
      id: SANDBOX_ID,
      hostId: SANDBOX_HOST,
      state: "awake",
      guestConfigured,
    });
    mocks.listSandboxes.mockResolvedValue(listAnswers([stalled]));
    answerSandboxRows([stalled], FRESH);
    answerHost(SANDBOX_HOST, CODEX_READY);
    mount();
    await screen.findByTestId("pending-sandbox-sends");
    // A settings-only failure is not read off the row, so the stage reports it
    // as the setup line does once the environment says it did not apply.
    if (environmentFailed) {
      act(() => {
        useStagedSandboxStore.getState().report(SURFACE, {
          failure: { kind: "settings", code: "SBX-0520" },
        });
      });
    }
  }

  it("offers Repair setup, not Retry applying, for a guest that really failed, and runs only the guest repair", async () => {
    await mountStalled(false, false);

    const strip = screen.getByTestId("pending-sandbox-sends");
    await waitFor(() => {
      expect(strip.textContent).toMatch(/repair setup/i);
    });
    expect(strip.textContent).not.toMatch(/retry applying/i);
    fireEvent.click(screen.getByRole("button", { name: /repair setup/i }));

    expect(mocks.legacyMutate).toHaveBeenCalledTimes(1);
    expect(mocks.repairFinishers).toHaveLength(0);
    expect(createChatCalls()).toEqual([]);
    expect(mocks.wake).not.toHaveBeenCalled();
    expect(usePendingSandboxSendStore.getState().sends[SEND_ID]).toBeDefined();
  });

  it.each([
    ["a configured guest", true],
    ["an unknown guest", null],
  ])(
    "offers neither remedy when only the environment failed on %s",
    async (_name, guestConfigured) => {
      await mountStalled(guestConfigured, true);

      const strip = screen.getByTestId("pending-sandbox-sends");
      await waitFor(() => {
        expect(strip.textContent).toMatch(
          /didn't apply|waits until they apply/i,
        );
      });
      expect(strip.textContent).not.toMatch(/repair setup/i);
      expect(strip.textContent).not.toMatch(/retry applying/i);
    },
  );
});

describe("a send whose sandbox left awake on its own after the create timed out", () => {
  const FRESH = Date.now() + 60_000;
  let restoreLocks: () => void = () => undefined;
  beforeEach(() => {
    restoreLocks = installImmediateExclusiveLocks();
  });
  afterEach(() => {
    restoreLocks();
  });

  function rowIn(state: SandboxSummary["state"]): SandboxSummary {
    return sandboxSummaryFixture({
      id: SANDBOX_ID,
      hostId: SANDBOX_HOST,
      state,
      guestConfigured: true,
    });
  }

  async function mountTimedOut(): Promise<void> {
    seed({
      ...SEEDED,
      send: SEND_BY_KIND.chat,
      phase: "creating",
      created: true,
    });
    // Latched before the first render: the held send stops the run, so the
    // stage cannot hand off and deliver while the case is still arranging.
    useStagedSandboxStore.getState().report(SURFACE, {
      step: "applying",
      stepAt: Date.now(),
      failure: { kind: "timed-out", step: "applying" },
    });
    mocks.listSandboxes.mockResolvedValue(listAnswers([rowIn("awake")]));
    answerSandboxRows([rowIn("awake")], FRESH);
    answerHost(SANDBOX_HOST, CODEX_READY);
    mount();
    await screen.findByTestId("sandbox-setup-line");
    expect(document.body.textContent).toContain("compute is charged");
  }

  it("ends the create line, gives the message back on that sandbox and says it is suspended", async () => {
    await mountTimedOut();

    answerSandboxRows([rowIn("suspended")], FRESH + 1);

    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    expect(screen.queryByTestId("sandbox-setup-line")).toBeNull();
    expect(document.body.textContent).not.toContain("compute is charged");
    expect(document.body.textContent).not.toContain("taking longer");
    expect(mocks.wake).not.toHaveBeenCalled();
    expect(createChatCalls()).toEqual([]);
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"],
    ).toMatchObject({
      content: MESSAGE_CONTENT,
      returnedSandbox: {
        target: {
          kind: "existing",
          hostId: SANDBOX_HOST,
          sandboxId: SANDBOX_ID,
          verb: "resume",
        },
      },
    });
    const line = await screen.findByTestId("sandbox-stopped-line");
    expect(line.textContent).toContain(
      "build-box is suspended · your next message resumes it",
    );
    expect(line.textContent).not.toContain("wasn't sent");
  });

  it("ends the create line and says the failed sandbox's line, with the message back and no sandbox kept", async () => {
    await mountTimedOut();

    answerSandboxRows([rowIn("failed")], FRESH + 1);

    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    expect(screen.queryByTestId("sandbox-setup-line")).toBeNull();
    expect(mocks.wake).not.toHaveBeenCalled();
    // The sandbox ended, so the message is saved as a draft that names none.
    expect(useLandingDraftStore.getState().drafts).toMatchObject([
      { content: MESSAGE_CONTENT, closed: true, returnedSandbox: null },
    ]);
    const line = await screen.findByTestId("sandbox-stopped-line");
    expect(line.textContent).toContain("Couldn't start build-box");
    expect(line.textContent).not.toContain("nothing was charged");
    expect(line.textContent).not.toContain("wasn't sent");
    // The line's own remedies mount under the sandbox's host, never crashing
    // on the strip's missing tab provider.
    expect(within(line).getByTestId("sandbox-row-retry")).toBeDefined();
    fireEvent.keyDown(within(line).getByTestId("sandbox-row-menu"), {
      key: "Enter",
    });
    expect(await screen.findByTestId("sandbox-row-menu-details")).toBeDefined();
    expect(screen.getByTestId("sandbox-row-menu-destroy")).toBeDefined();
  });

  it("binds the failed line's actions to the sandbox's host in a tile bound elsewhere, without opening a draft mirror for it", async () => {
    const TILE_HOST = "tile-host";
    seed({
      ...SEEDED,
      send: SEND_BY_KIND.chat,
      phase: "creating",
      created: true,
    });
    useStagedSandboxStore.getState().report(SURFACE, {
      step: "applying",
      stepAt: Date.now(),
      failure: { kind: "timed-out", step: "applying" },
    });
    mocks.listSandboxes.mockResolvedValue(listAnswers([rowIn("awake")]));
    answerSandboxRows([rowIn("awake")], FRESH);
    answerHost(SANDBOX_HOST, CODEX_READY);
    mirrorMountHosts.length = 0;
    environmentListClientHosts.length = 0;
    mountInTileBoundTo(TILE_HOST);
    await screen.findByTestId("sandbox-setup-line");

    answerSandboxRows([rowIn("failed")], FRESH + 1);

    const line = await screen.findByTestId("sandbox-stopped-line");
    expect(line.textContent).toContain("Couldn't start build-box");
    expect(within(line).getByTestId("sandbox-row-retry")).toBeDefined();
    // The actions' own host-scoped read went out on the sandbox's host client,
    // not the tile's...
    expect(environmentListClientHosts).toContain(SANDBOX_HOST);
    expect(environmentListClientHosts).not.toContain(TILE_HOST);
    // ...and no mirror of this tile's drafts was mounted for it.
    expect(mirrorMountHosts).not.toContain(SANDBOX_HOST);
  });

  it("says a stopped sandbox's draft line in the stopped form when the composer is occupied", async () => {
    useNewConversationModalStore
      .getState()
      .setContent("epic-1", OCCUPIED_NEW_CHAT_CONTENT);
    await mountTimedOut();

    answerSandboxRows([rowIn("stopped")], FRESH + 1);

    const line = await screen.findByTestId("sandbox-stopped-line");
    expect(line.textContent).toContain(
      "build-box is stopped. Your message wasn't sent; it's saved in your drafts.",
    );
    expect(line.textContent).not.toContain("is suspended");
    expect(line.textContent).not.toContain("Stopped build-box.");
    expect(
      within(line).getByRole("button", { name: "Open draft" }),
    ).toBeDefined();
  });

  it("falls back to the receipt's sentence when the sandbox is absent from the list and the task names no end", async () => {
    await mountTimedOut();

    answerSandboxRows([], FRESH + 1);

    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    const line = await screen.findByTestId("sandbox-stopped-line");
    expect(line.textContent).toContain(
      "Your message wasn't sent; it's saved in your drafts.",
    );
    expect(line.textContent).not.toContain("this chat stays readable");
  });

  it("falls back to the receipt's sentence when the task names the sandbox but the list lacks its row", async () => {
    mocks.taskHosts = [
      {
        hostId: SANDBOX_HOST,
        label: "build-box",
        principal: { kind: "user", id: "user-1" },
        reach: "same_principal",
        sandboxEnd: null,
      },
    ];
    onTestFinished(() => {
      mocks.taskHosts = [];
    });
    await mountTimedOut();

    answerSandboxRows([], FRESH + 1);

    const line = await screen.findByTestId("sandbox-stopped-line");
    expect(line.textContent).toContain(
      "Your message wasn't sent; it's saved in your drafts.",
    );
    expect(line.textContent).not.toContain("build-box");
  });

  it("drops the footer once the sandbox is awake again", async () => {
    await mountTimedOut();
    answerSandboxRows([rowIn("suspended")], FRESH + 1);
    await screen.findByTestId("sandbox-stopped-line");

    answerSandboxRows([rowIn("awake")], FRESH + 2);

    await waitFor(() => {
      expect(screen.queryByTestId("sandbox-stopped-line")).toBeNull();
    });
  });
});

describe("a rested send this window cannot give back", () => {
  const FRESH = Date.now() + 60_000;

  function rowIn(state: SandboxSummary["state"]): SandboxSummary {
    return sandboxSummaryFixture({
      id: SANDBOX_ID,
      hostId: SANDBOX_HOST,
      state,
      guestConfigured: true,
    });
  }

  it.each([
    ["a recorded rest at booting", "booting", { kind: "rested" }],
    [
      "a timed-out wait at applying",
      "applying",
      { kind: "timed-out", step: "applying" },
    ],
  ] as const)(
    "keeps the send and says it is pending, with a Retry that wakes the sandbox once, under %s",
    async (_label, step, failure) => {
      // No Web Locks here: this window owns the send but is not exclusive.
      expect(navigator.locks).toBeUndefined();
      seed({
        ...SEEDED,
        target: RESUME_TARGET,
        send: { request: { kind: "chat", parentId: null, placement: null } },
        phase: "creating",
        created: true,
      });
      useStagedSandboxStore
        .getState()
        .report(SURFACE, { step, stepAt: Date.now(), failure });
      mocks.listReadAt = FRESH;
      mocks.sandboxes = [rowIn("suspended")];
      mocks.listSandboxes.mockResolvedValue(listAnswers([rowIn("awake")]));
      mocks.wake.mockResolvedValue({ kind: "awake" });
      answerHost(SANDBOX_HOST, CODEX_READY);
      mount();

      const held = await screen.findByTestId("sandbox-rested-held-line");
      expect(held.textContent).toContain("Your message is still pending.");
      expect(screen.queryByTestId("sandbox-setup-line")).toBeNull();
      expect(document.body.textContent).not.toContain("compute is charged");
      expect(
        usePendingSandboxSendStore.getState().sends[SEND_ID],
      ).toBeDefined();
      expect(mocks.wake).not.toHaveBeenCalled();

      fireEvent.click(within(held).getByTestId("sandbox-rested-held-retry"));

      await waitFor(() => {
        expect(mocks.wake).toHaveBeenCalledTimes(1);
      });
      expect(mocks.wake).toHaveBeenCalledWith(SANDBOX_HOST, "send");
    },
  );

  it.each([
    ["a handed-off send", { phase: "handoff", step: null }],
    ["a creating send at applying", { phase: "creating", step: "applying" }],
  ] as const)(
    "projects %s with no failure as a stopped stage, so the held line's Retry wakes the sandbox once",
    async (_label, at) => {
      expect(navigator.locks).toBeUndefined();
      seed({
        ...SEEDED,
        target: RESUME_TARGET,
        send: { request: { kind: "chat", parentId: null, placement: null } },
        phase: at.phase,
        created: true,
      });
      if (at.step !== null) {
        useStagedSandboxStore
          .getState()
          .report(SURFACE, { step: at.step, stepAt: Date.now() });
      }
      expect(readStagedSandbox(SURFACE)?.failure).toBeNull();
      mocks.listReadAt = FRESH;
      mocks.sandboxes = [rowIn("suspended")];
      mocks.listSandboxes.mockResolvedValue(listAnswers([rowIn("awake")]));
      mocks.wake.mockResolvedValue({ kind: "awake" });
      answerHost(SANDBOX_HOST, CODEX_READY);
      mount();

      const held = await screen.findByTestId("sandbox-rested-held-line");
      expect(held.textContent).toContain("Your message is still pending.");
      await waitFor(() => {
        expect(readStagedSandbox(SURFACE)).toMatchObject({
          phase: "creating",
          failure: { kind: "rested" },
        });
      });
      expect(
        usePendingSandboxSendStore.getState().sends[SEND_ID],
      ).toBeDefined();
      expect(mocks.wake).not.toHaveBeenCalled();

      fireEvent.click(within(held).getByTestId("sandbox-rested-held-retry"));

      await waitFor(() => {
        expect(mocks.wake).toHaveBeenCalledTimes(1);
      });
      expect(mocks.wake).toHaveBeenCalledWith(SANDBOX_HOST, "send");
    },
  );

  it("replaces a handed-off send's not-sent failure with the rested stage, so one Retry wakes the sandbox", async () => {
    expect(navigator.locks).toBeUndefined();
    seed({
      ...SEEDED,
      target: RESUME_TARGET,
      send: { request: { kind: "chat", parentId: null, placement: null } },
      phase: "handoff",
      created: true,
    });
    useStagedSandboxStore
      .getState()
      .report(SURFACE, { failure: { kind: "not-sent" } });
    mocks.listReadAt = FRESH;
    mocks.sandboxes = [rowIn("suspended")];
    mocks.listSandboxes.mockResolvedValue(listAnswers([rowIn("awake")]));
    mocks.wake.mockResolvedValue({ kind: "awake" });
    answerHost(SANDBOX_HOST, CODEX_READY);
    mount();

    const held = await screen.findByTestId("sandbox-rested-held-line");
    expect(held.textContent).toContain("Your message is still pending.");
    expect(readStagedSandbox(SURFACE)).toMatchObject({
      phase: "creating",
      failure: { kind: "rested" },
    });
    expect(document.body.textContent).not.toContain("nothing was sent");
    expect(mocks.wake).not.toHaveBeenCalled();

    fireEvent.click(within(held).getByTestId("sandbox-rested-held-retry"));

    await waitFor(() => {
      expect(mocks.wake).toHaveBeenCalledTimes(1);
    });
    expect(mocks.wake).toHaveBeenCalledWith(SANDBOX_HOST, "send");
  });
});

describe("a send held on settings that didn't apply, once its sandbox leaves awake", () => {
  const FRESH = Date.now() + 60_000;
  let restoreLocks: () => void = () => undefined;
  beforeEach(() => {
    restoreLocks = installImmediateExclusiveLocks();
  });
  afterEach(() => {
    restoreLocks();
  });

  function rowIn(state: SandboxSummary["state"]): SandboxSummary {
    return sandboxSummaryFixture({
      id: SANDBOX_ID,
      hostId: SANDBOX_HOST,
      state,
      guestConfigured: true,
    });
  }

  async function mountHeld(): Promise<void> {
    mocks.settingsStatus = {
      principal: { kind: "personal" },
      items: [{ kind: "variable", status: "failed" }],
    };
    seed({
      ...SEEDED,
      send: SEND_BY_KIND.chat,
      phase: "creating",
      created: true,
    });
    mocks.listSandboxes.mockResolvedValue(listAnswers([rowIn("awake")]));
    answerSandboxRows([rowIn("awake")], FRESH);
    answerHost(SANDBOX_HOST, CODEX_READY);
    mount();
    await screen.findByTestId("pending-sandbox-sends");
    act(() => {
      useStagedSandboxStore.getState().report(SURFACE, {
        failure: { kind: "settings", code: "SBX-0520" },
      });
    });
    await screen.findByTestId("sandbox-setup-retry-applying");
    expect(screen.getByTestId("sandbox-setup-line").textContent).toMatch(
      /is awake, but .*'s settings didn't apply/,
    );
  }

  it("gives the message back once the sandbox suspends, so the chat shows its resting footer, and never wakes it", async () => {
    await mountHeld();

    answerSandboxRows([rowIn("suspended")], FRESH + 1);

    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    expect(screen.queryByTestId("sandbox-setup-line")).toBeNull();
    expect(screen.queryByText(/is awake, but/)).toBeNull();
    expect(mocks.wake).not.toHaveBeenCalled();
    expect(createChatCalls()).toEqual([]);
  });

  it("puts the message back in this task's composer on the suspended sandbox, and says so where the line was", async () => {
    await mountHeld();

    answerSandboxRows([rowIn("suspended")], FRESH + 1);

    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    const taskSurface = newConversationSurfaceKey("epic-1");
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"],
    ).toMatchObject({ content: MESSAGE_CONTENT, settings: PICKED_SETTINGS });
    // Recorded to resume, so the composer's Send wakes it in this task once
    // the composer shows the draft. Nothing is staged or pinned before then.
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"]
        ?.returnedSandbox,
    ).toMatchObject({
      target: {
        kind: "existing",
        hostId: SANDBOX_HOST,
        sandboxId: SANDBOX_ID,
        name: "api-refactor",
        verb: "resume",
      },
      clientRequestId: null,
    });
    expect(readStagedSandbox(taskSurface)).toBeNull();
    expect(
      useSurfaceHostSelectionStore.getState().selections[taskSurface],
    ).toBeUndefined();
    // A rest is nobody's gesture: nothing opens on its own.
    expect(useNewConversationModalOpenStore.getState().request).toBeNull();
    const line = await screen.findByTestId("sandbox-stopped-line");
    expect(line.textContent).toContain(
      "build-box is suspended · your next message resumes it",
    );
    expect(line.textContent).not.toContain("wasn't sent");

    fireEvent.click(within(line).getByRole("button", { name: "Open draft" }));

    expect(useNewConversationModalOpenStore.getState().request).toMatchObject({
      epicId: "epic-1",
      tabId: "tab-1",
      hostId: null,
    });

    // A reload before the Send: the draft puts the sandbox back on its
    // composer, and the composer's Send takes it, so it wakes the same
    // sandbox here.
    await reloadPendingSandboxStores();
    await reloadTaskDrafts();
    expect(readStagedSandbox(taskSurface)).toBeNull();
    renderHook(() => useNewConversationReturnedSandbox("epic-1", null));
    expect(readStagedSandbox(taskSurface)).toMatchObject({
      phase: "staged",
      target: { kind: "existing", sandboxId: SANDBOX_ID, verb: "resume" },
    });
    const handed = sendFromTaskComposer(taskSurface);
    expect(usePendingSandboxSendStore.getState().sends[handed]?.epicId).toBe(
      "epic-1",
    );
    expect(readStagedSandbox(pendingSendSurfaceKey(handed))).toMatchObject({
      target: {
        kind: "existing",
        hostId: SANDBOX_HOST,
        sandboxId: SANDBOX_ID,
      },
    });
    // Sent: the draft no longer names a destination.
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"]
        ?.returnedSandbox,
    ).toBeUndefined();
  });

  it("takes the given-back sandbox off the task composer when it closes, and back on when it reopens", async () => {
    await mountHeld();
    answerSandboxRows([rowIn("suspended")], FRESH + 1);
    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    const taskSurface = newConversationSurfaceKey("epic-1");
    const composer = renderHook(() =>
      useNewConversationReturnedSandbox("epic-1", null),
    );

    composer.unmount();
    expect(readStagedSandbox(taskSurface)).toBeNull();

    renderHook(() => useNewConversationReturnedSandbox("epic-1", null));
    expect(readStagedSandbox(taskSurface)).toMatchObject({
      phase: "staged",
      target: { kind: "existing", sandboxId: SANDBOX_ID, verb: "resume" },
    });
  });

  it("keeps a second message given back to the same composer across a reload", async () => {
    await mountHeld();
    answerSandboxRows([rowIn("suspended")], FRESH + 1);
    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    const taskSurface = newConversationSurfaceKey("epic-1");
    // Only the composer from here: this window gives the second message back.
    cleanup();
    renderHook(() => useNewConversationReturnedSandbox("epic-1", null));
    // The first message is sent from the composer, which empties its draft.
    const handed = sendFromTaskComposer(taskSurface);
    act(() => {
      useNewConversationModalStore.getState().clearDraft("epic-1");
    });

    // The sent message comes back to the same composer, on the same sandbox.
    const ownership = holdPendingSandboxSendOwnership(handed);
    try {
      await act(async () => {
        await ownership.ready;
      });
      act(() => {
        returnPendingSandboxSendToSandbox(handed, {
          kind: "stage",
          target: RESUME_TARGET,
          clientRequestId: null,
        });
      });
    } finally {
      ownership.release();
    }
    await reloadPendingSandboxStores();
    await reloadTaskDrafts();
    renderHook(() => useNewConversationReturnedSandbox("epic-1", null));

    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"],
    ).toMatchObject({ content: MESSAGE_CONTENT });
    expect(readStagedSandbox(taskSurface)).toMatchObject({
      phase: "staged",
      target: { kind: "existing", sandboxId: SANDBOX_ID, verb: "resume" },
    });
  });

  it("leaves another sandbox the person staged in the task's composer, and saves the message in drafts", async () => {
    await mountHeld();
    const taskSurface = newConversationSurfaceKey("epic-1");
    const otherSandbox: StagedSandboxTarget = {
      ...RESUME_TARGET,
      hostId: "other-sbx-host",
      sandboxId: "sbx-2",
      name: "other-box",
    };
    act(() => {
      useStagedSandboxStore.getState().stage(taskSurface, otherSandbox);
      useSurfaceHostSelectionStore
        .getState()
        .setSelection(taskSurface, "other-sbx-host");
    });

    answerSandboxRows([rowIn("suspended")], FRESH + 1);

    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    expect(readStagedSandbox(taskSurface)).toMatchObject({
      phase: "staged",
      target: otherSandbox,
    });
    expect(
      useSurfaceHostSelectionStore.getState().selections[taskSurface],
    ).toBe("other-sbx-host");
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"]
        ?.content,
    ).not.toEqual(MESSAGE_CONTENT);
    expect(useLandingDraftStore.getState().drafts).toMatchObject([
      { content: MESSAGE_CONTENT, settings: PICKED_SETTINGS, closed: true },
    ]);
    expect(useNewConversationModalOpenStore.getState().request).toBeNull();
    const line = await screen.findByTestId("sandbox-stopped-line");
    expect(line.textContent).toContain(
      "build-box is suspended · your next message resumes it",
    );
    expect(line.textContent).toContain(
      "build-box is suspended. Your message wasn't sent; it's saved in your drafts.",
    );
    expect(
      within(line).getByRole("button", { name: "Open draft" }),
    ).toBeDefined();
  });

  it("keeps the resting sandbox on the message's draft when the task's composer holds another message", async () => {
    act(() => {
      useNewConversationModalStore
        .getState()
        .setContent("epic-1", OCCUPIED_NEW_CHAT_CONTENT);
    });
    await mountHeld();
    const before = composerStages();

    answerSandboxRows([rowIn("suspended")], FRESH + 1);

    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    expect(useLandingDraftStore.getState().drafts).toMatchObject([
      {
        content: MESSAGE_CONTENT,
        closed: true,
        returnedSandbox: {
          target: {
            kind: "existing",
            hostId: SANDBOX_HOST,
            sandboxId: SANDBOX_ID,
            name: "api-refactor",
            verb: "resume",
          },
          clientRequestId: null,
        },
      },
    ]);
    expectOnlyTheRecordWritten(before);
  });

  it("keeps the awake sandbox on a cancelled message's draft when the task's composer holds another message", async () => {
    act(() => {
      useNewConversationModalStore
        .getState()
        .setContent("epic-1", OCCUPIED_NEW_CHAT_CONTENT);
    });
    await mountHeld();
    const before = composerStages();

    fireEvent.click(screen.getByRole("button", { name: "Cancel the message" }));

    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    expect(useLandingDraftStore.getState().drafts).toMatchObject([
      {
        content: MESSAGE_CONTENT,
        returnedSandbox: {
          target: {
            kind: "existing",
            hostId: SANDBOX_HOST,
            sandboxId: SANDBOX_ID,
            name: "api-refactor",
          },
          clientRequestId: null,
        },
      },
    ]);
    expectOnlyTheRecordWritten(before);
  });

  it("puts a cancelled message back in this task's composer on the awake sandbox", async () => {
    await mountHeld();
    const before = composerStages();

    fireEvent.click(screen.getByRole("button", { name: "Cancel the message" }));

    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    const taskSurface = newConversationSurfaceKey("epic-1");
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"],
    ).toMatchObject({ content: MESSAGE_CONTENT, settings: PICKED_SETTINGS });
    expect(
      useSurfaceHostSelectionStore.getState().selections[taskSurface],
    ).toBe(SANDBOX_HOST);
    // Awake: the pick is the host itself, as the picker makes it, and the
    // task draft records the sandbox for its composer to decide on.
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"]
        ?.returnedSandbox,
    ).toMatchObject({
      target: { kind: "existing", hostId: SANDBOX_HOST, sandboxId: SANDBOX_ID },
      clientRequestId: null,
    });
    expect(readStagedSandbox(taskSurface)).toBeNull();
    expectOnlyTheRecordWritten(before);
    expect(useNewConversationModalOpenStore.getState().request).toMatchObject({
      epicId: "epic-1",
      tabId: "tab-1",
      hostId: null,
    });
  });

  it("stops saying the sandbox is awake and offers no Retry applying while it suspends", async () => {
    await mountHeld();

    answerSandboxRows([rowIn("suspending")], FRESH + 1);

    await waitFor(() => {
      expect(screen.queryByTestId("sandbox-setup-retry-applying")).toBeNull();
    });
    const line = screen.getByTestId("sandbox-setup-line");
    expect(line.textContent).not.toMatch(/is awake/);
    expect(line.textContent).not.toMatch(/Compute is charged/);
    expect(line.textContent).toMatch(/'s settings didn't apply on /);
    expect(mocks.repairFinishers).toHaveLength(0);
    expect(mocks.wake).not.toHaveBeenCalled();
  });
});

describe("a send whose created sandbox stalled on credits or settings while it was still being created", () => {
  const FRESH = Date.now() + 60_000;
  const BLOCKERS = [
    ["frozen", { frozen: true }, /credits/i],
    ["unconfigured", { guestConfigured: false }, /retry applying/i],
  ] as const;
  const KINDS = ["chat", "fork", "terminal"] as const;

  it.each(
    KINDS.flatMap((kind) =>
      BLOCKERS.map(
        ([label, row, remedy]) => [kind, label, row, remedy] as const,
      ),
    ),
  )(
    "keeps a %s send's message and remedy for a %s sandbox, then resumes the same sandbox once on a fresh repaired row, with no other create or wake",
    async (kind, _label, row, remedy) => {
      seed({
        ...SEEDED,
        send: SEND_BY_KIND[kind],
        phase: "creating",
        created: true,
      });
      // The control plane and the list the strip watches answer alike.
      const stalled = sandboxSummaryFixture({
        id: SANDBOX_ID,
        hostId: SANDBOX_HOST,
        state: "awake",
        ...row,
      });
      mocks.listSandboxes.mockResolvedValue(listAnswers([stalled]));
      answerSandboxRows([stalled], FRESH);
      answerHost(SANDBOX_HOST, CODEX_READY);
      mount();

      await waitFor(() => {
        expect(screen.getByTestId("pending-sandbox-sends").textContent).toMatch(
          remedy,
        );
      });
      if (kind === "chat") {
        expect(screen.getByTestId("pending-sandbox-message").textContent).toBe(
          "fix the login bug",
        );
      }
      expect(createChatCalls()).toEqual([]);
      expect(mocks.openTile).not.toHaveBeenCalled();
      expect(mocks.wake).not.toHaveBeenCalled();
      expect(mocks.createSandbox).not.toHaveBeenCalled();
      expect(
        usePendingSandboxSendStore.getState().sends[SEND_ID],
      ).toBeDefined();

      // Repaired: the control plane and the list both say awake and healthy.
      const repaired = sandboxSummaryFixture({
        id: SANDBOX_ID,
        hostId: SANDBOX_HOST,
        state: "awake",
        guestConfigured: true,
      });
      mocks.listSandboxes.mockResolvedValue(listAnswers([repaired]));
      answerSandboxRows([repaired], FRESH + 1);
      if (kind === "terminal") {
        await waitFor(() => {
          expect(mocks.openTile).toHaveBeenCalledTimes(1);
        });
        expect(createChatCalls()).toEqual([]);
        expect(usePendingSandboxSendStore.getState().sends).toEqual({});
      } else {
        await waitForCreateChats(1);
        expect(createChatCalls()).toHaveLength(1);
      }
      expect(mocks.wake).not.toHaveBeenCalled();
      expect(mocks.createSandbox).not.toHaveBeenCalled();
    },
  );
});

describe("a send whose sandbox has no id yet", () => {
  let restoreLocks: () => void = () => undefined;
  beforeEach(() => {
    restoreLocks = installImmediateExclusiveLocks();
  });
  afterEach(() => {
    restoreLocks();
  });

  it.each(["chat", "fork", "terminal"] as const)(
    "offers no Stop to a %s send before its sandbox exists, sends no stop, and keeps Cancel and Choose another host",
    async (kind) => {
      seed({
        ...SEEDED,
        send: SEND_BY_KIND[kind],
        phase: "creating",
        created: false,
        elapsedSeconds: 120,
      });
      answerHost(SANDBOX_HOST, CODEX_DOWNLOADING);
      mount();
      await screen.findByTestId("sandbox-setup-line");
      act(() => {
        useStagedSandboxStore.getState().report(SURFACE, {
          failure: { kind: "settings", code: "SBX-0520" },
        });
      });

      expect(await screen.findByTestId("sandbox-setup-cancel")).toBeDefined();
      expect(
        screen.getByTestId("sandbox-setup-choose-another-host"),
      ).toBeDefined();
      expect(screen.queryByTestId("sandbox-setup-stop")).toBeNull();
      expect(mocks.stopSandbox).not.toHaveBeenCalled();
      expect(
        usePendingSandboxSendStore.getState().sends[SEND_ID],
      ).toBeDefined();
    },
  );
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

  it("cannot Cancel a refusal after another operation claims its delivery", async () => {
    const restoreLocks = installImmediateExclusiveLocks();
    try {
      seed(SEEDED);
      answerHost(SANDBOX_HOST, CODEX_UNAVAILABLE);
      mount();
      const cancel = within(
        await screen.findByTestId("sandbox-refusal-line"),
      ).getByRole("button", { name: "Cancel the message" });
      // Hold delivery on an unknown row, so this checks withdrawal rather than a result race.
      answerSandboxRows([], 0);
      const input = claimInput("chat");
      act(() => {
        useStagedSandboxStore.getState().report(SURFACE, { failure: null });
        expect(
          usePendingSandboxSendStore.getState().beginDispatch(SEND_ID, {
            input,
            status: "sending",
            delivery: {
              chatId: input.chatId,
              hostId: SANDBOX_HOST,
              sandboxId: SANDBOX_ID,
              readySeconds: 24,
            },
          }),
        ).toBe(true);
        fireEvent.click(cancel);
      });
      expect(
        usePendingSandboxSendStore.getState().sends[SEND_ID]?.dispatch?.input,
      ).toEqual(input);
      expect(
        useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"],
      ).toBeUndefined();
      expect(useLandingDraftStore.getState().drafts).toEqual([]);
      expect(
        screen.queryByRole("button", { name: "Cancel the message" }),
      ).toBeNull();
      expect(
        screen.queryByText(
          "Your message wasn't sent; it's back in the composer.",
        ),
      ).toBeNull();
      expect(mocks.wake).not.toHaveBeenCalled();
      expect(mocks.stopSandbox).not.toHaveBeenCalled();
      expect(createChatCalls()).toEqual([]);
    } finally {
      restoreLocks();
    }
  });

  it.each(byKind(RESTING))(
    "never wakes a %s sandbox of a saved %s claim on its own: it reads as uncertain, and only Retry wakes it, then replays its exact input once awake",
    async (kind, state) => {
      const input = await seedClaim(kind, "sending", SANDBOX_ID);
      answerSandboxRows([rowIn(state)], FRESH);
      answerHost(SANDBOX_HOST, CODEX_READY);
      mount();

      const retry = await screen.findByTestId("pending-sandbox-dispatch-retry");
      expect(
        screen.getByTestId("pending-sandbox-dispatch").textContent,
      ).toContain("Couldn't confirm the agent was created.");
      await waitFor(() => {
        expect(
          usePendingSandboxSendStore.getState().sends[SEND_ID]?.dispatch,
        ).toMatchObject({ status: "uncertain", input });
      });
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
      expect(mocks.wake).toHaveBeenCalledTimes(1);
    },
  );

  it("offers Retry only once the stored claim reads uncertain, so a click is never lost to a view that runs ahead", async () => {
    await seedClaim("chat", "sending", SANDBOX_ID);
    answerSandboxRows([rowIn("suspended")], FRESH);
    answerHost(SANDBOX_HOST, CODEX_READY);
    const state = usePendingSandboxSendStore.getState();
    const project = state.dispatchEvent;
    // Hold the store's projection, so it stays `sending` while the view
    // already reads the rested claim as uncertain.
    const held = vi
      .spyOn(state, "dispatchEvent")
      .mockImplementation(() => null);
    onTestFinished(() => held.mockRestore());
    mount();

    await waitFor(() => {
      expect(
        screen.getByTestId("pending-sandbox-dispatch").textContent,
      ).toContain("Couldn't confirm the agent was created.");
    });
    expect(
      usePendingSandboxSendStore.getState().sends[SEND_ID]?.dispatch,
    ).toMatchObject({ status: "sending" });
    expect(screen.queryByTestId("pending-sandbox-dispatch-retry")).toBeNull();

    const projections = [...held.mock.calls];
    held.mockRestore();
    act(() => {
      for (const call of projections) project(...call);
    });
    fireEvent.click(
      await screen.findByTestId("pending-sandbox-dispatch-retry"),
    );

    await waitFor(() => {
      expect(mocks.wake).toHaveBeenCalledWith(SANDBOX_HOST, "send");
    });
  });

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

  it.each(KINDS)(
    "records a Retry chosen on an uncertain %s claim in a window that does not own it on the pending record, and replays nothing here",
    async (kind) => {
      await seedClaim(kind, "uncertain", SANDBOX_ID);
      answerSandboxRows([rowIn("awake")], FRESH);
      answerHost(SANDBOX_HOST, CODEX_READY);
      const restoreQueued = queueBehindForeignHolder();
      try {
        mount();
        const retry = await screen.findByTestId(
          "pending-sandbox-dispatch-retry",
        );
        // Queued behind a foreign holder: this window does not own the send.
        expect(ownsPendingSandboxSend(SEND_ID)).toBe(false);
        const refetches = mocks.modelRefetches.length;

        fireEvent.click(retry);

        await waitFor(() => {
          expect(
            usePendingSandboxSendStore.getState().sends[SEND_ID]?.retryRequest,
          ).toMatchObject({ userId: "user-1" });
        });
        expect(mocks.wake).not.toHaveBeenCalled();
        expect(mocks.modelRefetches.length).toBe(refetches);
        expect(createChatCalls()).toEqual([]);
        expect(
          usePendingSandboxSendStore.getState().sends[SEND_ID]?.dispatch,
        ).toMatchObject({ status: "uncertain" });
      } finally {
        restoreQueued();
      }
    },
  );

  /** The queued window records the Retry; nothing else happens here. */
  async function requestClaimedRetryFromNonOwner(): Promise<string> {
    const restoreQueued = queueBehindForeignHolder();
    try {
      mount();
      const retry = await screen.findByTestId("pending-sandbox-dispatch-retry");
      expect(ownsPendingSandboxSend(SEND_ID)).toBe(false);
      fireEvent.click(retry);
      await waitFor(() => {
        expect(
          usePendingSandboxSendStore.getState().sends[SEND_ID]?.retryRequest,
        ).toMatchObject({ userId: "user-1" });
      });
      const id =
        usePendingSandboxSendStore.getState().sends[SEND_ID]?.retryRequest?.id;
      if (id === undefined) throw new Error("the request was not recorded");
      return id;
    } finally {
      restoreQueued();
      cleanup();
    }
  }

  it.each(KINDS)(
    "hands a %s claim's recorded Retry to the owner after a reload: it acknowledges the request and repeats the exact saved input once",
    async (kind) => {
      const input = await seedClaim(kind, "uncertain", SANDBOX_ID);
      answerSandboxRows([rowIn("awake")], FRESH);
      answerHost(SANDBOX_HOST, CODEX_READY);
      const requestId = await requestClaimedRetryFromNonOwner();
      expect(createChatCalls()).toEqual([]);

      const handled: Array<string | undefined> = [];
      const unsubscribe = usePendingSandboxSendStore.subscribe((state) => {
        handled.push(state.sends[SEND_ID]?.retryHandledId);
      });
      const restoreLocks = installImmediateExclusiveLocks();
      try {
        await reloadPendingSandboxStores();
        expect(
          usePendingSandboxSendStore.getState().sends[SEND_ID]?.retryRequest
            ?.id,
        ).toBe(requestId);
        mount();

        await waitForCreateChats(1);
        expect(createChatCalls()[0]?.input).toEqual(input);
        expect(handled).toContain(requestId);
        expect(mocks.wake).not.toHaveBeenCalled();
      } finally {
        unsubscribe();
        restoreLocks();
      }
    },
  );

  it.each(KINDS)(
    "acknowledges a recorded Retry that the owner refuses because the %s sandbox is gone, and gives the claim back instead of replaying it",
    async (kind) => {
      await seedClaim(kind, "uncertain", SANDBOX_ID);
      answerSandboxRows([rowIn("awake")], FRESH);
      answerHost(SANDBOX_HOST, CODEX_READY);
      await requestClaimedRetryFromNonOwner();

      const restoreLocks = installImmediateExclusiveLocks();
      try {
        await reloadPendingSandboxStores();
        mocks.nullClientHosts.add(SANDBOX_HOST);
        answerSandboxRows([rowIn("destroyed")], FRESH + 1);
        mount();

        await waitForRelease();
        expectClaimReleased(kind);
        expect(createChatCalls()).toEqual([]);
      } finally {
        restoreLocks();
      }
    },
  );

  it.each(KINDS)(
    "records no Retry on a %s claim from another account, and none on a settled or missing send",
    async (kind) => {
      await seedClaim(kind, "uncertain", SANDBOX_ID);
      useAuthStore.getState().setSignedOut();
      useAuthStore
        .getState()
        .setSignedIn(
          { userId: "user-2", userName: "V", email: "v@example.com" },
          { userId: "user-2", username: "V" },
          [],
        );

      expect(
        usePendingSandboxSendStore.getState().requestDispatchRetry(SEND_ID),
      ).toBeNull();
      expect(
        usePendingSandboxSendStore.getState().sends[SEND_ID]?.retryRequest,
      ).toBeUndefined();

      userSignedIn();
      expect(
        usePendingSandboxSendStore.getState().requestDispatchRetry("missing"),
      ).toBeNull();
      // A settled record is no claim to replay.
      usePendingSandboxSendStore.setState((state) => ({
        sends: {
          ...state.sends,
          [SEND_ID]: {
            ...state.sends[SEND_ID],
            dispatch: null,
            delivery: {
              chatId: "chat-1",
              hostId: SANDBOX_HOST,
              sandboxId: SANDBOX_ID,
              readySeconds: 24,
            },
          },
        },
      }));
      expect(
        usePendingSandboxSendStore.getState().requestDispatchRetry(SEND_ID),
      ).toBeNull();
    },
  );

  it.each(KINDS)(
    "keeps a recorded %s Retry when a stale window later writes the claim's progress",
    async (kind) => {
      await seedClaim(kind, "uncertain", SANDBOX_ID);
      const requestId = usePendingSandboxSendStore
        .getState()
        .requestDispatchRetry(SEND_ID);
      if (requestId === null) throw new Error("the request was not recorded");

      // A window holding the older record persists its own progress afterwards.
      const saved =
        usePendingSandboxSendStore.getState().sends[SEND_ID]?.dispatch ?? null;
      if (saved === null) throw new Error("the claim was not saved");
      usePendingSandboxSendStore
        .getState()
        .markDispatchUncertain(SEND_ID, saved);
      await reloadPendingSandboxStores();

      expect(
        usePendingSandboxSendStore.getState().sends[SEND_ID]?.retryRequest?.id,
      ).toBe(requestId);
      expect(
        usePendingSandboxSendStore.getState().sends[SEND_ID]?.dispatch,
      ).toMatchObject({ status: "uncertain" });
    },
  );

  /** Retry on an uncertain claim whose sandbox rests: the owner starts one wake we hold open. */
  async function startClaimedWake(kind: Kind): Promise<{
    readonly input: PendingSandboxSendDispatch["input"];
    readonly wake: Deferred<{ readonly kind: "awake" } | null>;
  }> {
    const input = await seedClaim(kind, "uncertain", SANDBOX_ID);
    answerSandboxRows([rowIn("suspended")], FRESH);
    answerHost(SANDBOX_HOST, CODEX_READY);
    const wake = deferred<{ readonly kind: "awake" } | null>();
    mocks.wake.mockReturnValue(wake.promise);
    mount();
    fireEvent.click(
      await screen.findByTestId("pending-sandbox-dispatch-retry"),
    );
    await waitFor(() => {
      expect(mocks.wake).toHaveBeenCalledTimes(1);
    });
    return { input, wake };
  }

  it.each(KINDS)(
    "latches the wake remedy when the %s claim's own wake fails",
    async (kind) => {
      const { wake } = await startClaimedWake(kind);

      await act(async () => {
        wake.resolve(null);
        await wake.promise;
      });

      await waitFor(() => {
        expect(
          usePendingSandboxSendStore.getState().sends[SEND_ID]?.dispatch,
        ).toMatchObject({ blocker: "wake" });
      });
    },
  );

  it.each(KINDS)(
    "ignores a %s claim's wake failure whose boundary a later request superseded: no wake remedy, and fresh work continues",
    async (kind) => {
      const { input, wake } = await startClaimedWake(kind);
      // A later accepted request moves the observation boundary on.
      const superseding = Date.now() + 60_000;
      usePendingSandboxSendStore.setState((state) => ({
        sends: {
          ...state.sends,
          [SEND_ID]: {
            ...state.sends[SEND_ID],
            observationRequestedAt: superseding,
          },
        },
      }));

      await act(async () => {
        wake.resolve(null);
        await wake.promise;
      });

      expect(
        usePendingSandboxSendStore.getState().sends[SEND_ID]?.dispatch,
      ).not.toMatchObject({ blocker: "wake" });
      expect(screen.queryByText("Couldn't resume this sandbox.")).toBeNull();

      // A row sent after the newer boundary lets the newer work go on.
      mocks.listReadSentAt = superseding + 1;
      answerSandboxRows([rowIn("awake")], FRESH + 1);
      await waitForCreateChats(1);
      expect(createChatCalls()[0]?.input).toEqual(input);
    },
  );

  it.each(KINDS)(
    "issues the newer request's own wake on Retry when a superseded %s wake fails and a fresh read still shows the sandbox resting",
    async (kind) => {
      const { input, wake } = await startClaimedWake(kind);
      const superseding = Date.now() + 60_000;
      usePendingSandboxSendStore.setState((state) => ({
        sends: {
          ...state.sends,
          [SEND_ID]: {
            ...state.sends[SEND_ID],
            observationRequestedAt: superseding,
          },
        },
      }));
      const second = deferred<{ readonly kind: "awake" } | null>();
      mocks.wake.mockReturnValue(second.promise);

      await act(async () => {
        wake.resolve(null);
        await wake.promise;
      });
      // A read sent after the newer boundary: still resting. Nothing wakes
      // it on its own; the person's Retry does.
      mocks.listReadSentAt = superseding + 1;
      answerSandboxRows([rowIn("suspended")], FRESH + 1);
      fireEvent.click(
        await screen.findByTestId("pending-sandbox-dispatch-retry"),
      );

      // The old flag must not hold the newer intent's wake back.
      await waitFor(() => {
        expect(mocks.wake).toHaveBeenCalledTimes(2);
      });
      expect(
        usePendingSandboxSendStore.getState().sends[SEND_ID]?.dispatch,
      ).not.toMatchObject({ blocker: "wake" });

      await act(async () => {
        second.resolve({ kind: "awake" });
        await second.promise;
      });
      mocks.listReadSentAt = superseding + 2;
      answerSandboxRows([rowIn("awake")], FRESH + 2);
      await waitForCreateChats(1);
      expect(createChatCalls()).toHaveLength(1);
      expect(createChatCalls()[0]?.input).toEqual(input);
      expect(mocks.wake).toHaveBeenCalledTimes(2);
    },
  );

  /** A different claim now holds the record; the captured one belongs to an older request. */
  async function seedCurrentClaimOther(kind: Kind): Promise<{
    readonly captured: PendingSandboxSendDispatch;
    readonly current: PendingSandboxSendDispatch;
  }> {
    const input = await seedClaim(kind, "sending", SANDBOX_ID);
    const captured: PendingSandboxSendDispatch = {
      input,
      status: "sending",
      delivery: {
        chatId: input.chatId,
        hostId: SANDBOX_HOST,
        sandboxId: SANDBOX_ID,
        readySeconds: 24,
      },
    };
    const current: PendingSandboxSendDispatch = {
      ...captured,
      input: { ...input, chatId: `other-${kind}-chat-id` },
      delivery: {
        chatId: `other-${kind}-chat-id`,
        hostId: SANDBOX_HOST,
        sandboxId: SANDBOX_ID,
        readySeconds: 24,
      },
    };
    usePendingSandboxSendStore.setState((state) => ({
      sends: {
        ...state.sends,
        [SEND_ID]: { ...state.sends[SEND_ID], dispatch: current },
      },
    }));
    return { captured, current };
  }

  it.each(KINDS)(
    "a stale transport failure of a captured %s claim leaves the current claim as it is",
    async (kind) => {
      const { captured, current } = await seedCurrentClaimOther(kind);

      usePendingSandboxSendStore
        .getState()
        .markDispatchUncertain(SEND_ID, captured);

      expect(
        usePendingSandboxSendStore.getState().sends[SEND_ID]?.dispatch,
      ).toEqual(current);
    },
  );

  it.each(KINDS)(
    "a stale refusal of a captured %s claim keeps the current claim",
    async (kind) => {
      const { captured, current } = await seedCurrentClaimOther(kind);

      usePendingSandboxSendStore.getState().refuseDispatch(SEND_ID, captured);

      expect(
        usePendingSandboxSendStore.getState().sends[SEND_ID]?.dispatch,
      ).toEqual(current);
    },
  );

  it.each(KINDS)(
    "a transport failure and a refusal of the current %s claim still apply",
    async (kind) => {
      const { current } = await seedCurrentClaimOther(kind);

      usePendingSandboxSendStore
        .getState()
        .markDispatchUncertain(SEND_ID, current);
      expect(
        usePendingSandboxSendStore.getState().sends[SEND_ID]?.dispatch,
      ).toMatchObject({ status: "uncertain" });

      usePendingSandboxSendStore.getState().refuseDispatch(SEND_ID, current);
      expect(
        usePendingSandboxSendStore.getState().sends[SEND_ID]?.dispatch,
      ).toBeNull();
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
      // The view projects the missing client at once; the owner records it next.
      await waitFor(() => {
        expect(
          usePendingSandboxSendStore.getState().sends[SEND_ID].dispatch,
        ).toMatchObject({ input, status: "uncertain" });
      });
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
          remedy: /settings didn.t apply/i,
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
      "lets only the owner of a %s claim wake its resting sandbox, and only by Retry",
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
        const retry = await screen.findByTestId(
          "pending-sandbox-dispatch-retry",
        );
        await waitFor(() => {
          expect(
            usePendingSandboxSendStore.getState().sends[SEND_ID]?.dispatch,
          ).toMatchObject({ status: "uncertain" });
        });
        expect(mocks.wake).not.toHaveBeenCalled();
        fireEvent.click(retry);
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

  it("shows the already recovered draft after a task is deleted during Stop", async () => {
    const restoreLocks = installImmediateExclusiveLocks();
    onTestFinished(restoreLocks);
    const answer = deferred<SandboxVerbOutcome>();
    mocks.verbAnswer = answer.promise;
    seed({ ...SEEDED, elapsedSeconds: 120 });
    answerHost(SANDBOX_HOST, CODEX_DOWNLOADING);
    mount();
    await screen.findByTestId("sandbox-setup-line");
    act(() => {
      useStagedSandboxStore.getState().report(SURFACE, {
        failure: { kind: "settings", code: "SBX-0520" },
      });
    });
    fireEvent.click(await screen.findByTestId("sandbox-setup-stop"));
    await waitFor(() => {
      expect(mocks.stopSandbox).toHaveBeenCalledWith("stop");
    });

    loseEpic(["epic-1"], "user-1");
    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    const [recoveredDraft] = useLandingDraftStore.getState().drafts;
    expect(recoveredDraft).toMatchObject({
      content: MESSAGE_CONTENT,
      settings: PICKED_SETTINGS,
      closed: true,
    });
    const recoveryDraftId = recoveredDraft.id;
    expect(useLandingDraftStore.getState().activeDraftId).toBeNull();

    cleanup();
    answerHost(SANDBOX_HOST, CODEX_DOWNLOADING);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    render(
      <QueryClientProvider client={client}>
        <PendingSandboxSendsDriver />
      </QueryClientProvider>,
    );
    answerSandboxRows(
      [
        sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: SANDBOX_HOST,
          state: "stopped",
        }),
      ],
      Date.now() + 60_000,
    );

    await act(async () => {
      answer.resolve({ kind: "settled", state: "stopped" });
      await answer.promise;
    });
    await waitFor(() => {
      expect(toastSpies.show).toHaveBeenCalled();
    });
    expect(useLandingDraftStore.getState().drafts).toHaveLength(1);
    expect(useLandingDraftStore.getState().drafts[0]?.id).toBe(recoveryDraftId);
    expect(useLandingDraftStore.getState().activeDraftId).toBeNull();
    expect(useNewConversationModalOpenStore.getState().request).toBeNull();
    expect(mocks.openTile).not.toHaveBeenCalled();
    expect(createChatCalls()).toEqual([]);

    const toastCall = toastSpies.show.mock.calls.at(-1);
    if (toastCall === undefined) throw new Error("Expected stopped-send toast");
    const [toastContent, toastOptions] = toastCall;
    expect(toastOptions?.duration).toBe(Infinity);
    const toastView = render(toastContent);
    expect(toastView.container.textContent).toContain(
      "Stopped api-refactor. Your message wasn't sent; it's saved in your drafts.",
    );
    fireEvent.click(
      within(toastView.container).getByRole("button", { name: "Open draft" }),
    );
    expect(useLandingDraftStore.getState().activeDraftId).toBe(recoveryDraftId);
    expect(useLandingDraftStore.getState().drafts).toHaveLength(1);
  });

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

describe("Stop while the sandbox boots", () => {
  let restoreLocks: () => void = () => undefined;
  beforeEach(() => {
    restoreLocks = installImmediateExclusiveLocks();
  });
  afterEach(() => {
    restoreLocks();
  });

  it.each([
    ["creating", ["creating"]],
    ["starting", ["starting"]],
    ["resuming", ["resuming"]],
    ["not yet listed", []],
  ] as const)(
    "offers no Stop while the row is %s, and offers it once the run sees the row awake",
    async (_label, states) => {
      seed({ ...SEEDED, phase: "creating", elapsedSeconds: 7 });
      answerSandboxRows(
        states.map((state) =>
          sandboxSummaryFixture({
            id: SANDBOX_ID,
            hostId: SANDBOX_HOST,
            state,
          }),
        ),
        Date.now() + 60_000,
      );
      mount();

      const line = await screen.findByTestId("sandbox-setup-line");
      expect(line.textContent).toContain("Starting sandbox");
      expect(screen.queryByTestId("sandbox-setup-stop")).toBeNull();

      answerSandboxRows(
        [
          sandboxSummaryFixture({
            id: SANDBOX_ID,
            hostId: SANDBOX_HOST,
            state: "awake",
          }),
        ],
        Date.now() + 120_000,
      );
      act(() => {
        useStagedSandboxStore
          .getState()
          .report(SURFACE, { step: "applying", stepAt: Date.now() });
      });
      expect(await screen.findByTestId("sandbox-setup-stop")).toBeDefined();
      expect(mocks.stopSandbox).not.toHaveBeenCalled();
    },
  );
});

describe("choosing Stop on an unclaimed send", () => {
  const FRESH = Date.now() + 60_000;
  const BACK_IN_COMPOSER_RECEIPT =
    "Stopped api-refactor. Your message wasn't sent; it's back in the composer.";
  const SAVED_DRAFT_RECEIPT =
    "Stopped api-refactor. Your message wasn't sent; it's saved in your drafts.";
  let restoreLocks: () => void = () => undefined;
  beforeEach(() => {
    restoreLocks = installImmediateExclusiveLocks();
  });
  afterEach(() => {
    restoreLocks();
  });

  async function chooseStop(): Promise<void> {
    await chooseStopWith(mount);
  }

  async function chooseStopWith<T>(mounter: () => T): Promise<T> {
    seed({ ...SEEDED, elapsedSeconds: 120 });
    answerHost(SANDBOX_HOST, CODEX_DOWNLOADING);
    const mounted = mounter();
    await screen.findByTestId("sandbox-setup-line");
    act(() => {
      useStagedSandboxStore.getState().report(SURFACE, {
        failure: { kind: "settings", code: "SBX-0520" },
      });
    });
    fireEvent.click(await screen.findByTestId("sandbox-setup-stop"));
    return mounted;
  }

  /** The driver stays; the strip, and with it the Stop's attention, can be closed. */
  function mountWithRemovableStrip(): { removeStrip: () => void } {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const tree = (withStrip: boolean) => (
      <RunnerHostContext.Provider value={RUNNER_HOST}>
        <QueryClientProvider client={client}>
          <PendingSandboxSendsDriver />
          {withStrip ? (
            <PendingSandboxSendStrip epicId="epic-1" tabId="tab-1" />
          ) : null}
        </QueryClientProvider>
      </RunnerHostContext.Provider>
    );
    const view = render(tree(true));
    return { removeStrip: () => view.rerender(tree(false)) };
  }

  /** Stop pending, the task closed, then a fresh row reads `state` before the Stop answers. */
  async function closeTaskThenRowReads(
    state: "suspended" | "stopped",
  ): Promise<void> {
    const answer = deferred<SandboxVerbOutcome>();
    mocks.verbAnswer = answer.promise;
    onTestFinished(async () => {
      await act(async () => {
        answer.resolve({ kind: "settled", state });
        await answer.promise;
      });
    });
    const { removeStrip } = await chooseStopWith(mountWithRemovableStrip);
    await waitFor(() => {
      expect(mocks.stopSandbox).toHaveBeenCalledWith("stop");
    });
    act(removeStrip);
    answerSandboxRows(
      [
        sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: SANDBOX_HOST,
          state,
        }),
      ],
      FRESH,
    );
    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
  }

  async function chooseStopAndConfirmRest(): Promise<void> {
    const answer = deferred<SandboxVerbOutcome>();
    mocks.verbAnswer = answer.promise;
    await chooseStop();
    await waitFor(() => {
      expect(mocks.stopSandbox).toHaveBeenCalledWith("stop");
    });
    answerSandboxRows(
      [
        sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: SANDBOX_HOST,
          state: "stopped",
        }),
      ],
      Date.now() + 60_000,
    );
    await act(async () => {
      answer.resolve({ kind: "settled", state: "stopped" });
      await answer.promise;
    });
    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    await screen.findByTestId("sandbox-stopped-line");
  }

  function expectSendKept(): void {
    expect(usePendingSandboxSendStore.getState().sends[SEND_ID]).toBeDefined();
    expect(readStagedSandbox(SURFACE)).not.toBeNull();
    expect(screen.getByTestId("pending-sandbox-message").textContent).toBe(
      "fix the login bug",
    );
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
    expect(createChatCalls()).toEqual([]);
  }

  /** Ends an unanswered Stop the way the host eventually does, so no case outlives its own. */
  async function settleStop(
    answer: Deferred<SandboxVerbOutcome>,
  ): Promise<void> {
    await act(async () => {
      answer.resolve({ kind: "settled", state: "stopped" });
      await answer.promise;
    });
    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
  }

  async function createBackgroundStoppedReceipt() {
    const answer = deferred<SandboxVerbOutcome>();
    mocks.verbAnswer = answer.promise;
    await chooseStop();
    await reloadPendingSandboxStores();
    answerHost(SANDBOX_HOST, CODEX_DOWNLOADING);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const view = render(
      <QueryClientProvider client={client}>
        <PendingSandboxSendsDriver />
      </QueryClientProvider>,
    );

    answerSandboxRows(
      [
        sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: SANDBOX_HOST,
          state: "stopped",
        }),
      ],
      Date.now() + 60_000,
    );
    await act(async () => {
      answer.resolve({ kind: "settled", state: "stopped" });
      await answer.promise;
    });
    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
      expect(
        useStoppedSandboxSendReceiptStore.getState().receipts[SEND_ID],
      ).toBeDefined();
      expect(
        toastSpies.activeReceiptToasts.has(`sandbox-stopped:${SEND_ID}`),
      ).toBe(true);
    });
    return { client, view };
  }

  /** A resting row was read after the strip mounted, before the person chose Stop. */
  it("shows Stop on the created sandbox's collapsed and expanded setup line, then marks it pending", async () => {
    const answer = deferred<SandboxVerbOutcome>();
    mocks.verbAnswer = answer.promise;
    seed({ ...SEEDED, phase: "creating", created: true, elapsedSeconds: 0 });
    // The run saw the created sandbox awake and moved on to its settings.
    useStagedSandboxStore
      .getState()
      .report(SURFACE, { step: "applying", stepAt: Date.now() });
    answerHost(SANDBOX_HOST, CODEX_DOWNLOADING);
    mount();

    const line = await screen.findByTestId("sandbox-setup-line");
    expect(
      screen
        .getByTestId("sandbox-setup-line-toggle")
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(within(line).getByRole("button", { name: "Stop" })).toBeDefined();

    fireEvent.click(screen.getByTestId("sandbox-setup-line-toggle"));
    expect(screen.getByTestId("sandbox-setup-line-detail")).toBeDefined();
    fireEvent.click(within(line).getByRole("button", { name: "Stop" }));

    await waitFor(() => {
      expect(mocks.stopSandbox).toHaveBeenCalledWith("stop");
    });
    expect(screen.getByTestId("sandbox-setup-line").textContent).toContain(
      "Stopping api-refactor · pending",
    );
    expectSendKept();
    await settleStop(answer);
  });

  it("keeps the message and Stop when a list request sent before Stop was chosen resolves at rest after it", async () => {
    const answer = deferred<SandboxVerbOutcome>();
    mocks.verbAnswer = answer.promise;
    seed({ ...SEEDED, elapsedSeconds: 120 });
    answerHost(SANDBOX_HOST, CODEX_DOWNLOADING);
    mount();
    await screen.findByTestId("sandbox-setup-line");
    act(() => {
      useStagedSandboxStore.getState().report(SURFACE, {
        failure: { kind: "settings", code: "SBX-0520" },
      });
    });
    // The list request leaves before Stop is chosen and answers after it.
    const sentAt = Date.now();
    fireEvent.click(await screen.findByTestId("sandbox-setup-stop"));
    await waitFor(() => {
      expect(mocks.stopSandbox).toHaveBeenCalledTimes(1);
    });
    const resting = sandboxSummaryFixture({
      id: SANDBOX_ID,
      hostId: SANDBOX_HOST,
      state: "stopped",
    });
    mocks.listSandboxes.mockResolvedValue(listAnswers([resting]));
    mocks.listReadSentAt = sentAt;
    answerSandboxRows([resting], FRESH);

    await act(async () => {
      await Promise.resolve();
    });
    expectSendKept();
    expect(screen.getByTestId("sandbox-setup-stop")).toBeDefined();
    await settleStop(answer);
  });

  it("keeps the Stop boundary across a reload: a list read sent at the boundary holds the send, one sent after it releases it once", async () => {
    const answer = deferred<SandboxVerbOutcome>();
    mocks.verbAnswer = answer.promise;
    await chooseStop();
    await waitFor(() => {
      expect(mocks.stopSandbox).toHaveBeenCalledTimes(1);
    });
    const boundary =
      usePendingSandboxSendStore.getState().sends[SEND_ID]?.stopRequestedAt;
    if (boundary === undefined) throw new Error("the Stop wrote no boundary");

    await reloadPendingSandboxStores();
    expect(
      usePendingSandboxSendStore.getState().sends[SEND_ID]?.stopRequestedAt,
    ).toBe(boundary);
    answerHost(SANDBOX_HOST, CODEX_DOWNLOADING);
    mount();
    const resting = sandboxSummaryFixture({
      id: SANDBOX_ID,
      hostId: SANDBOX_HOST,
      state: "stopped",
    });
    mocks.listSandboxes.mockResolvedValue(listAnswers([resting]));

    // Arrives fresh but was sent at the boundary: it proves nothing after the Stop.
    mocks.listReadSentAt = boundary;
    answerSandboxRows([resting], FRESH);
    await act(async () => {
      await Promise.resolve();
    });
    expect(usePendingSandboxSendStore.getState().sends[SEND_ID]).toBeDefined();

    mocks.listReadSentAt = boundary + 1;
    answerSandboxRows([resting], FRESH + 1);
    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    expect(createChatCalls()).toEqual([]);
    await act(async () => {
      answer.resolve({ kind: "settled", state: "stopped" });
      await answer.promise;
    });
  });

  it("stops the sandbox exactly once, then returns the send once it is at rest", async () => {
    await chooseStop();

    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    expect(mocks.stopSandbox).toHaveBeenCalledTimes(1);
    expect(mocks.stopSandbox).toHaveBeenCalledWith("stop");
    expect(readStagedSandbox(SURFACE)).toBeNull();
    expect(createChatCalls()).toEqual([]);
  });

  it("keeps the message, the stage and Stop, and says why, when the stop fails", async () => {
    mocks.verbAnswer = Promise.reject(new Error("The sandbox would not stop."));
    mocks.verbAnswer.catch(() => undefined);
    await chooseStop();

    await waitFor(() => {
      expect(screen.getByTestId("sandbox-setup-line").textContent).toContain(
        "Couldn't stop api-refactor · SBX-0701",
      );
    });
    expectSendKept();
    const line = screen.getByTestId("sandbox-setup-line");
    expect(
      within(line)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Retry", "Details"]);
    expect(mocks.stopSandbox).toHaveBeenCalledTimes(1);
  });

  it("offers an enabled Retry after remount even when the mutation error was lost", async () => {
    mocks.verbAnswer = Promise.reject(new Error("The sandbox would not stop."));
    mocks.verbAnswer.catch(() => undefined);
    await chooseStop();

    await waitFor(() => {
      expect(screen.getByTestId("sandbox-setup-line").textContent).toContain(
        "Couldn't stop api-refactor · SBX-0701",
      );
    });
    expectSendKept();

    await reloadPendingSandboxStores();
    mocks.verbState = { isPending: false, error: null };
    const retryAnswer = deferred<SandboxVerbOutcome>();
    mocks.verbAnswer = retryAnswer.promise;
    answerHost(SANDBOX_HOST, CODEX_DOWNLOADING);
    mount();

    const line = await screen.findByTestId("sandbox-setup-line");
    const retry = within(line).getByRole("button", { name: "Retry" });
    expect(retry.hasAttribute("disabled")).toBe(false);
    expect(line.textContent).toContain("Couldn't stop api-refactor · SBX-0701");
    expect(within(line).getByRole("button", { name: "Details" })).toBeDefined();
    expectSendKept();

    fireEvent.click(retry);
    await waitFor(() => {
      expect(mocks.stopSandbox).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByTestId("sandbox-setup-line").textContent).toContain(
      "Stopping api-refactor · pending",
    );
    expectSendKept();
    await settleStop(retryAnswer);
  });

  it("returns nothing and sends nothing while the stop has not answered, then returns the send when it settles", async () => {
    const answer = deferred<SandboxVerbOutcome>();
    mocks.verbAnswer = answer.promise;
    await chooseStop();

    await act(async () => {
      await Promise.resolve();
    });
    expectSendKept();
    expect(mocks.stopSandbox).toHaveBeenCalledTimes(1);

    await act(async () => {
      answer.resolve({ kind: "settled", state: "stopped" });
      await answer.promise;
    });
    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    expect(createChatCalls()).toEqual([]);
  });

  it("opens the task's composer on the stopped sandbox with the message when a stop completes in the strip that requested it", async () => {
    await chooseStopAndConfirmRest();
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"],
    ).toMatchObject({ content: MESSAGE_CONTENT, settings: PICKED_SETTINGS });
    // Unnamed, so its picker is live and the staged sandbox carries its Send:
    // a composer named on a stopped host refuses to send.
    expect(useNewConversationModalOpenStore.getState().request).toMatchObject({
      epicId: "epic-1",
      tabId: "tab-1",
      hostId: null,
    });
    // On the sandbox it was sent to, never the composer's default host: the
    // task draft records it, and the composer stages it when it shows the
    // draft. Nothing is staged or pinned before then.
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"]
        ?.returnedSandbox,
    ).toMatchObject({
      target: {
        kind: "existing",
        hostId: SANDBOX_HOST,
        sandboxId: SANDBOX_ID,
        name: "api-refactor",
        verb: "start",
      },
      clientRequestId: null,
    });
    expect(readStagedSandbox(newConversationSurfaceKey("epic-1"))).toBeNull();
    expect(
      useSurfaceHostSelectionStore.getState().selections[
        newConversationSurfaceKey("epic-1")
      ],
    ).toBeUndefined();
    expect(document.body.textContent).toContain(BACK_IN_COMPOSER_RECEIPT);
    expect(screen.getByRole("button", { name: "Start" })).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Choose another host" }),
    ).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => {
      expect(mocks.stopSandbox).toHaveBeenCalledWith("start");
    });
    expect(createChatCalls()).toEqual([]);
    expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"],
    ).toMatchObject({ content: MESSAGE_CONTENT, settings: PICKED_SETTINGS });
  });

  describe("on a task whose composer stages the message's own sandbox", () => {
    const ADD_AGENT_RECEIPT =
      "Stopped api-refactor. Your message wasn't sent; it's in Add agent.";

    afterEach(() => {
      __getOpenEpicRegistryForTests().disposeAll();
    });

    /** The open composer's own hook, mounted before the Stop, stages what the draft names. */
    async function stopWithOpenComposer(chatIds: readonly string[]) {
      openTask(true, chatIds);
      renderHook(() => useNewConversationReturnedSandbox("epic-1", null));
      await chooseStopAndConfirmRest();
      await waitFor(() => {
        expect(
          readStagedSandbox(newConversationSurfaceKey("epic-1")),
        ).toMatchObject({ target: { kind: "existing", hostId: SANDBOX_HOST } });
      });
    }

    function expectAddAgentReceipt(): void {
      const line = screen.getByTestId("sandbox-stopped-line");
      expect(line.textContent).toContain(ADD_AGENT_RECEIPT);
      expect(
        within(line).getByRole("button", { name: "Add agent" }),
      ).toBeDefined();
      expect(within(line).getByRole("button", { name: "Start" })).toBeDefined();
      expect(
        within(line).getByRole("button", { name: "Choose another host" }),
      ).toBeDefined();
      expect(line.textContent).not.toContain("api-refactor is stopped");
      expect(screen.queryByTestId("rested-task-message-line")).toBeNull();
    }

    it("keeps the Stopped line, saying the message is in Add agent, once the composer stages its sandbox", async () => {
      await stopWithOpenComposer([]);
      expectAddAgentReceipt();
      expect(
        useStoppedSandboxSendReceiptStore.getState().receipts[SEND_ID],
      ).toBeDefined();
    });

    it("keeps the line, with all three actions, after the person closes Add agent", async () => {
      await stopWithOpenComposer([]);

      act(() => {
        useNewConversationModalOpenStore.getState().close();
      });

      expect(useNewConversationModalOpenStore.getState().request).toBeNull();
      expectAddAgentReceipt();
    });

    it("reopens the composer with the message in it on Add agent, keeping the line", async () => {
      await stopWithOpenComposer([]);
      act(() => {
        useNewConversationModalOpenStore.getState().close();
      });

      fireEvent.click(screen.getByRole("button", { name: "Add agent" }));

      expect(useNewConversationModalOpenStore.getState().request).toMatchObject(
        {
          epicId: "epic-1",
          tabId: "tab-1",
          hostId: null,
        },
      );
      expect(
        useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"],
      ).toMatchObject({ content: MESSAGE_CONTENT });
      expectAddAgentReceipt();
    });

    it("says the message is back in the composer, with no Add agent, on a task that has a chat", async () => {
      await stopWithOpenComposer(["chat-1"]);

      const line = screen.getByTestId("sandbox-stopped-line");
      expect(line.textContent).toContain(BACK_IN_COMPOSER_RECEIPT);
      expect(
        within(line).queryByRole("button", { name: "Add agent" }),
      ).toBeNull();
      expect(
        useStoppedSandboxSendReceiptStore.getState().receipts[SEND_ID],
      ).toBeDefined();
    });

    it("still clears the line when the person stages a different sandbox on the task", async () => {
      await stopWithOpenComposer([]);

      act(() => {
        useStagedSandboxStore
          .getState()
          .stage(newConversationSurfaceKey("epic-1"), NEW_TARGET);
      });

      await waitFor(() => {
        expect(screen.queryByTestId("sandbox-stopped-line")).toBeNull();
      });
      expect(
        useStoppedSandboxSendReceiptStore.getState().receipts[SEND_ID],
      ).toBeUndefined();
    });

    it("clears a cancelled receipt when the composer stages the message's own sandbox", async () => {
      openTask(true, []);
      useNewConversationModalStore
        .getState()
        .setContent("epic-1", MESSAGE_CONTENT);
      useNewConversationModalStore.getState().setReturnedSandbox("epic-1", {
        target: START_TARGET,
        clientRequestId: null,
      });
      answerSandboxRows(
        [
          sandboxSummaryFixture({
            id: SANDBOX_ID,
            hostId: SANDBOX_HOST,
            state: "stopped",
          }),
        ],
        1,
      );
      recordCancelledSandboxSend(
        pendingSend({ id: SEND_ID, epicConfirmed: true }),
        {
          kind: "task",
          epicId: "epic-1",
          parentId: null,
          placement: null,
        },
      );
      mount();
      await screen.findByTestId("sandbox-stopped-line");

      renderHook(() => useNewConversationReturnedSandbox("epic-1", null));

      await waitFor(() => {
        expect(screen.queryByTestId("sandbox-stopped-line")).toBeNull();
      });
      expect(
        readStagedSandbox(newConversationSurfaceKey("epic-1")),
      ).toMatchObject({ target: { kind: "existing" } });
    });
  });

  it("saves the stopped message in drafts when the task composer has newer content", async () => {
    const occupiedContent: JsonContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "keep my replacement" }],
        },
      ],
    };
    useNewConversationModalStore
      .getState()
      .setContent("epic-1", occupiedContent);

    await chooseStopAndConfirmRest();
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"],
    ).toMatchObject({ content: occupiedContent });
    expect(useLandingDraftStore.getState().drafts).toMatchObject([
      { content: MESSAGE_CONTENT, settings: PICKED_SETTINGS, closed: true },
    ]);
    expect(useNewConversationModalOpenStore.getState().request).toBeNull();
    expect(mocks.openTile).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(SAVED_DRAFT_RECEIPT);
    // A Stop the person confirmed says "Stopped", never the state footer.
    expect(document.body.textContent).not.toContain("api-refactor is stopped");
    expect(screen.getByRole("button", { name: "Open draft" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Start" })).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Choose another host" }),
    ).toBeDefined();
  });

  it("clears the stopped receipt when the person chooses another host", async () => {
    await chooseStopAndConfirmRest();
    const receipt = BACK_IN_COMPOSER_RECEIPT;
    expect(document.body.textContent).toContain(receipt);

    fireEvent.click(
      screen.getByRole("button", { name: "Choose another host" }),
    );

    await waitFor(() => {
      expect(document.body.textContent).not.toContain(receipt);
    });
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"],
    ).toMatchObject({ content: MESSAGE_CONTENT, settings: PICKED_SETTINGS });
  });

  it("clears a task receipt when an ordinary successful send consumes its composer draft", async () => {
    const taskSurface = newConversationSurfaceKey("epic-1");
    useSurfaceHostSelectionStore
      .getState()
      .setSelection(taskSurface, "pinned-host");

    await chooseStopAndConfirmRest();
    expect(document.body.textContent).toContain(BACK_IN_COMPOSER_RECEIPT);
    // The message is back in the task's composer on the stopped sandbox: its
    // draft records it, and the composer's pin is left as it was.
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"]
        ?.returnedSandbox,
    ).toMatchObject({ target: { kind: "existing", hostId: SANDBOX_HOST } });
    expect(
      useSurfaceHostSelectionStore.getState().selections[taskSurface],
    ).toBe("pinned-host");

    act(() => {
      useNewConversationModalStore.getState().clearDraft("epic-1");
    });

    await waitFor(() => {
      expect(screen.queryByTestId("sandbox-stopped-line")).toBeNull();
    });
    expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    expect(
      useSurfaceHostSelectionStore.getState().selections[taskSurface],
    ).toBe("pinned-host");
  });

  it("clears the stopped receipt when a newer send appears in the task", async () => {
    await chooseStopAndConfirmRest();
    const receipt = BACK_IN_COMPOSER_RECEIPT;
    expect(document.body.textContent).toContain(receipt);

    act(() => {
      usePendingSandboxSendStore.getState().add(
        pendingSend({
          id: "send-2",
          createdAt: Date.now(),
          text: "write the migration",
        }),
      );
    });

    expect(await screen.findByText("write the migration")).toBeDefined();
    expect(document.body.textContent).not.toContain(receipt);
  });

  it("clears the stopped receipt after the sandbox is started", async () => {
    await chooseStopAndConfirmRest();
    const receipt = BACK_IN_COMPOSER_RECEIPT;
    expect(document.body.textContent).toContain(receipt);

    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => {
      expect(mocks.stopSandbox).toHaveBeenCalledWith("start");
    });
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

    await waitFor(() => {
      expect(document.body.textContent).not.toContain(receipt);
    });
  });

  it("updates Start in place without losing the background receipt or its actions", async () => {
    await createBackgroundStoppedReceipt();
    const id = `sandbox-stopped:${SEND_ID}`;
    const initial = toastSpies.activeReceiptToasts.get(id);
    if (initial === undefined)
      throw new Error("Expected the stopped receipt toast");
    const initialView = render(initial.content);
    const initialStart = within(initialView.container).getByRole("button", {
      name: "Start",
    });
    expect(initialStart.hasAttribute("disabled")).toBe(false);

    const startAnswer = deferred<SandboxVerbOutcome>();
    mocks.verbAnswer = startAnswer.promise;
    fireEvent.click(initialStart);
    await waitFor(() => {
      expect(mocks.stopSandbox).toHaveBeenCalledWith("start");
      const updated = toastSpies.activeReceiptToasts.get(id);
      expect(updated).toBeDefined();
      expect(updated?.content).not.toBe(initial.content);
    });

    const updated = toastSpies.activeReceiptToasts.get(id);
    if (updated === undefined)
      throw new Error("Expected the updated receipt toast");
    const updatedView = render(updated.content);
    expect(
      within(updatedView.container)
        .getByRole("button", { name: "Start" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      within(updatedView.container).getByRole("button", {
        name: "Open draft",
      }),
    ).toBeDefined();
    expect(
      within(updatedView.container).getByRole("button", {
        name: "Choose another host",
      }),
    ).toBeDefined();
    expect(
      useStoppedSandboxSendReceiptStore.getState().receipts[SEND_ID],
    ).toBeDefined();
    expect(toastSpies.dismiss).not.toHaveBeenCalledWith(id);

    await act(async () => {
      startAnswer.resolve({ kind: "settled", state: "stopped" });
      await startAnswer.promise;
    });
    await waitFor(() => {
      const settled = toastSpies.activeReceiptToasts.get(id);
      expect(settled).toBeDefined();
      expect(settled?.content).not.toBe(updated.content);
    });
    const settled = toastSpies.activeReceiptToasts.get(id);
    if (settled === undefined)
      throw new Error("Expected the settled receipt toast");
    expect(
      within(render(settled.content).container)
        .getByRole("button", { name: "Start" })
        .hasAttribute("disabled"),
    ).toBe(false);
    expect(
      useStoppedSandboxSendReceiptStore.getState().receipts[SEND_ID],
    ).toBeDefined();
  });

  it("hands a background receipt into a mounted strip while dismissing only its toast", async () => {
    const { client, view } = await createBackgroundStoppedReceipt();
    const id = `sandbox-stopped:${SEND_ID}`;
    view.rerender(
      <QueryClientProvider client={client}>
        <PendingSandboxSendsDriver />
        <StoppedSandboxSendReceiptStrip epicId="epic-1" tabId="tab-1" />
      </QueryClientProvider>,
    );

    const strip = await screen.findByTestId("sandbox-stopped-line");
    await waitFor(() => {
      expect(toastSpies.activeReceiptToasts.has(id)).toBe(false);
    });
    expect(toastSpies.dismiss).toHaveBeenCalledWith(id);
    expect(
      useStoppedSandboxSendReceiptStore.getState().receipts[SEND_ID],
    ).toBeDefined();
    expect(within(strip).getByRole("button", { name: "Start" })).toBeDefined();
  });

  it("ignores the old background dismissal after a receipt returns from a tab to a new toast", async () => {
    const { client, view } = await createBackgroundStoppedReceipt();
    const id = `sandbox-stopped:${SEND_ID}`;
    const originalToast = toastSpies.activeReceiptToasts.get(id);
    if (originalToast === undefined)
      throw new Error("Expected the original background receipt toast");
    toastSpies.dismissalQueue.deferred = true;

    view.rerender(
      <QueryClientProvider client={client}>
        <PendingSandboxSendsDriver />
        <StoppedSandboxSendReceiptStrip epicId="epic-1" tabId="tab-1" />
      </QueryClientProvider>,
    );
    const strip = await screen.findByTestId("sandbox-stopped-line");
    await waitFor(() => {
      expect(toastSpies.activeReceiptToasts.has(id)).toBe(false);
      expect(toastSpies.dismissalQueue.callbacks).toHaveLength(1);
    });
    expect(
      useStoppedSandboxSendReceiptStore.getState().receipts[SEND_ID],
    ).toBeDefined();
    expect(within(strip).getByRole("button", { name: "Start" })).toBeDefined();

    view.rerender(
      <QueryClientProvider client={client}>
        <PendingSandboxSendsDriver />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(toastSpies.activeReceiptToasts.has(id)).toBe(true);
      expect(screen.queryByTestId("sandbox-stopped-line")).toBeNull();
    });
    const republishedToast = toastSpies.activeReceiptToasts.get(id);
    if (republishedToast === undefined)
      throw new Error("Expected the republished background receipt toast");
    expect(republishedToast).not.toBe(originalToast);
    const republishedView = render(republishedToast.content);
    expect(
      within(republishedView.container).getByRole("button", { name: "Start" }),
    ).toBeDefined();

    const oldDismissal = toastSpies.dismissalQueue.callbacks.shift();
    if (oldDismissal === undefined)
      throw new Error("Expected the delayed dismissal callback");
    toastSpies.dismissalQueue.deferred = false;
    act(() => {
      oldDismissal();
    });

    expect(
      useStoppedSandboxSendReceiptStore.getState().receipts[SEND_ID],
    ).toBeDefined();
    expect(toastSpies.activeReceiptToasts.get(id)).toBe(republishedToast);
    expect(
      within(render(republishedToast.content).container).getByRole("button", {
        name: "Start",
      }),
    ).toBeDefined();
  });

  it("removes the durable receipt when the person dismisses its toast", async () => {
    await createBackgroundStoppedReceipt();
    const id = `sandbox-stopped:${SEND_ID}`;

    act(() => {
      toastSpies.dismissByUser(id);
    });

    await waitFor(() => {
      expect(
        useStoppedSandboxSendReceiptStore.getState().receipts[SEND_ID],
      ).toBeUndefined();
    });
    expect(toastSpies.activeReceiptToasts.has(id)).toBe(false);
  });

  it("retires the receipt toast when its returned draft becomes obsolete", async () => {
    await createBackgroundStoppedReceipt();
    const id = `sandbox-stopped:${SEND_ID}`;

    act(() => {
      useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    });

    await waitFor(() => {
      expect(
        useStoppedSandboxSendReceiptStore.getState().receipts[SEND_ID],
      ).toBeUndefined();
      expect(toastSpies.activeReceiptToasts.has(id)).toBe(false);
    });
    expect(toastSpies.dismiss).toHaveBeenCalledWith(id);
  });

  it("keeps a saved-draft receipt in an app toast when a stop completes after its strip is gone", async () => {
    const answer = deferred<SandboxVerbOutcome>();
    mocks.verbAnswer = answer.promise;
    await chooseStop();
    // The strip goes away (reload, background) while the stop is unanswered.
    await reloadPendingSandboxStores();
    answerHost(SANDBOX_HOST, CODEX_DOWNLOADING);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    render(
      <QueryClientProvider client={client}>
        <PendingSandboxSendsDriver />
      </QueryClientProvider>,
    );

    answerSandboxRows(
      [
        sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: SANDBOX_HOST,
          state: "stopped",
        }),
      ],
      Date.now() + 60_000,
    );

    await act(async () => {
      answer.resolve({ kind: "settled", state: "stopped" });
      await answer.promise;
    });
    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    expect(useLandingDraftStore.getState().drafts).toMatchObject([
      { content: MESSAGE_CONTENT, settings: PICKED_SETTINGS, closed: true },
    ]);
    expect(useNewConversationModalOpenStore.getState().request).toBeNull();
    expect(mocks.openTile).not.toHaveBeenCalled();
    expect(createChatCalls()).toEqual([]);

    await waitFor(() => {
      expect(toastSpies.show).toHaveBeenCalled();
    });
    const toastCall = toastSpies.show.mock.calls.at(-1);
    if (toastCall === undefined) throw new Error("Expected stopped-send toast");
    const [toastContent, toastOptions] = toastCall;
    expect(toastOptions?.duration).toBe(Infinity);
    const toastView = render(toastContent);
    expect(toastView.container.textContent).toContain(SAVED_DRAFT_RECEIPT);
    expect(
      within(toastView.container).getByRole("button", { name: "Open draft" }),
    ).toBeDefined();
    expect(
      within(toastView.container).getByRole("button", { name: "Start" }),
    ).toBeDefined();
    expect(
      within(toastView.container).getByRole("button", {
        name: "Choose another host",
      }),
    ).toBeDefined();
    fireEvent.click(
      within(toastView.container).getByRole("button", { name: "Start" }),
    );
    await waitFor(() =>
      expect(mocks.stopSandbox).toHaveBeenCalledWith("start"),
    );
  });

  it("does not recreate a dismissed receipt when the late Stop result follows a row give-back", async () => {
    const answer = deferred<SandboxVerbOutcome>();
    mocks.verbAnswer = answer.promise;
    await chooseStop();
    await waitFor(() => {
      expect(mocks.stopSandbox).toHaveBeenCalledWith("stop");
    });

    // A new window takes over the held Stop while the original verb call waits.
    await reloadPendingSandboxStores();
    answerHost(SANDBOX_HOST, CODEX_DOWNLOADING);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    render(
      <QueryClientProvider client={client}>
        <PendingSandboxSendsDriver />
      </QueryClientProvider>,
    );
    answerSandboxRows(
      [
        sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: SANDBOX_HOST,
          state: "stopped",
        }),
      ],
      Date.now() + 60_000,
    );

    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
      expect(toastSpies.show).toHaveBeenCalledTimes(1);
    });
    const [toastContent, toastOptions] = toastSpies.show.mock.calls[0] ?? [];
    expect(toastOptions?.duration).toBe(Infinity);
    expect(render(toastContent).container.textContent).toContain(
      SAVED_DRAFT_RECEIPT,
    );
    if (toastOptions?.onDismiss === undefined)
      throw new Error("Expected the saved-draft toast to dismiss its receipt");
    Reflect.apply(toastOptions.onDismiss, undefined, []);

    await waitFor(() => {
      expect(toastSpies.dismiss).toHaveBeenCalled();
    });
    expect(useLandingDraftStore.getState().drafts).toMatchObject([
      { content: MESSAGE_CONTENT, settings: PICKED_SETTINGS, closed: true },
    ]);
    expect(useLandingDraftStore.getState().activeDraftId).toBeNull();

    await act(async () => {
      answer.resolve({ kind: "settled", state: "stopped" });
      await answer.promise;
    });
    await waitFor(() => {
      expect(mocks.verbState.isPending).toBe(false);
      expect(toastSpies.show).toHaveBeenCalledTimes(1);
    });
    expect(useLandingDraftStore.getState().drafts).toHaveLength(1);
    expect(useLandingDraftStore.getState().activeDraftId).toBeNull();
    expect(useNewConversationModalOpenStore.getState().request).toBeNull();
    expect(mocks.openTile).not.toHaveBeenCalled();
    expect(createChatCalls()).toEqual([]);
  });

  it.each(["handoff", "creating"] as const)(
    "never clears the held stop, wakes, creates or dispatches when a repair started earlier succeeds late, in the %s phase",
    async (phase) => {
      const answer = deferred<SandboxVerbOutcome>();
      mocks.verbAnswer = answer.promise;
      seed({ ...SEEDED, phase, created: true, elapsedSeconds: 120 });
      // The settings really are unapplied, so the failure is the row's own.
      answerSandboxRows(
        [
          sandboxSummaryFixture({
            id: SANDBOX_ID,
            hostId: SANDBOX_HOST,
            state: "awake",
            guestConfigured: false,
          }),
        ],
        FRESH,
      );
      answerHost(SANDBOX_HOST, CODEX_DOWNLOADING);
      mount();
      await screen.findByTestId("sandbox-setup-line");
      act(() => {
        useStagedSandboxStore.getState().report(SURFACE, {
          failure: { kind: "settings", code: "SBX-0520" },
        });
      });
      fireEvent.click(
        await screen.findByTestId("sandbox-setup-retry-applying"),
      );
      expect(mocks.repairFinishers).toHaveLength(1);
      fireEvent.click(await screen.findByTestId("sandbox-setup-stop"));
      await waitFor(() => {
        expect(mocks.stopSandbox).toHaveBeenCalledTimes(1);
      });

      // The repair, started before the Stop, succeeds now.
      await act(async () => {
        for (const finish of mocks.repairFinishers) finish();
        await Promise.resolve();
      });
      answerSandboxRows(
        [
          sandboxSummaryFixture({
            id: SANDBOX_ID,
            hostId: SANDBOX_HOST,
            state: "awake",
          }),
        ],
        FRESH,
      );

      expectSendKept();
      // The Stop is the send's own record; no stage writer can erase it.
      expect(
        usePendingSandboxSendStore.getState().sends[SEND_ID]?.stopRequested,
      ).toBe(true);
      expect(mocks.wake).not.toHaveBeenCalled();
      expect(mocks.createSandbox).not.toHaveBeenCalled();
      expect(mocks.stopSandbox).toHaveBeenCalledTimes(1);

      await act(async () => {
        answer.resolve({ kind: "settled", state: "stopped" });
        await answer.promise;
      });
      await waitFor(() => {
        expect(usePendingSandboxSendStore.getState().sends).toEqual({});
      });
      expect(createChatCalls()).toEqual([]);
      expect(mocks.createSandbox).not.toHaveBeenCalled();
    },
  );

  it("ends a terminal ask whose guest setup failed while its sandbox was being created, when a Stop that was still moving is followed by a fresh stopped row", async () => {
    mocks.verbAnswer = Promise.resolve<SandboxVerbOutcome>({ kind: "moving" });
    seed({
      ...SEEDED,
      send: { request: { kind: "terminal" }, text: "" },
      phase: "creating",
      created: true,
      elapsedSeconds: 120,
    });
    answerSandboxRows(
      [
        sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: SANDBOX_HOST,
          state: "awake",
          guestConfigured: false,
        }),
      ],
      FRESH,
    );
    mount();
    await screen.findByTestId("sandbox-setup-line");
    act(() => {
      useStagedSandboxStore.getState().report(SURFACE, {
        failure: { kind: "settings", code: "SBX-0520" },
      });
    });
    fireEvent.click(await screen.findByTestId("sandbox-setup-stop"));
    await waitFor(() => {
      expect(mocks.stopSandbox).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      await mocks.verbAnswer;
    });
    expect(usePendingSandboxSendStore.getState().sends[SEND_ID]).toBeDefined();

    answerSandboxRows(
      [
        sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: SANDBOX_HOST,
          state: "stopped",
        }),
      ],
      FRESH + 1,
    );

    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    expect(readStagedSandbox(SURFACE)).toBeNull();
    expect(mocks.openTile).not.toHaveBeenCalled();
    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });

  it("keeps a moving stop across a sign-out that clears every stage, and quietly returns the message on a fresh stopped row once its owner is back", async () => {
    mocks.verbAnswer = Promise.resolve<SandboxVerbOutcome>({ kind: "moving" });
    await chooseStop();
    await act(async () => {
      await mocks.verbAnswer;
    });
    expectSendKept();

    // Sign-out clears every stage; the pending record survives it.
    cleanup();
    useStagedSandboxStore.getState().clearAll();
    act(() => {
      useAuthStore.getState().setSignedOut();
    });
    userSignedIn();
    await reloadPendingSandboxStores();
    answerHost(SANDBOX_HOST, CODEX_READY);
    answerSandboxRows(
      [
        sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: SANDBOX_HOST,
          state: "awake",
        }),
      ],
      FRESH,
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    render(
      <QueryClientProvider client={client}>
        <PendingSandboxSendsDriver />
      </QueryClientProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });

    // Nothing runs while the stop is unanswered, with the agent ready and the row awake.
    expect(
      usePendingSandboxSendStore.getState().sends[SEND_ID]?.stopRequested,
    ).toBe(true);
    expect(createChatCalls()).toEqual([]);
    expect(mocks.wake).not.toHaveBeenCalled();
    expect(mocks.createSandbox).not.toHaveBeenCalled();

    answerSandboxRows(
      [
        sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: SANDBOX_HOST,
          state: "stopped",
        }),
      ],
      FRESH + 1,
    );
    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    expect(createChatCalls()).toEqual([]);
    expect(mocks.wake).not.toHaveBeenCalled();
    expect(useNewConversationModalOpenStore.getState().request).toBeNull();
    expect(mocks.openTile).not.toHaveBeenCalled();
  });

  it("dispatches nothing when the agent is repaired and the sandbox unfrozen while the stop is pending", async () => {
    const answer = deferred<SandboxVerbOutcome>();
    mocks.verbAnswer = answer.promise;
    await chooseStop();
    answerSandboxRows(
      [
        sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: SANDBOX_HOST,
          state: "awake",
          frozen: true,
        }),
      ],
      FRESH,
    );
    answerHost(SANDBOX_HOST, CODEX_READY);
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
    await act(async () => {
      await Promise.resolve();
    });

    expectSendKept();
    expect(mocks.stopSandbox).toHaveBeenCalledTimes(1);
    await act(async () => {
      answer.resolve({ kind: "settled", state: "stopped" });
      await answer.promise;
    });
    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    expect(createChatCalls()).toEqual([]);
  });

  it("keeps the stop latch across a reload, so a repaired agent still dispatches nothing", async () => {
    const answer = deferred<SandboxVerbOutcome>();
    mocks.verbAnswer = answer.promise;
    await chooseStop();
    expect(readStagedSandbox(SURFACE)?.failure).toMatchObject({
      kind: "settings",
      code: "pending-send-stop",
    });

    await reloadPendingSandboxStores();
    answerHost(SANDBOX_HOST, CODEX_READY);
    mount();
    await screen.findByTestId("sandbox-setup-line");
    await act(async () => {
      await Promise.resolve();
    });

    expect(readStagedSandbox(SURFACE)?.failure).toMatchObject({
      kind: "settings",
      code: "pending-send-stop",
    });
    expect(createChatCalls()).toEqual([]);
    expect(usePendingSandboxSendStore.getState().sends[SEND_ID]).toBeDefined();
    answer.resolve({ kind: "settled", state: "stopped" });
  });

  it.each([null, "awake"] as const)(
    "keeps the send when the stop settles with the sandbox %s, and returns it on the first fresh read at rest",
    async (state) => {
      mocks.verbAnswer = Promise.resolve<SandboxVerbOutcome>({
        kind: "settled",
        state,
      });
      await chooseStop();

      await act(async () => {
        await mocks.verbAnswer;
      });
      expectSendKept();

      answerSandboxRows(
        [
          sandboxSummaryFixture({
            id: SANDBOX_ID,
            hostId: SANDBOX_HOST,
            state: "suspended",
          }),
        ],
        FRESH,
      );
      await waitFor(() => {
        expect(usePendingSandboxSendStore.getState().sends).toEqual({});
      });
      expect(mocks.stopSandbox).toHaveBeenCalledTimes(1);
    },
  );

  const SUSPENDED_DRAFT_RECEIPT =
    "build-box is suspended. Your message wasn't sent; it's saved in your drafts.";

  function expectNoStoppedReceipt(): void {
    expect(document.body.textContent).not.toContain("Stopped ");
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Choose another host" }),
    ).toBeNull();
  }

  /** A Stop left unanswered while the sandbox suspends on its own and a fresh row says so. */
  async function suspendBeforeStopAnswers(): Promise<
    Deferred<SandboxVerbOutcome>
  > {
    const answer = deferred<SandboxVerbOutcome>();
    mocks.verbAnswer = answer.promise;
    onTestFinished(async () => {
      await act(async () => {
        answer.resolve({ kind: "settled", state: "suspended" });
        await answer.promise;
      });
    });
    await chooseStop();
    await waitFor(() => {
      expect(mocks.stopSandbox).toHaveBeenCalledWith("stop");
    });
    answerSandboxRows(
      [
        sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: SANDBOX_HOST,
          state: "suspended",
        }),
      ],
      FRESH,
    );
    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    return answer;
  }

  it("says the sandbox is suspended, not Stopped, when a fresh row reads suspended before the Stop answers and the composer is occupied", async () => {
    act(() => {
      useNewConversationModalStore
        .getState()
        .setContent("epic-1", OCCUPIED_NEW_CHAT_CONTENT);
    });
    await suspendBeforeStopAnswers();

    const line = await screen.findByTestId("sandbox-stopped-line");
    expect(line.textContent).toContain(SUSPENDED_DRAFT_RECEIPT);
    expectNoStoppedReceipt();
    expect(useLandingDraftStore.getState().drafts).toMatchObject([
      {
        content: MESSAGE_CONTENT,
        closed: true,
        returnedSandbox: {
          target: {
            kind: "existing",
            hostId: SANDBOX_HOST,
            sandboxId: SANDBOX_ID,
            verb: "resume",
          },
        },
      },
    ]);
  });

  it("puts the message back in the free composer on its resume pick when a fresh row reads suspended before the Stop answers", async () => {
    await suspendBeforeStopAnswers();

    await screen.findByTestId("sandbox-stopped-line");
    expectNoStoppedReceipt();
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"],
    ).toMatchObject({
      content: MESSAGE_CONTENT,
      returnedSandbox: {
        target: { kind: "existing", hostId: SANDBOX_HOST, verb: "resume" },
      },
    });
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
  });

  it("says the sandbox is suspended, not Stopped, when the Stop itself settles suspended", async () => {
    act(() => {
      useNewConversationModalStore
        .getState()
        .setContent("epic-1", OCCUPIED_NEW_CHAT_CONTENT);
    });
    const answer = deferred<SandboxVerbOutcome>();
    mocks.verbAnswer = answer.promise;
    await chooseStop();
    await waitFor(() => {
      expect(mocks.stopSandbox).toHaveBeenCalledWith("stop");
    });
    answerSandboxRows(
      [
        sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: SANDBOX_HOST,
          state: "suspended",
        }),
      ],
      1,
    );
    await act(async () => {
      answer.resolve({ kind: "settled", state: "suspended" });
      await answer.promise;
    });
    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    // The receipt reads the row; the earlier read was too old to return the send itself.
    answerSandboxRows(
      [
        sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: SANDBOX_HOST,
          state: "suspended",
        }),
      ],
      FRESH,
    );

    const line = await screen.findByTestId("sandbox-stopped-line");
    expect(line.textContent).toContain(SUSPENDED_DRAFT_RECEIPT);
    expectNoStoppedReceipt();
  });

  it("still says Stopped, with Start and Choose another host, when the row reads stopped before the Stop answers", async () => {
    act(() => {
      useNewConversationModalStore
        .getState()
        .setContent("epic-1", OCCUPIED_NEW_CHAT_CONTENT);
    });
    const answer = deferred<SandboxVerbOutcome>();
    mocks.verbAnswer = answer.promise;
    onTestFinished(async () => {
      await act(async () => {
        answer.resolve({ kind: "settled", state: "stopped" });
        await answer.promise;
      });
    });
    await chooseStop();
    await waitFor(() => {
      expect(mocks.stopSandbox).toHaveBeenCalledWith("stop");
    });
    answerSandboxRows(
      [
        sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: SANDBOX_HOST,
          state: "stopped",
        }),
      ],
      FRESH,
    );
    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });

    const line = await screen.findByTestId("sandbox-stopped-line");
    expect(line.textContent).toContain(SAVED_DRAFT_RECEIPT);
    expect(screen.getByRole("button", { name: "Start" })).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Choose another host" }),
    ).toBeDefined();
  });

  it("returns a chat's message to its composer with no Stopped receipt and no state receipt when a fresh row reads suspended before the Stop answers", async () => {
    const answer = deferred<SandboxVerbOutcome>();
    mocks.verbAnswer = answer.promise;
    onTestFinished(async () => {
      await act(async () => {
        answer.resolve({ kind: "settled", state: "suspended" });
        await answer.promise;
      });
    });
    seed({
      ...SEEDED,
      elapsedSeconds: 120,
      send: { request: { kind: "message", chatId: "existing-chat" } },
    });
    answerHost(SANDBOX_HOST, CODEX_DOWNLOADING);
    mountInChat();
    await screen.findByTestId("sandbox-setup-line");
    act(() => {
      useStagedSandboxStore.getState().report(SURFACE, {
        failure: { kind: "settings", code: "SBX-0520" },
      });
    });
    fireEvent.click(await screen.findByTestId("sandbox-setup-stop"));
    await waitFor(() => {
      expect(mocks.stopSandbox).toHaveBeenCalledWith("stop");
    });
    answerSandboxRows(
      [
        sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: SANDBOX_HOST,
          state: "suspended",
        }),
      ],
      FRESH,
    );
    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });

    expect(document.body.textContent).not.toContain("Stopped ");
    expect(screen.getByTestId("sandbox-stopped-line").textContent).toBe(
      "Your message wasn't sent; it's back in the composer.",
    );
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
    expect(createChatCalls()).toEqual([]);
  });

  it("puts the message back in the task's composer on its sandbox's resume pick when the task closed before a suspend reached the Stop", async () => {
    await closeTaskThenRowReads("suspended");

    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"],
    ).toMatchObject({
      content: MESSAGE_CONTENT,
      returnedSandbox: {
        target: {
          kind: "existing",
          hostId: SANDBOX_HOST,
          sandboxId: SANDBOX_ID,
          verb: "resume",
        },
      },
    });
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
    expect(document.body.textContent).not.toContain("Stopped ");
  });

  it("saves the message in drafts on its sandbox when the task closed with its composer occupied before a suspend reached the Stop", async () => {
    act(() => {
      useNewConversationModalStore
        .getState()
        .setContent("epic-1", OCCUPIED_NEW_CHAT_CONTENT);
    });
    await closeTaskThenRowReads("suspended");

    expect(useLandingDraftStore.getState().drafts).toMatchObject([
      {
        content: MESSAGE_CONTENT,
        closed: true,
        returnedSandbox: {
          target: {
            kind: "existing",
            hostId: SANDBOX_HOST,
            sandboxId: SANDBOX_ID,
            verb: "resume",
          },
        },
      },
    ]);
  });

  it("saves the message in drafts with no sandbox pick when the task closed before the sandbox stopped", async () => {
    await closeTaskThenRowReads("stopped");

    expect(useLandingDraftStore.getState().drafts).toMatchObject([
      { content: MESSAGE_CONTENT, closed: true, returnedSandbox: null },
    ]);
  });

  /** Shows Stop on an unclaimed send, then makes writes to `storageKey` throw as a full disk would. */
  async function stopWithFailingWrite(storageKey: string) {
    seed({ ...SEEDED, elapsedSeconds: 120 });
    answerHost(SANDBOX_HOST, CODEX_DOWNLOADING);
    mount();
    await screen.findByTestId("sandbox-setup-line");
    act(() => {
      useStagedSandboxStore.getState().report(SURFACE, {
        failure: { kind: "settings", code: "SBX-0520" },
      });
    });
    const stop = await screen.findByTestId("sandbox-setup-stop");

    const originalSetItem = localStorage.setItem.bind(localStorage);
    const failedWrite = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key, value) {
        if (key === storageKey) throw new Error("quota exceeded");
        originalSetItem.call(this, key, value);
      });
    const raised: unknown[] = [];
    const onRejection = (reason: unknown) => raised.push(reason);
    const onError = (event: ErrorEvent) => {
      event.preventDefault();
      raised.push(event.error);
    };
    process.on("unhandledRejection", onRejection);
    window.addEventListener("error", onError);
    onTestFinished(() => {
      process.off("unhandledRejection", onRejection);
      window.removeEventListener("error", onError);
      failedWrite.mockRestore();
    });
    fireEvent.click(stop);
    await waitFor(() => {
      expect(failedWrite).toHaveBeenCalledWith(storageKey, expect.any(String));
    });
    return { raised };
  }

  it("sends no stop and no create, keeps the message, and raises nothing when the Stop cannot be written to the send's record", async () => {
    const { raised } = await stopWithFailingWrite(
      recordMapStorageKey(persistKey(STORE_KEYS.pendingSandboxSend), SEND_ID),
    );
    // One turn of the event loop, where an unhandled rejection surfaces.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(raised).toEqual([]);
    expect(mocks.stopSandbox).not.toHaveBeenCalled();
    expect(createChatCalls()).toEqual([]);
    expect(
      usePendingSandboxSendStore.getState().sends[SEND_ID]?.stopRequested,
    ).not.toBe(true);
    expect(screen.getByTestId("pending-sandbox-message").textContent).toBe(
      "fix the login bug",
    );
  });

  it("still stops and gives the message back, raising nothing, when only the stage's projection of the Stop cannot be written", async () => {
    const { raised } = await stopWithFailingWrite(
      recordMapStorageKey(persistKey(STORE_KEYS.stagedSandboxSend), SURFACE),
    );

    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(raised).toEqual([]);
    expect(mocks.stopSandbox).toHaveBeenCalledTimes(1);
    expect(mocks.stopSandbox).toHaveBeenCalledWith("stop");
    expect(createChatCalls()).toEqual([]);
  });

  it("keeps the send while the sandbox is still moving, and returns it on the first fresh read at rest", async () => {
    mocks.verbAnswer = Promise.resolve<SandboxVerbOutcome>({ kind: "moving" });
    await chooseStop();

    await act(async () => {
      await mocks.verbAnswer;
    });
    expectSendKept();

    answerSandboxRows(
      [
        sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: SANDBOX_HOST,
          state: "stopped",
        }),
      ],
      FRESH,
    );
    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    expect(mocks.stopSandbox).toHaveBeenCalledTimes(1);
  });
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
      "After 45 minutes with no agent turn, running shell or browser tab on screen, this sandbox suspends. Closing this tab does not stop running work or immediately stop charges; storage is charged while it rests.",
    );
  });

  it("shows nothing above an agent that was not a waiting send's", () => {
    usePendingSandboxSendStore.getState().add(delivered());

    render(<SandboxReadyLineForChat chatId="chat-other" />);

    expect(screen.queryByTestId("sandbox-ready-line")).toBeNull();
  });

  it("shows the signed-in account's own ready line, never another account's delivered message in the same chat", () => {
    usePendingSandboxSendStore.getState().add({
      ...delivered(),
      id: "send-other-account",
      userId: "user-other",
      text: "another account's message",
    });
    mocks.sandboxes = [
      sandboxSummaryFixture({
        id: SANDBOX_ID,
        hostId: SANDBOX_HOST,
        displayName: "e2e-sbx-own",
      }),
    ];
    const { rerender } = render(<SandboxReadyLineForChat chatId="chat-1" />);

    expect(screen.queryByTestId("sandbox-ready-line")).toBeNull();

    usePendingSandboxSendStore.getState().add(delivered());
    rerender(<SandboxReadyLineForChat chatId="chat-1" />);

    expect(screen.getByTestId("sandbox-ready-line-toggle").textContent).toBe(
      "Sandbox ready·e2e-sbx-own·24 s",
    );
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

/** A foreign window holds the send's lock: ours queues and its callback never runs. */
function queueBehindForeignHolder(): () => void {
  const original = Object.getOwnPropertyDescriptor(navigator, "locks");
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: (
        _name: string,
        options: LockOptions,
        _callback: () => Promise<void>,
      ) =>
        new Promise<void>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    },
  });
  return () => {
    if (original === undefined) {
      Reflect.deleteProperty(navigator, "locks");
    } else {
      Object.defineProperty(navigator, "locks", original);
    }
  };
}

/** The Drafts actions navigate; where this window's route goes is not under test. */
const navigateNowhere: UseNavigateResult<string> = () => Promise.resolve();

/** Rehydrates the task's new-agent drafts the way a new window does. */
async function reloadTaskDrafts(): Promise<void> {
  const key = persistKey(STORE_KEYS.newConversationDraft);
  const saved = localStorage.getItem(key);
  useNewConversationModalStore.setState({ draftPatchesByEpicId: {} });
  if (saved === null) localStorage.removeItem(key);
  else localStorage.setItem(key, saved);
  await useNewConversationModalStore.persist.rehydrate();
}

/** The task composer's Send: it hands its stage over, as the modal does. */
function sendFromTaskComposer(surfaceKey: string): string {
  const sent: { id: string | null } = { id: null };
  act(() => {
    sent.id = handPendingSandboxSend({
      fromSurfaceKey: surfaceKey,
      epicId: "epic-1",
      request: { kind: "chat", parentId: null, placement: null },
      content: MESSAGE_CONTENT,
      text: "fix the login bug",
      settings: PICKED_SETTINGS,
      epicConfirmed: true,
      now: Date.now(),
    });
  });
  if (sent.id === null) throw new Error("expected the Send to hand over");
  return sent.id;
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

describe("a second Retry request that reaches an owner which is not at a Retry point", () => {
  let restoreLocks: () => void;

  beforeEach(() => {
    restoreLocks = installImmediateExclusiveLocks();
  });

  afterEach(() => {
    restoreLocks();
  });

  /** Request A was taken up and acknowledged; the requester's stale click then wrote B. */
  async function seedAcknowledgedThenStale(): Promise<{
    readonly first: string;
    readonly second: string;
  }> {
    seed(SEEDED);
    const first = await useStagedSandboxStore
      .getState()
      .requestRetry(SURFACE, "user-1", "send-again");
    if (first === null) throw new Error("request A was not recorded");
    useStagedSandboxStore.getState().report(SURFACE, { retryHandledId: first });
    const second = await useStagedSandboxStore
      .getState()
      .requestRetry(SURFACE, "user-1", "send-again");
    if (second === null) throw new Error("request B was not recorded");
    return { first, second };
  }

  /** The real owner takes up request A first; the requester's stale click then writes B. */
  async function ownerAcknowledgesThenStale(): Promise<string> {
    seed(SEEDED);
    holdAgentDownloading();
    useStagedSandboxStore.getState().report(SURFACE, {
      failure: { kind: "not-sent" },
    });
    mount();
    const first = await useStagedSandboxStore
      .getState()
      .requestRetry(SURFACE, "user-1", "send-again");
    if (first === null) throw new Error("request A was not recorded");
    await waitFor(() => {
      expect(readStagedSandbox(SURFACE)?.retryHandledId).toBe(first);
    });
    // The retry cleared the failure: the owner now waits on the agent.
    expect(readStagedSandbox(SURFACE)?.failure ?? null).toBeNull();
    const second = await useStagedSandboxStore
      .getState()
      .requestRetry(SURFACE, "user-1", "send-again");
    if (second === null) throw new Error("request B was not recorded");
    return second;
  }

  /** The agent is still downloading, so the send is current but not ready. */
  function holdAgentDownloading(): void {
    answerHost(SANDBOX_HOST, CODEX_DOWNLOADING);
  }

  /** A fresh awake row and a ready agent: the one ordinary delivery. */
  async function expectOneOrdinaryDelivery(): Promise<void> {
    answerHost(SANDBOX_HOST, CODEX_READY);
    await waitForCreateChats(1);
    await waitFor(() => {
      expect(
        usePendingSandboxSendStore.getState().sends[SEND_ID],
      ).toMatchObject({ delivery: { hostId: SANDBOX_HOST } });
    });
    expect(createChatCalls()).toHaveLength(1);
    expect(mocks.wake).not.toHaveBeenCalled();
    expect(mocks.createSandbox).not.toHaveBeenCalled();
    // Delivered, not given back to a composer draft.
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"],
    ).toBeUndefined();
  }

  function expectCopyUntouched(): void {
    expect(createChatCalls()).toEqual([]);
    expect(mocks.wake).not.toHaveBeenCalled();
    expect(mocks.createSandbox).not.toHaveBeenCalled();
    expect(usePendingSandboxSendStore.getState().sends[SEND_ID]).toMatchObject({
      delivery: null,
    });
  }

  it("acknowledges the refused request B once the owner is waiting, and never delivers the copy for it", async () => {
    const second = await ownerAcknowledgesThenStale();
    const before = mocks.modelRefetches.length;

    await waitFor(() => {
      expect(readStagedSandbox(SURFACE)?.retryHandledId).toBe(second);
    });
    expectCopyUntouched();
    expect(mocks.modelRefetches.length).toBe(before);

    // The refused request must not mask the ordinary progress of the send.
    await expectOneOrdinaryDelivery();
  });

  it("acknowledges a refused request B and keeps the held Stop, the failure and the copy", async () => {
    const { second } = await seedAcknowledgedThenStale();
    useStagedSandboxStore.getState().report(SURFACE, {
      failure: { kind: "failed", code: "wake", step: "booting" },
    });
    const stopStage = readStagedSandbox(SURFACE);
    if (stopStage === null) throw new Error("the stage is missing");
    usePendingSandboxSendStore.setState((state) => ({
      sends: {
        ...state.sends,
        [SEND_ID]: { ...state.sends[SEND_ID], stopRequested: true, stopStage },
      },
    }));

    mount();

    await waitFor(() => {
      expect(readStagedSandbox(SURFACE)?.retryHandledId).toBe(second);
    });
    expect(
      usePendingSandboxSendStore.getState().sends[SEND_ID]?.stopRequested,
    ).toBe(true);
    expect(readStagedSandbox(SURFACE)?.failure).toMatchObject({
      kind: "failed",
      code: "wake",
    });
    expectCopyUntouched();

    // The ordinary recovery of the held Stop still completes on a fresh stopped row.
    answerSandboxRows(
      [
        sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: SANDBOX_HOST,
          state: "stopped",
        }),
      ],
      Date.now() + 60_000,
    );
    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    expect(createChatCalls()).toEqual([]);
  });

  it("keeps request B acknowledged and the copy undelivered across a reload", async () => {
    const { second } = await seedAcknowledgedThenStale();
    holdAgentDownloading();
    await reloadPendingSandboxStores();
    mount();

    await waitFor(() => {
      expect(readStagedSandbox(SURFACE)?.retryHandledId).toBe(second);
    });
    expectCopyUntouched();

    await expectOneOrdinaryDelivery();
  });
});

describe("a retry-family button chosen in a window that does not own the send", () => {
  const CASES = [
    {
      label: "Retry after a refusal",
      action: "retry-stage",
      testId: "sandbox-refusal-retry",
      failure: { kind: "unverified" },
      shape: { phase: "handoff", created: true, elapsedSeconds: 24 },
    },
    {
      label: "Retry after a failed wake",
      action: "retry-stage",
      testId: "sandbox-setup-retry",
      failure: { kind: "failed", code: "wake", step: "booting" },
      shape: { phase: "handoff", created: true, elapsedSeconds: 24 },
    },
    {
      label: "Retry creation",
      action: "retry-creation",
      testId: "sandbox-setup-retry-creation",
      failure: { kind: "failed", code: "create", step: "creating" },
      shape: { phase: "creating", created: false, elapsedSeconds: 24 },
    },
    {
      label: "Keep waiting",
      action: "keep-waiting",
      testId: "sandbox-setup-keep-waiting",
      failure: null,
      shape: { phase: "creating", created: false, elapsedSeconds: 3600 },
    },
  ] as const;

  it.each(CASES)(
    "$label writes a request and runs nothing here",
    async ({ action, testId, failure, shape }) => {
      seed({ ...SEEDED, ...shape });
      if (failure !== null)
        useStagedSandboxStore.getState().report(SURFACE, { failure });
      const restoreQueued = queueBehindForeignHolder();
      try {
        mount();
        const button = await screen.findByTestId(testId);
        // Queued behind a foreign holder: this window does not own the send.
        expect(ownsPendingSandboxSend(SEND_ID)).toBe(false);

        fireEvent.click(button);

        await waitFor(() => {
          expect(readStagedSandbox(SURFACE)?.retryRequest).toMatchObject({
            userId: "user-1",
            action,
          });
        });
        expect(mocks.wake).not.toHaveBeenCalled();
        expect(mocks.createSandbox).not.toHaveBeenCalled();
        expect(createChatCalls()).toEqual([]);
      } finally {
        restoreQueued();
      }
    },
  );
});

describe("an owner that takes up each kind of retry request", () => {
  let restoreLocks: () => void;

  beforeEach(async () => {
    // A run an earlier case started on the shared surface must end first.
    await waitFor(
      () => {
        expect(stagedRunActive(SURFACE)).toBe(false);
      },
      { timeout: 8000 },
    );
    restoreLocks = installImmediateExclusiveLocks();
    answerHost(SANDBOX_HOST, CODEX_READY);
  });

  afterEach(() => {
    restoreLocks();
  });

  async function requestAndMount(
    action: "retry-stage" | "retry-creation" | "keep-waiting",
  ): Promise<string> {
    const id = await useStagedSandboxStore
      .getState()
      .requestRetry(SURFACE, "user-1", action);
    if (id === null) throw new Error("the request was not recorded");
    mount();
    return id;
  }

  it("runs a wake Retry as one wake of the same sandbox, acknowledges it and settles to one delivery", async () => {
    seed({ ...SEEDED, phase: "creating", created: true });
    useStagedSandboxStore.getState().report(SURFACE, {
      failure: { kind: "failed", code: "wake", step: "booting" },
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
    const id = await requestAndMount("retry-stage");

    await waitFor(() => {
      expect(readStagedSandbox(SURFACE)?.retryHandledId).toBe(id);
    });
    // The wake's run ends in the ordinary delivery; nothing outlives the case.
    await waitForCreateChats(1);
    await waitFor(() => {
      expect(stagedRunActive(SURFACE)).toBe(false);
    });
    expect(mocks.wake).toHaveBeenCalledTimes(1);
    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });

  it("takes a refusal Retry as the readiness plan, acknowledges it and creates no other sandbox", async () => {
    seed(SEEDED);
    useStagedSandboxStore.getState().report(SURFACE, {
      failure: { kind: "unverified" },
    });
    const id = await requestAndMount("retry-stage");

    await waitFor(() => {
      expect(readStagedSandbox(SURFACE)?.retryHandledId).toBe(id);
    });
    expect(mocks.createSandbox).not.toHaveBeenCalled();
    expect(mocks.wake).not.toHaveBeenCalled();
    expect(usePendingSandboxSendStore.getState().sends[SEND_ID]).toBeDefined();
  });

  it("runs Retry creation as one fresh create and acknowledges it", async () => {
    seed({
      ...SEEDED,
      send: { epicConfirmed: true },
      phase: "creating",
      created: false,
    });
    mocks.createSandbox.mockResolvedValue(CREDITS_REFUSED);
    useStagedSandboxStore.getState().report(SURFACE, {
      failure: { kind: "failed", code: "create", step: "creating" },
    });
    const before = readStagedSandbox(SURFACE)?.clientRequestId;
    const id = await requestAndMount("retry-creation");

    await waitFor(() => {
      expect(readStagedSandbox(SURFACE)?.retryHandledId).toBe(id);
    });
    await waitFor(() => {
      expect(mocks.createSandbox).toHaveBeenCalledTimes(1);
    });
    expect(mocks.createSandbox.mock.calls[0][0].clientRequestId).not.toBe(
      before,
    );
    expect(mocks.wake).not.toHaveBeenCalled();
  });

  it("runs Keep waiting after the wait budget ran out as one take-up of the same create", async () => {
    seed({
      ...SEEDED,
      send: { epicConfirmed: true },
      phase: "creating",
      created: false,
      elapsedSeconds: 3600,
    });
    mocks.createSandbox.mockResolvedValue(CREDITS_REFUSED);
    useStagedSandboxStore.getState().report(SURFACE, {
      failure: { kind: "timed-out", step: "creating" },
    });
    const before = readStagedSandbox(SURFACE)?.clientRequestId;
    const id = await requestAndMount("keep-waiting");

    await waitFor(() => {
      expect(readStagedSandbox(SURFACE)?.retryHandledId).toBe(id);
    });
    await waitFor(() => {
      expect(mocks.createSandbox).toHaveBeenCalledTimes(1);
    });
    expect(mocks.createSandbox.mock.calls[0][0].clientRequestId).toBe(before);
    expect(mocks.wake).not.toHaveBeenCalled();
  });

  /** The record's persisted boundary, read at the instant an effect leaves. */
  function recordedBoundary(): number {
    return (
      usePendingSandboxSendStore.getState().sends[SEND_ID]
        ?.observationRequestedAt ?? 0
    );
  }

  it("persists the observation boundary before the owner's direct Retry creation reaches the control plane", async () => {
    seed({
      ...SEEDED,
      send: { epicConfirmed: true },
      phase: "creating",
      created: false,
    });
    useStagedSandboxStore.getState().report(SURFACE, {
      failure: { kind: "failed", code: "create", step: "creating" },
    });
    const before = recordedBoundary();
    const atCreate: number[] = [];
    mocks.createSandbox.mockImplementation(() => {
      atCreate.push(recordedBoundary());
      return Promise.resolve(CREDITS_REFUSED);
    });
    mount();

    fireEvent.click(await screen.findByTestId("sandbox-setup-retry-creation"));

    await waitFor(() => {
      expect(mocks.createSandbox).toHaveBeenCalledTimes(1);
    });
    expect(atCreate[0]).toBeGreaterThan(before);
  });

  it("persists the observation boundary before the owner's direct Keep waiting reaches the control plane", async () => {
    seed({
      ...SEEDED,
      send: { epicConfirmed: true },
      phase: "creating",
      created: false,
      elapsedSeconds: 3600,
    });
    useStagedSandboxStore.getState().report(SURFACE, {
      failure: { kind: "timed-out", step: "creating" },
    });
    const before = recordedBoundary();
    const atCreate: number[] = [];
    mocks.createSandbox.mockImplementation(() => {
      atCreate.push(recordedBoundary());
      return Promise.resolve(CREDITS_REFUSED);
    });
    mount();

    fireEvent.click(await screen.findByTestId("sandbox-setup-keep-waiting"));

    await waitFor(() => {
      expect(mocks.createSandbox).toHaveBeenCalledTimes(1);
    });
    expect(atCreate[0]).toBeGreaterThan(before);
  });

  it("persists the observation boundary before the owner's direct wake Retry wakes the sandbox", async () => {
    seed({ ...SEEDED, phase: "creating", created: true });
    useStagedSandboxStore.getState().report(SURFACE, {
      failure: { kind: "failed", code: "wake", step: "booting" },
    });
    const before = recordedBoundary();
    const atWake: number[] = [];
    mocks.wake.mockImplementation(() => {
      atWake.push(recordedBoundary());
      return Promise.resolve({ kind: "awake" });
    });
    mount();

    fireEvent.click(await screen.findByTestId("sandbox-setup-retry"));

    await waitFor(() => {
      expect(mocks.wake).toHaveBeenCalledTimes(1);
    });
    expect(atWake[0]).toBeGreaterThan(before);
  });
});

describe("the record of an accepted create and the row it was seen as", () => {
  let restoreLocks: () => void;
  const freshList = (sentAt: number) =>
    ({ kind: "list", sentAt, mountedAt: 0 }) as const;

  /** The accepted create still booting, held by this window's driver. */
  function ownedWithHandedSend(sendFields: Partial<PendingSandboxSend>): void {
    seed({ ...SEEDED, phase: "creating", created: true, send: sendFields });
    answerHost(SANDBOX_HOST, CODEX_READY);
    mocks.listSandboxes.mockResolvedValue(listAnswers([]));
    mocks.listReadSentAt = 0;
    answerSandboxRows([], 0);
    mount();
  }
  const record = (sandboxId: string) =>
    usePendingSandboxSendStore
      .getState()
      .recordCreatedSandbox(SEND_ID, sandboxId);
  const markSeen = (
    sandboxId: string,
    observation: PendingSandboxObservation,
  ) =>
    usePendingSandboxSendStore
      .getState()
      .markSandboxRowSeen(SEND_ID, sandboxId, observation);
  const stored = () =>
    usePendingSandboxSendStore.getState().sends[SEND_ID]?.createdSandbox;

  beforeEach(() => {
    restoreLocks = installImmediateExclusiveLocks();
  });
  afterEach(async () => {
    cleanup();
    // A run a case started on the shared surface must end before the next.
    await waitFor(
      () => {
        expect(stagedRunActive(SURFACE)).toBe(false);
      },
      { timeout: 8000 },
    );
    restoreLocks();
  });

  it("is written unseen by the owner and read back, and a fresh present read marks it seen", async () => {
    ownedWithHandedSend({});
    await waitFor(() => {
      expect(record(SANDBOX_ID)).toBe(true);
    });
    expect(stored()).toEqual({ sandboxId: SANDBOX_ID, rowSeen: false });
    expect(markSeen(SANDBOX_ID, freshList(Date.now() + 60_000))).toBe(true);
    expect(stored()).toEqual({ sandboxId: SANDBOX_ID, rowSeen: true });
  });

  it("survives a reload, seen or not", async () => {
    ownedWithHandedSend({});
    await waitFor(() => {
      expect(record(SANDBOX_ID)).toBe(true);
    });
    await reloadPendingSandboxStores();
    expect(stored()).toEqual({ sandboxId: SANDBOX_ID, rowSeen: false });
    mount();
    await waitFor(() => {
      expect(markSeen(SANDBOX_ID, freshList(Date.now() + 60_000))).toBe(true);
    });
    await reloadPendingSandboxStores();
    expect(stored()).toEqual({ sandboxId: SANDBOX_ID, rowSeen: true });
  });

  it("is not undone by a stale window's snapshot of the same sandbox, but a new sandbox id still starts unseen", async () => {
    ownedWithHandedSend({});
    await waitFor(() => {
      expect(record(SANDBOX_ID)).toBe(true);
    });
    const stale = usePendingSandboxSendStore.getState().sends;
    expect(markSeen(SANDBOX_ID, freshList(Date.now() + 60_000))).toBe(true);

    // A window holding the unseen record persists its own change afterwards.
    usePendingSandboxSendStore.setState({
      sends: {
        ...stale,
        [SEND_ID]: { ...stale[SEND_ID], observationRequestedAt: Date.now() },
      },
    });
    await reloadPendingSandboxStores();
    expect(stored()).toEqual({ sandboxId: SANDBOX_ID, rowSeen: true });

    mount();
    await waitFor(() => {
      expect(record("sbx_next")).toBe(true);
    });
    await reloadPendingSandboxStores();
    expect(stored()).toEqual({ sandboxId: "sbx_next", rowSeen: false });
  });

  it("is about one sandbox: another id is not marked seen, and a new create id starts unseen again", async () => {
    ownedWithHandedSend({});
    await waitFor(() => {
      expect(record(SANDBOX_ID)).toBe(true);
    });
    expect(markSeen("sbx_other", freshList(Date.now() + 60_000))).toBe(false);
    expect(stored()).toEqual({ sandboxId: SANDBOX_ID, rowSeen: false });
    expect(markSeen(SANDBOX_ID, freshList(Date.now() + 60_000))).toBe(true);
    expect(record("sbx_next")).toBe(true);
    expect(stored()).toEqual({ sandboxId: "sbx_next", rowSeen: false });
  });

  it.each([
    ["a read sent before the request", freshList(0)],
    [
      "a read of unknown provenance",
      { kind: "list", sentAt: null, mountedAt: 0 },
    ],
    [
      "an absence",
      {
        kind: "list",
        sentAt: Date.now() + 60_000,
        mountedAt: 0,
        missingSandboxId: SANDBOX_ID,
      },
    ],
    ["a non-list observation", { kind: "intent" }],
  ] as const)(
    "does not mark the row seen on %s",
    async (_name, observation) => {
      ownedWithHandedSend({});
      await waitFor(() => {
        expect(record(SANDBOX_ID)).toBe(true);
      });
      expect(markSeen(SANDBOX_ID, observation)).toBe(false);
      expect(stored()).toEqual({ sandboxId: SANDBOX_ID, rowSeen: false });
    },
  );

  it("is never written for another account's send, or for a send nobody owns", async () => {
    ownedWithHandedSend({ userId: "user-other" });
    await act(async () => {
      await Promise.resolve();
    });
    expect(record(SANDBOX_ID)).toBe(false);
    expect(stored()).toBeUndefined();
    expect(
      usePendingSandboxSendStore
        .getState()
        .recordCreatedSandbox("no-such-send", SANDBOX_ID),
    ).toBe(false);
  });

  it("registers a resumed creating stage's learned id that has no record yet, and keeps waiting through misses instead of calling it gone", async () => {
    const fresh = Date.now() + 60_000;
    // Written before the record existed: created id on the stage, no metadata.
    seed({ ...SEEDED, phase: "creating", created: true });
    answerHost(SANDBOX_HOST, CODEX_READY);
    mocks.listSandboxes.mockResolvedValue(listAnswers([]));
    mocks.listReadSentAt = fresh;
    answerSandboxRows([], fresh);
    mount();
    mocks.listReadSentAt = fresh + 1;
    answerSandboxRows([], fresh + 1);
    await act(async () => {
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(stored()).toEqual({ sandboxId: SANDBOX_ID, rowSeen: false });
    });
    expect(usePendingSandboxSendStore.getState().sends[SEND_ID]).toBeDefined();
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
  });

  it("is absent on a legacy record, which keeps the old reading and is not marked seen by a stranger id", async () => {
    seed(SEEDED);
    answerHost(SANDBOX_HOST, CODEX_READY);
    mocks.listSandboxes.mockResolvedValue(listAnswers([]));
    mocks.listReadSentAt = 0;
    answerSandboxRows([], 0);
    mount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(stored()).toBeUndefined();
    expect(markSeen(SANDBOX_ID, freshList(Date.now() + 60_000))).toBe(false);
    expect(stored()).toBeUndefined();
  });
});

describe("a task with no chat whose message came back to its own composer on a sandbox at rest", () => {
  const FRESH = Date.now() + 60_000;
  const EXACT_SUSPENDED =
    "build-box is suspended. Your message wasn't sent; it's in Add agent.";
  const EXACT_STOPPED =
    "build-box is stopped. Your message wasn't sent; it's in Add agent.";
  const LINE = "rested-task-message-line";

  afterEach(() => {
    __getOpenEpicRegistryForTests().disposeAll();
  });

  function rowIn(state: SandboxSummary["state"]): SandboxSummary {
    return sandboxSummaryFixture({
      id: SANDBOX_ID,
      hostId: SANDBOX_HOST,
      state,
      guestConfigured: true,
    });
  }

  /** What a give-back to the task's own composer leaves: the message and its sandbox. */
  function messageBackOn(target: StagedSandboxTarget): void {
    const modal = useNewConversationModalStore.getState();
    modal.setContent("epic-1", MESSAGE_CONTENT);
    modal.setReturnedSandbox("epic-1", { target, clientRequestId: null });
  }

  function atRest(state: "suspended" | "stopped"): void {
    answerSandboxRows([rowIn(state)], FRESH);
  }

  it.each([
    ["suspended", EXACT_SUSPENDED],
    ["stopped", EXACT_STOPPED],
  ] as const)(
    "says the message is in Add agent on a %s sandbox, with the action and no toast",
    async (state, exact) => {
      openTask(true, []);
      messageBackOn(RESUME_TARGET);
      atRest(state);
      mount();

      const line = await screen.findByTestId(LINE);
      expect(line.textContent).toContain(exact);
      expect(
        within(line).getByRole("button", { name: "Add agent" }),
      ).toBeDefined();
      expect(toastSpies.show).not.toHaveBeenCalled();
    },
  );

  it("says it again after the draft is rehydrated as a reload would", async () => {
    openTask(true, []);
    messageBackOn(RESUME_TARGET);
    atRest("suspended");
    await reloadTaskDrafts();
    mount();

    const line = await screen.findByTestId(LINE);
    expect(line.textContent).toContain(EXACT_SUSPENDED);
  });

  it("opens this task's new-conversation modal on Add agent, unnamed, with the message in place", async () => {
    openTask(true, []);
    messageBackOn(RESUME_TARGET);
    atRest("suspended");
    mount();

    fireEvent.click(
      within(await screen.findByTestId(LINE)).getByRole("button", {
        name: "Add agent",
      }),
    );

    expect(useNewConversationModalOpenStore.getState().request).toMatchObject({
      epicId: "epic-1",
      tabId: "tab-1",
      placement: null,
      parentId: null,
      hostId: null,
    });
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"],
    ).toMatchObject({ content: MESSAGE_CONTENT });
  });

  describe("says nothing", () => {
    /** The strip has rendered with every input in place and shows no line. */
    async function expectNoLine(): Promise<void> {
      mount();
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.queryByTestId(LINE)).toBeNull();
    }

    it("for a draft the person typed", async () => {
      openTask(true, []);
      useNewConversationModalStore
        .getState()
        .setContent("epic-1", MESSAGE_CONTENT);
      atRest("suspended");
      await expectNoLine();
    });

    it("for a returned sandbox with an empty message", async () => {
      openTask(true, []);
      messageBackOn(RESUME_TARGET);
      useNewConversationModalStore.getState().setContent("epic-1", {
        type: "doc",
        content: [{ type: "paragraph" }],
      });
      atRest("suspended");
      await expectNoLine();
    });

    it("once the sandbox has been woken", async () => {
      openTask(true, []);
      messageBackOn(RESUME_TARGET);
      atRest("suspended");
      mount();
      await screen.findByTestId(LINE);

      answerSandboxRows([rowIn("awake")], FRESH + 1);

      await waitFor(() => {
        expect(screen.queryByTestId(LINE)).toBeNull();
      });
    });

    it("once the message has been sent", async () => {
      openTask(true, []);
      messageBackOn(RESUME_TARGET);
      atRest("suspended");
      mount();
      await screen.findByTestId(LINE);

      act(() => {
        useNewConversationModalStore.getState().clearDraft("epic-1");
      });

      await waitFor(() => {
        expect(screen.queryByTestId(LINE)).toBeNull();
      });
    });

    it("for a task that has a chat", async () => {
      openTask(true, ["chat-1"]);
      messageBackOn(RESUME_TARGET);
      atRest("suspended");
      await expectNoLine();
    });

    it("until the task's snapshot has loaded", async () => {
      const handle = openTask(false, []);
      messageBackOn(RESUME_TARGET);
      atRest("suspended");
      await expectNoLine();

      act(() => {
        handle.store.setState({ snapshotLoaded: true });
      });

      expect((await screen.findByTestId(LINE)).textContent).toContain(
        EXACT_SUSPENDED,
      );
    });

    it("for another account's returned sandbox", async () => {
      openTask(true, []);
      messageBackOn(RESUME_TARGET);
      useNewConversationModalStore.setState((state) => {
        const draft = state.draftPatchesByEpicId["epic-1"];
        if (draft?.returnedSandbox === undefined) return state;
        return {
          draftPatchesByEpicId: {
            ...state.draftPatchesByEpicId,
            "epic-1": {
              ...draft,
              returnedSandbox: { ...draft.returnedSandbox, userId: "user-2" },
            },
          },
        };
      });
      atRest("suspended");
      await expectNoLine();
    });

    it("for an awake sandbox the account has frozen", async () => {
      openTask(true, []);
      messageBackOn(RESUME_TARGET);
      answerSandboxRows(
        [
          sandboxSummaryFixture({
            id: SANDBOX_ID,
            hostId: SANDBOX_HOST,
            state: "awake",
            frozen: true,
          }),
        ],
        FRESH,
      );
      await expectNoLine();
    });

    it("for a returned sandbox that is not yet created", async () => {
      openTask(true, []);
      messageBackOn(NEW_TARGET);
      atRest("suspended");
      await expectNoLine();
    });

    it("while the task has a pending send", async () => {
      openTask(true, []);
      messageBackOn(RESUME_TARGET);
      atRest("suspended");
      const creation = deferred<SandboxCreateFetchResult>();
      mocks.createSandbox.mockReturnValue(creation.promise);
      seed({
        ...SEEDED,
        send: { epicConfirmed: true },
        phase: "creating",
        created: false,
      });
      mount();

      await screen.findByTestId("pending-sandbox-sends");
      expect(screen.queryByTestId(LINE)).toBeNull();
      await act(async () => {
        creation.resolve(CREDITS_REFUSED);
        await creation.promise;
      });
    });
  });

  describe("beside a receipt for the same message", () => {
    /** A send found at rest on a restart: its message goes back to the composer. */
    async function recoverSendFoundAtRest(): Promise<void> {
      onTestFinished(installImmediateExclusiveLocks());
      seed({
        ...SEEDED,
        target: RESUME_TARGET,
        send: { request: { kind: "chat", parentId: null, placement: null } },
        phase: "creating",
        created: true,
      });
      mocks.listReadAt = FRESH;
      mocks.sandboxes = [rowIn("suspended")];
      mocks.listSandboxes.mockResolvedValue(listAnswers([rowIn("suspended")]));
      answerHost(SANDBOX_HOST, CODEX_READY);
      mount();
      await waitFor(() => {
        expect(usePendingSandboxSendStore.getState().sends).toEqual({});
      });
    }

    it("shows only the task's line for a rested receipt that returned to the task", async () => {
      openTask(true, []);
      await recoverSendFoundAtRest();

      expect((await screen.findByTestId(LINE)).textContent).toContain(
        EXACT_SUSPENDED,
      );
      expect(screen.queryByTestId("sandbox-stopped-line")).toBeNull();
    });

    it("keeps the rested receipt's own line for a task that has a chat", async () => {
      openTask(true, ["chat-1"]);
      await recoverSendFoundAtRest();

      const line = await screen.findByTestId("sandbox-stopped-line");
      expect(line.textContent).toContain(
        "build-box is suspended · your next message resumes it",
      );
      expect(screen.queryByTestId(LINE)).toBeNull();
    });

    it.each(["stopped", "cancelled"] as const)(
      "keeps a %s receipt's own line and hides the task's",
      async (kind) => {
        openTask(true, []);
        messageBackOn(RESUME_TARGET);
        // Read before the receipt, so the list does not outlive it.
        answerSandboxRows([rowIn("suspended")], 1);
        const send = pendingSend({ id: SEND_ID, epicConfirmed: true });
        const returned = {
          kind: "task",
          epicId: "epic-1",
          parentId: null,
          placement: null,
          draftId: null,
        } as const;
        if (kind === "cancelled") {
          recordCancelledSandboxSend(send, returned);
        } else {
          useStagedSandboxStore.getState().stage(SURFACE, RESUME_TARGET);
          useStagedSandboxStore.getState().report(SURFACE, {
            createdSandboxId: SANDBOX_ID,
            createdHostId: SANDBOX_HOST,
          });
          const stage = readStagedSandbox(SURFACE);
          if (stage === null) throw new Error("expected the send's stage");
          recordStoppedSandboxSend(send, stage, "build-box", returned);
        }
        mount();

        const line = await screen.findByTestId("sandbox-stopped-line");
        expect(line.textContent).not.toContain("is suspended. Your message");
        expect(screen.queryByTestId(LINE)).toBeNull();
      },
    );
  });
});

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

/** The task's real open-epic store, its snapshot loaded or not, holding `chatIds`. */
function openTask(
  snapshotLoaded: boolean,
  chatIds: readonly string[],
): OpenEpicStoreHandle {
  const handle = __getOpenEpicRegistryForTests().acquire("epic-1", () =>
    openStoreForTest({
      epicId: "epic-1",
      userId: null,
      factories: {
        streamClientFactory: noopStreamClientFactory,
        laneSelection: null,
      },
      writeCommand: null,
    }),
  );
  act(() => {
    handle.store.setState({
      snapshotLoaded,
      chats: { allIds: [...chatIds], byId: {} },
    });
  });
  return handle;
}

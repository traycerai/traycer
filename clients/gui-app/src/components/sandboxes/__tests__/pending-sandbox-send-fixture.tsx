/**
 * A message sent to a staged sandbox waits in its task, behind the setup line,
 * until the agent the person asked for is ready on the sandbox.
 *
 * The driver, the strip, the stores and the staged run are the real ones. What
 * is faked is what lives outside the window: the control plane's create and
 * list, the account's host directory, and each host's `harnesses` and
 * `providers` answers, `epic.createChat` and the terminal create.
 */
import type { NestedFocusProvenance } from "@/lib/epic-nested-focus-navigation";
import type { TaskHostRow } from "@traycer/protocol/host/task-host-summary";
import { useSyncExternalStore } from "react";
import { installLegendListTestClock } from "@/components/chat/__tests__/legend-list-test-environment";
import { TabHostContext } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";

import type { ReactNode } from "react";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ExternalToast } from "sonner";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";

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
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, vi } from "vitest";
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
  pendingSend,
  providerRow,
} from "@/lib/sandboxes/__tests__/pending-send-fixtures";

import { handPendingSandboxSend } from "@/lib/sandboxes/pending-sandbox-send";

import { takeReturnedSandboxRestored } from "@/lib/sandboxes/returned-sandbox";
import type { UseNavigateResult } from "@tanstack/react-router";
import { useAccountContextStore } from "@/stores/auth/account-context-store";
import { useAuthStore } from "@/stores/auth/auth-store";

import {
  readStagedSandbox,
  useStagedSandboxStore,
  type StagedSandbox,
  type StagedSandboxTarget,
} from "@/stores/composer/staged-sandbox-store";
import { useInitialChatHandoffStore } from "@/stores/epics/initial-chat-handoff-store";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";

import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";
import {
  pendingSendSurfaceKey,
  usePendingSandboxSendStore,
  type PendingSandboxSend,
} from "@/stores/sandboxes/pending-sandbox-send-store";
import { useStoppedSandboxSendReceiptStore } from "@/stores/sandboxes/stopped-sandbox-send-receipt-store";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import {
  composerSurfaceKey,
  newConversationSurfaceKey,
  useSurfaceHostSelectionStore,
} from "@/stores/host/surface-host-selection-store";
import { browserTabId } from "@/lib/browser-tab-identity";
import { persistKey, STORE_KEYS } from "@/lib/persist";

import { recordMapStoragePrefix } from "@/lib/persist/keys";
import {
  PendingSandboxSendForChat,
  PendingSandboxSendStrip,
  PendingSandboxSendsDriver,
} from "../pending-sandbox-sends";

import type { SplitPaneComponentProps } from "@/components/epic-canvas/canvas/split-container";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";

import { PaneOpener } from "@/components/epic-canvas/canvas/pane-opener";
import type { KeybindingRouter } from "@/lib/keybindings/dispatch";

import type { HostOptions } from "@/components/settings/host-scope/use-host-options";

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

export const SANDBOX_HOST = "sbx-host";

export const TASK_PIN_HOST = "task-pin-host";

const START_PAGE_PIN_HOST = "start-page-pin-host";

export const SANDBOX_ID = "sbx-1";

export const SEND_ID = "send-1";

export const SURFACE = pendingSendSurfaceKey(SEND_ID);

export const OCCUPIED_NEW_CHAT_CONTENT: JsonContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "keep my other draft" }],
    },
  ],
};

export const NO_AGENT_SENTENCE = "Agents can't run on api-refactor.";

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

export interface HostAnswers {
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
  openTile:
    vi.fn<(intent: unknown, provenance: NestedFocusProvenance) => void>(),
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
  /** The account's host directory, as the host chips and "Use <host>" read it. */
  directoryRows: [] as HostDirectoryEntry[],
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

// The hosts the "Use <host>" action names, as the host chips list them.
vi.mock("@/components/settings/host-scope/use-host-options", async () => {
  const { hostOptionsFixture, hostScopeOptionFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  let cached: {
    readonly from: readonly HostDirectoryEntry[];
    readonly options: HostOptions;
  } | null = null;
  return {
    useHostOptions: () => {
      if (cached?.from !== mocks.directoryRows)
        cached = {
          from: mocks.directoryRows,
          options: hostOptionsFixture({
            hosts: mocks.directoryRows.map((entry) =>
              hostScopeOptionFixture({
                hostId: entry.hostId,
                name: entry.label,
                isLocalMachine: false,
              }),
            ),
          }),
        };
      return cached.options;
    },
  };
});

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

export const NEW_TARGET: Extract<StagedSandboxTarget, { kind: "new" }> = {
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

export const RESUME_TARGET: Extract<StagedSandboxTarget, { kind: "existing" }> =
  {
    kind: "existing",
    hostId: SANDBOX_HOST,
    sandboxId: SANDBOX_ID,
    name: "build-box",
    configuration: { kind: "personal" },
    verb: "resume",
  };

export const START_TARGET: Extract<StagedSandboxTarget, { kind: "existing" }> =
  {
    ...RESUME_TARGET,
    verb: "start",
  };

export const TEAM_TARGET: Extract<StagedSandboxTarget, { kind: "new" }> = {
  ...NEW_TARGET,
  configuration: { kind: "team", teamId: "team-9", teamName: "Acme" },
};

export function answerHost(hostId: string, answers: HostAnswers): void {
  mocks.hostAnswers.set(hostId, answers);
  notifyAnswerListeners();
}

export function answerSandboxRows(
  sandboxes: SandboxSummary[],
  readAt: number,
): void {
  mocks.sandboxes = sandboxes;
  mocks.listReadAt = readAt;
  notifyAnswerListeners();
}

export function notifyAnswerListeners(): void {
  mocks.answerVersion += 1;
  act(() => {
    for (const listener of mocks.answerListeners) listener();
  });
}

/** Codex's pack is preparing on the sandbox, Claude is ready beside it. */
export const CODEX_DOWNLOADING: HostAnswers = {
  harnesses: [
    harnessRow("codex", { available: false }),
    harnessRow("claude", { available: true }),
  ],
  providers: [
    providerRow("codex", { status: "downloading", percent: 40 }),
    providerRow("claude-code", { status: "installed" }),
  ],
};

export const CODEX_READY: HostAnswers = {
  harnesses: [
    harnessRow("codex", { available: true }),
    harnessRow("claude", { available: true }),
  ],
  providers: [
    providerRow("codex", { status: "installed" }),
    providerRow("claude-code", { status: "installed" }),
  ],
};

export const CODEX_UNAVAILABLE: HostAnswers = {
  harnesses: [
    harnessRow("codex", { available: false }),
    harnessRow("claude", { available: true }),
  ],
  providers: [providerRow("codex", null), providerRow("claude-code", null)],
};

export const CODEX_SETUP_FAILED: HostAnswers = {
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

export const CODEX_NOT_OFFERED: HostAnswers = {
  harnesses: [harnessRow("claude", { available: true })],
  providers: [providerRow("claude-code", { status: "installed" })],
};

/** The woken sandbox's own Traycer Inference switch is off. */
export const TRAYCER_OFF: HostAnswers = {
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
export const PANE = { kind: "tab", paneId: "pane-2", index: null } as const;

/** A fork asked of a staged sandbox, as the fork dialog hands it over. */
export const FORK_REQUEST = {
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
export const SEND_BY_KIND: Readonly<
  Record<"chat" | "fork" | "terminal", SeedOptions["send"]>
> = {
  chat: {},
  fork: { request: FORK_REQUEST },
  terminal: { request: { kind: "terminal" }, text: "" },
};

export const SEEDED: SeedOptions = {
  send: {},
  target: NEW_TARGET,
  phase: "handoff",
  created: true,
  elapsedSeconds: 24,
};

/** A message handed to its task, its create `phase` along. */
export function seed(options: SeedOptions): void {
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
export const RUNNER_HOST = createFakeRunnerHost({});

export function mount() {
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
export function mountInTileBoundTo(tileHostId: string) {
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
export function mountInChat() {
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

export async function waitForCreateChats(count: number): Promise<void> {
  await waitFor(() => {
    expect(createChatCalls()).toHaveLength(count);
  });
}

export function createChatCalls(): CreateChatCall[] {
  return mocks.createChatCalls.filter(isCreateChatCall);
}

/** Every composer surface's stage; a pending send's own stage is not one. */
export function composerStages(): Readonly<
  Record<string, StagedSandbox | undefined>
> {
  const pending = pendingSendSurfaceKey("");
  return Object.fromEntries(
    Object.entries(useStagedSandboxStore.getState().bySurface).filter(
      ([key]) => !key.startsWith(pending),
    ),
  );
}

export function getSetupAction(testId: string): HTMLElement {
  const direct = screen.queryByTestId(testId);
  if (direct !== null) return direct;
  const more = screen.queryByRole("button", { name: "More" });
  if (more !== null) fireEvent.pointerDown(more, { button: 0 });
  return screen.getByTestId(testId);
}

export async function findSetupAction(testId: string): Promise<HTMLElement> {
  const direct = screen.queryByTestId(testId);
  if (direct !== null) return direct;
  const more = screen.queryByRole("button", { name: "More" });
  if (more !== null) fireEvent.pointerDown(more, { button: 0 });
  return screen.findByTestId(testId);
}

/**
 * A give-back writes only the record on the draft that takes the message: no
 * composer surface is staged, and the task composer holds no restored mark
 * for it. The composer showing the draft stages it.
 */
export function expectOnlyTheRecordWritten(
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

export function listAnswers(rows: SandboxSummary[]): SandboxListFetchResult {
  return { kind: "ok", response: { sandboxes: rows } };
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

export async function resolvePendingCreate(
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
export function installImmediateExclusiveLocks(): () => void {
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
export function expectSendRecovered(kind: "chat" | "fork"): void {
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

export function userSignedIn(): void {
  useAuthStore
    .getState()
    .setSignedIn(
      { userId: "user-1", userName: "U", email: "u@example.com" },
      { userId: "user-1", username: "U" },
      [],
    );
}

/**
 * Lets chains of async work settle. `waitFor` and `findBy*` advance this clock
 * synchronously and give promises only a few turns; `advanceTimersByTimeAsync`
 * yields to the event loop between timers.
 */
export async function settleAsyncWork(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
}

// Declared first, so it runs last: a run a case started is asleep on this clock
// between polls, and has to wake once to see its stage is gone, or it holds the
// shared surface against the next case.
afterEach(async () => {
  cleanup();
  if (!vi.isFakeTimers()) return;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_100);
  });
});

beforeEach(() => {
  installLegendListTestClock();
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
  // The task's new-agent composer and the Start Page each pin a host the
  // directory names, so "Use <host>" says whose chip the message goes back to.
  mocks.directoryRows = [
    { ...dialableHost(TASK_PIN_HOST), label: "Task host" },
    { ...dialableHost(START_PAGE_PIN_HOST), label: "Start host" },
  ];
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
  useSurfaceHostSelectionStore.setState({
    selections: {
      [newConversationSurfaceKey("epic-1")]: TASK_PIN_HOST,
      [composerSurfaceKey(browserTabId())]: START_PAGE_PIN_HOST,
    },
  });
  useSettingsEnvironmentPickStore.setState({ pick: null });
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useComposerDraftStore.setState({ drafts: {} });
});

afterEach(() => {
  cleanup();
  useAuthStore.getState().setSignedOut();
});

export const CREDITS_REFUSED: SandboxCreateFetchResult = {
  kind: "refused",
  status: 402,
  code: "insufficient_credit",
  reason: null,
  shortfallMc: 120,
  newRateMcPerHour: null,
  currentAwakeBurnMcPerHour: null,
  message: "refused",
};

/** Every key at any depth of a parsed JSON value. */
export function flattenKeys(value: unknown): Record<string, true> {
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
export function sendOf(json: string): Record<string, unknown> {
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
export function queueBehindForeignHolder(): () => void {
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
export const navigateNowhere: UseNavigateResult<string> = () =>
  Promise.resolve();

/** Rehydrates the task's new-agent drafts the way a new window does. */
export async function reloadTaskDrafts(): Promise<void> {
  const key = persistKey(STORE_KEYS.newConversationDraft);
  const saved = localStorage.getItem(key);
  useNewConversationModalStore.setState({ draftPatchesByEpicId: {} });
  if (saved === null) localStorage.removeItem(key);
  else localStorage.setItem(key, saved);
  await useNewConversationModalStore.persist.rehydrate();
}

/** The task composer's Send: it hands its stage over, as the modal does. */
export function sendFromTaskComposer(surfaceKey: string): string {
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
export async function reloadPendingSandboxStores(): Promise<void> {
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

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

/** The task's real open-epic store, its snapshot loaded or not, holding `chatIds`. */
export function openTask(
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

export {
  mirrorMountHosts,
  environmentListClientHosts,
  mocks,
  handoffHold,
  sessionBridge,
  toastSpies,
};

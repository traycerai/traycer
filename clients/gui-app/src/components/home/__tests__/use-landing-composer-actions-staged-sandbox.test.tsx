/**
 * A send to a staged sandbox opens its task at once.
 *
 * `startTaskOnStagedSandbox` hands the message to the new task before it
 * navigates, opens the task's tab, and only then sends `epic.create` with no
 * chat in it: the first agent is created on the sandbox, once the agent the
 * person asked for is ready there. The action, the stores and the navigation
 * seam are the real ones; `epic.create` is the host's.
 */
import { handLandingSandboxSend } from "@/components/home/hooks/landing-sandbox-send-handoff";
import { useLandingComposerActions } from "@/components/home/hooks/use-landing-composer-actions";
import type { LandingPlacementTarget } from "@/lib/composer/landing-placement";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  HostMethodVersionUnsatisfiedError,
  HostRequestAbortedError,
  HostRpcError,
  HostTransportFailureError,
  negotiatedVersionMeetsRequirement,
  RetryableTransportError,
  type RequiredHostMethodVersion,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { returnedSandboxMessageLine } from "@/lib/sandboxes/sandbox-strings";
import {
  installHostDirectoryRows,
  resetHostDirectoryRows,
  sandboxHostEntry,
} from "@/lib/sandboxes/__tests__/sandbox-host-directory-fixture";
// Type-only, so it is erased before `vi.hoisted` runs and cannot re-enter the
// module this file mocks.
import type { ImageReclaimOutcome } from "@/lib/composer/landing-image-store";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { toast } from "sonner";
import { wasEpicCreatedThisSession } from "@/lib/epics/session-created-epics";
import { DISCARD_CREATED_EPIC_FAILED_COPY } from "@/hooks/epic/use-epic-batch-delete-mutation";
import type { ImageBytes } from "@/lib/attachments/image-bytes";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  registerExtraImageRootSource,
  resetLandingImageBudgetReservationsForTesting,
} from "@/lib/composer/landing-image-budget";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useInitialChatHandoffStore } from "@/stores/epics/initial-chat-handoff-store";
import {
  emptyLandingDraftWorkspaceSnapshot,
  LANDING_DRAFT_PERSIST_KEY,
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { draftRuntimeRegistry } from "@/stores/home/draft-runtime-registry";
import { useTabsStore } from "@/stores/tabs/store";
import { setSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useWorkspaceFoldersStore } from "@/stores/workspace/workspace-folders-store";
import { useWorktreeIntentStagingStore } from "@/stores/worktree/worktree-intent-staging-store";
import {
  returnPendingSandboxSend,
  returnPendingSandboxSendToSandbox,
} from "@/lib/sandboxes/pending-sandbox-send";
import {
  recordCancelledSandboxSend,
  useStoppedSandboxSendReceiptStore,
} from "@/stores/sandboxes/stopped-sandbox-send-receipt-store";
import {
  readStagedSandbox,
  useStagedSandboxStore,
  type StagedSandboxTarget,
} from "@/stores/composer/staged-sandbox-store";
import {
  pendingSendSurfaceKey,
  usePendingSandboxSendStore,
} from "@/stores/sandboxes/pending-sandbox-send-store";
import {
  MESSAGE_CONTENT,
  PICKED_SETTINGS,
} from "@/lib/sandboxes/__tests__/pending-send-fixtures";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { useLandingReturnedSandbox } from "@/hooks/sandboxes/use-returned-sandbox-stage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import { resetDraftBlobTransportForTests } from "@/lib/drafts/draft-blob-transport";
import { resetCloudDraftImageRecoveryForTests } from "@/lib/drafts/cloud-draft-image-recovery";

interface CapturedNavigation {
  readonly search?: (
    previous: Readonly<Record<string, unknown>>,
  ) => Readonly<Record<string, unknown>>;
}

const landingMocks = vi.hoisted(() => ({
  /** The binding the rollback's delete resolves its placement host's requester through. */
  binding: {
    directory: {
      list: (): Promise<readonly []> => Promise.resolve([]),
      onChange: () => ({ dispose: () => undefined }),
    },
    hostClient: {
      createRequesterForHostId: (hostId: string) => ({
        /**
         * A read that carries a version floor is answered by what this
         * host's connection negotiated, as the transport does before it
         * writes a frame: below the floor it is refused and nothing is sent.
         */
        requestWithSignalRequiringHostMethodVersion: (
          method: string,
          payload: unknown,
          _signal: AbortSignal | undefined,
          requirement: RequiredHostMethodVersion,
        ): Promise<unknown> => {
          landingMocks.floors.push({ hostId, method, requirement });
          const negotiated = (landingMocks.connections.get(hostId) ??
            landingMocks.modernConnection)[requirement.method];
          if (!negotiatedVersionMeetsRequirement(negotiated, requirement)) {
            return Promise.reject(
              new HostMethodVersionUnsatisfiedError({
                requirement,
                negotiated,
                requestId: "request-floor",
                method,
                hostId,
              }),
            );
          }
          return landingMocks.routed(hostId, method, payload);
        },
        request: (method: string, payload: unknown): Promise<unknown> =>
          landingMocks.routed(hostId, method, payload),
        getActiveHostId: () => hostId,
        getRequestContextUserId: () => "user-landing",
      }),
    },
  },
  /** What a host that serves both record lists to the end negotiates. */
  modernConnection: {
    "epic.listChatRecords": { major: 1, minor: 3 },
    "epic.listTuiAgents": { major: 1, minor: 3 },
  } as Readonly<Record<string, { major: number; minor: number }>>,
  /** What a host's connection negotiated, where a test says it differs. */
  connections: new Map<
    string,
    Readonly<Record<string, { major: number; minor: number }>>
  >(),
  /** Every call that carried a version floor, by the host it reached. */
  floors: [] as Array<{
    hostId: string;
    method: string;
    requirement: RequiredHostMethodVersion;
  }>,
  routed: (
    hostId: string,
    method: string,
    payload: unknown,
  ): Promise<unknown> => {
    if (method === "epic.batchDelete") {
      return landingMocks.deleteRequest(hostId, payload);
    }
    if (method === "epic.listChatRecords" || method === "epic.listTuiAgents") {
      return landingMocks.readRequest(hostId, method, payload);
    }
    return Promise.reject(new Error(`unexpected ${method}`));
  },
  request: vi.fn<(method: string, payload: unknown) => Promise<unknown>>(),
  /**
   * The rollback's reads of what the task holds, by the host id their
   * requester was made for. They answer an empty snapshot unless a test says.
   */
  readRequest:
    vi.fn<
      (hostId: string, method: string, payload: unknown) => Promise<unknown>
    >(),
  /** The rollback's `epic.batchDelete`, by the host id its requester was made for. */
  deleteRequest:
    vi.fn<(hostId: string, payload: unknown) => Promise<unknown>>(),
  createTerminalAgent: vi.fn<(input: unknown) => Promise<void>>(),
  navigate: vi.fn<(options: CapturedNavigation) => void>(),
  getActiveHostId: vi.fn<() => string | null>(() => "host-landing"),
  getRequestContextUserId: vi.fn<() => string | null>(() => "user-landing"),
  getLocalHostId: vi.fn<() => string | null>(() => "host-local-typing"),
  getActiveHost: vi.fn<() => HostDirectoryEntry | null>(() => ({
    hostId: "host-landing",
    label: "Local",
    kind: "local",
    websocketUrl: "ws://127.0.0.1:4917/rpc",
    version: "0.0.0-test",
    transportDialability: "dialable",
  })),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => landingMocks.navigate,
  useRouter: () => ({ state: { location: { pathname: "/" } } }),
}));

vi.mock("@/lib/host", () => ({
  useHostBinding: () => landingMocks.binding,
  useHostClient: () => ({
    request: landingMocks.request,
    requestWithSignalRequiringHostMethodVersion: (
      method: string,
      payload: unknown,
    ): Promise<unknown> => landingMocks.request(method, payload),
    requestWithOptions: (method: string, payload: unknown): Promise<unknown> =>
      landingMocks.request(method, payload),
    getActiveHostId: landingMocks.getActiveHostId,
    getActiveHost: landingMocks.getActiveHost,
    getRequestContextUserId: landingMocks.getRequestContextUserId,
  }),
}));

vi.mock("@/lib/host/runtime", () => ({
  activeHostIdOrNull: () => landingMocks.getActiveHostId(),
  getHostBindingSnapshot: () => ({
    hostClient: { getActiveHostId: landingMocks.getActiveHostId },
    directory: { getLocalHostId: landingMocks.getLocalHostId },
  }),
}));

vi.mock("@/hooks/agent/use-create-tui-agent", () => ({
  useCreateTuiAgentForClient: () => ({
    create: landingMocks.createTerminalAgent,
    isPending: false,
  }),
}));

/** Narrowed on the members a landing create reads rather than cast. */
function isStubHostClient(
  value: unknown,
): value is HostClient<HostRpcRegistry> {
  return (
    typeof value === "object" &&
    value !== null &&
    "getActiveHostId" in value &&
    "getRequestContextUserId" in value
  );
}

function useTestPlacementTarget(): LandingPlacementTarget {
  return {
    resolvedHostId: landingMocks.getActiveHostId(),
    client: useHostClient(),
    hostLabel: "Local",
    isPinned: false,
    namedHostDead: false,
  };
}

/** The second argument the saved-in-Drafts toast passes `toast`. */
interface OpenDraftToastOptions {
  readonly action: { readonly label: string; readonly onClick: () => void };
}

/** One toast the person was shown, in the order it was shown. */
interface ShownToast {
  readonly via: "toast" | "error" | "info";
  readonly message: string;
  /** The label of its action, when it has one. */
  readonly action: string | null;
}

const { toastMessage, toastLog } = vi.hoisted(() => ({
  toastMessage:
    vi.fn<
      (message: string, options: OpenDraftToastOptions | undefined) => void
    >(),
  toastLog: [] as ShownToast[],
}));

vi.mock("sonner", () => ({
  toast: Object.assign(
    (message: string, options: OpenDraftToastOptions | undefined) => {
      toastLog.push({
        via: "toast",
        message,
        action: options === undefined ? null : options.action.label,
      });
      toastMessage(message, options);
    },
    {
      error: vi.fn((message: string) => {
        toastLog.push({ via: "error", message, action: null });
      }),
      info: vi.fn((message: string) => {
        toastLog.push({ via: "info", message, action: null });
      }),
    },
  ),
}));

const imageStoreMocks = vi.hoisted(() => ({
  sessionImageBytes: vi.fn<(hash: string) => Uint8Array | null>(() => null),
  getImageBytes: vi.fn<(hash: string) => Promise<Uint8Array | undefined>>(() =>
    Promise.resolve(undefined),
  ),
  imageHashKeys: vi.fn<() => Promise<string[]>>(() => Promise.resolve([])),
  sessionHashKeys: vi.fn<() => ReadonlySet<string>>(() => new Set<string>()),
  deleteImageBytesUnchecked: vi.fn<() => Promise<void>>(() =>
    Promise.resolve(),
  ),
  releaseSession: vi.fn(),
  ensureMeasuredImageSizes: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  landingImageSizesHydrated: vi.fn<() => boolean>(() => true),
  measuredLandingImageSize: vi.fn<(hash: string) => number | null>(() => null),
  hasLandingImageBytes: vi.fn<(hash: string) => boolean>(() => false),
  flushReclaimCustody: vi.fn<() => Promise<number>>(() => Promise.resolve(0)),
  reclaimImageBytes: vi.fn<
    (hash: string, isRooted: () => boolean) => Promise<ImageReclaimOutcome>
  >(() => Promise.resolve("absent")),
}));

vi.mock("@/lib/composer/landing-image-store", () => ({
  sha256Hex: async (bytes: ImageBytes): Promise<string> => {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  },
  sessionImageBytes: imageStoreMocks.sessionImageBytes,
  getImageBytes: imageStoreMocks.getImageBytes,
  imageHashKeys: imageStoreMocks.imageHashKeys,
  sessionHashKeys: imageStoreMocks.sessionHashKeys,
  deleteImageBytesUnchecked: imageStoreMocks.deleteImageBytesUnchecked,
  releaseSession: imageStoreMocks.releaseSession,
  ensureMeasuredImageSizes: imageStoreMocks.ensureMeasuredImageSizes,
  landingImageSizesHydrated: imageStoreMocks.landingImageSizesHydrated,
  measuredLandingImageSize: imageStoreMocks.measuredLandingImageSize,
  hasLandingImageBytes: imageStoreMocks.hasLandingImageBytes,
  flushReclaimCustody: imageStoreMocks.flushReclaimCustody,
  reclaimImageBytes: imageStoreMocks.reclaimImageBytes,
}));

const composerLiveImageRoots = new Set<string>();
registerExtraImageRootSource({ hashes: () => [...composerLiveImageRoots] });

const SUBMITTED_PROMPT = "Plan the host chat bootstrap";
const TEST_HOST_ID = "host-landing";
const PLACEMENT_HOST_ID = "host-placement";

const ACME_OWNER = { teamId: "t1", slug: "acme" } as const;

const HOST_TOO_OLD = "This host can't create team tasks yet. Update the host.";

function hasEpicCreateRequest(): boolean {
  return landingMocks.request.mock.calls.some(
    (call) => call[0] === "epic.create",
  );
}

function epicCreatePayload(): unknown {
  return landingMocks.request.mock.calls.find(
    (call) => call[0] === "epic.create",
  )?.[1];
}

/** The payload's `chat` and `epic.id`, narrowed structurally. */
function chatFromCreatePayload(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null) return "absent";
  if (!("chat" in payload)) return "absent";
  return payload.chat;
}

function epicIdFromCreatePayload(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  if (!("epic" in payload)) return null;
  const epic = payload.epic;
  if (typeof epic !== "object" || epic === null || !("id" in epic)) return null;
  return typeof epic.id === "string" ? epic.id : null;
}

/** Lets every pending microtask and the next macrotask run. */
async function flushPending(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

function deletedIdsOf(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null) return [];
  if (!("ids" in payload) || !Array.isArray(payload.ids)) return [];
  return payload.ids.filter((id): id is string => typeof id === "string");
}

/** The task id `epic.create` was sent with. */
function createdEpicId(): string {
  const id = epicIdFromCreatePayload(epicCreatePayload());
  if (id === null) throw new Error("epic.create was never sent");
  return id;
}

/** The `snapshot` arm `epic.listChatRecords` / `epic.listTuiAgents` answer. */
function heldRows(method: string, rows: ReadonlyArray<object>): unknown {
  return method === "epic.listChatRecords"
    ? { kind: "snapshot", listStamp: null, chats: rows }
    : { kind: "snapshot", listStamp: null, tuiAgents: rows };
}

const READ_METHODS = ["epic.listChatRecords", "epic.listTuiAgents"] as const;

/** The share gate's refusals that mean the task is still being set up. */
const PROMOTION_PENDING_CODES = [
  "E_SHARE_PENDING_BUSY",
  "E_SHARE_PENDING_RECENT_ATTEMPT",
  "E_SHARE_PENDING_OFFLINE",
  "E_SHARE_PENDING_UNVERIFIED",
  "E_SHARE_PENDING_FAILED",
] as const;

const SETTING_UP_LINE =
  "This task was still being set up. Send again in a moment.";
const BACK_IN_COMPOSER_LINE =
  "Couldn't send your message. It's back in the composer.";
const NOT_SENT_LINE = "Couldn't send your message.";
const SAVED_IN_DRAFTS_LINE =
  "Your message wasn't sent; it's saved in your drafts.";
const STORAGE_FULL_LINE =
  "The host computer is out of disk space. Free some space on it, then try again.";

function errorToast(message: string): ShownToast {
  return { via: "error", message, action: null };
}

const DRAFTS_TOAST: ShownToast = {
  via: "toast",
  message: SAVED_IN_DRAFTS_LINE,
  action: "Open draft",
};

/** `epic.attachEnvironment` refused because the task is still being set up. */
function attachBusy(): HostRpcError {
  return attachRefusal("E_SHARE_PENDING_BUSY");
}

function attachRefusal(code: HostRpcError["code"]): HostRpcError {
  return new HostRpcError({
    code,
    message: "This task cannot be attached to that team.",
    requestId: "request-attach-refused",
    method: "epic.attachEnvironment",
    fatalDetails: null,
  });
}

function newQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

describe("useLandingComposerActions.startTaskOnStagedSandbox", () => {
  beforeEach(() => {
    usePendingSandboxSendStore.setState({ sends: {} });
    useStagedSandboxStore.setState({ bySurface: {} });
    __resetTabNavigationControllerForTesting();
    draftRuntimeRegistry.resetForTesting();
    window.localStorage.clear();
    useAuthStore
      .getState()
      .setSignedIn(
        { userId: "user-landing", userName: "U", email: "u@example.com" },
        { userId: "user-landing", username: "U" },
        [],
      );
    toastLog.length = 0;
    resetNegotiatedManifests();
    landingMocks.connections.clear();
    landingMocks.floors.length = 0;
    useStoppedSandboxSendReceiptStore.setState({ receipts: {}, strips: {} });
    landingMocks.request.mockReset();
    landingMocks.createTerminalAgent.mockReset();
    landingMocks.navigate.mockReset();
    landingMocks.getRequestContextUserId.mockReset();
    landingMocks.getRequestContextUserId.mockReturnValue("user-landing");
    landingMocks.readRequest.mockReset();
    landingMocks.readRequest.mockImplementation((_hostId, method) =>
      Promise.resolve(heldRows(method, [])),
    );
    landingMocks.deleteRequest.mockReset();
    landingMocks.deleteRequest.mockImplementation((_hostId, payload) =>
      Promise.resolve({
        results: deletedIdsOf(payload).map((taskId) => ({
          taskId,
          success: true,
        })),
      }),
    );
    landingMocks.request.mockResolvedValue({ roomInfo: null });
    landingMocks.createTerminalAgent.mockResolvedValue(undefined);
    landingMocks.getActiveHostId.mockReset();
    landingMocks.getActiveHostId.mockReturnValue(TEST_HOST_ID);
    landingMocks.getLocalHostId.mockReset();
    landingMocks.getLocalHostId.mockReturnValue("host-local-typing");
    landingMocks.getActiveHost.mockReset();
    landingMocks.getActiveHost.mockReturnValue({
      hostId: TEST_HOST_ID,
      label: "Local",
      kind: "local",
      websocketUrl: "ws://127.0.0.1:4917/rpc",
      version: "0.0.0-test",
      transportDialability: "dialable",
    });
    imageStoreMocks.sessionImageBytes.mockReset();
    imageStoreMocks.sessionImageBytes.mockReturnValue(null);
    imageStoreMocks.getImageBytes.mockReset();
    imageStoreMocks.getImageBytes.mockResolvedValue(undefined);
    resetDraftBlobTransportForTests();
    resetCloudDraftImageRecoveryForTests();
    resetLandingImageBudgetReservationsForTesting();
    composerLiveImageRoots.clear();
    useInitialChatHandoffStore.getState().resetForTests();
    useComposerRunSettingsStore.getState().resetForTests();
    useWorkspaceFoldersStore.setState({ byHost: {} });
    useWorktreeIntentStagingStore.getState().resetForTests();
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    useTabsStore.setState({
      items: [],
      activeItemId: null,
      systemTabs: { history: null, settings: null },
      stripOrder: [],
    });
    useEpicCanvasStore.setState({
      tabsById: {},
      openTabOrder: [],
      activeTabId: null,
      mostRecentTabIdByEpicId: {},
    });
    useSettingsStore.setState({
      defaultSelection: { harnessId: "codex", modelSlug: "", profileId: null },
      defaultPermission: "supervised",
      defaultReasoning: "high",
    });
    useSelectionAuthorityStore.setState({
      attached: true,
      effectiveHostId: TEST_HOST_ID,
    });
  });

  afterEach(() => {
    setSystemTabModalApi(null);
    __resetTabNavigationControllerForTesting();
    draftRuntimeRegistry.resetForTesting();
    cleanup();
    useAuthStore.getState().setSignedOut();
    resetNegotiatedManifests();
    resetHostDirectoryRows();
    resetCloudDraftImageRecoveryForTests();
    resetLandingImageBudgetReservationsForTesting();
    composerLiveImageRoots.clear();
    useInitialChatHandoffStore.getState().resetForTests();
    useComposerRunSettingsStore.getState().resetForTests();
    useWorkspaceFoldersStore.setState({ byHost: {} });
    useWorktreeIntentStagingStore.getState().resetForTests();
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    useTabsStore.setState({
      items: [],
      activeItemId: null,
      systemTabs: { history: null, settings: null },
      stripOrder: [],
    });
    useEpicCanvasStore.setState({
      tabsById: {},
      openTabOrder: [],
      activeTabId: null,
      mostRecentTabIdByEpicId: {},
    });
    useSelectionAuthorityStore.setState({
      attached: false,
      effectiveHostId: null,
    });
  });

  const SURFACE = "landing:window-test";

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
    name: "",
    wakeString: null,
  };

  const TEAM_TARGET: StagedSandboxTarget = {
    ...NEW_TARGET,
    configuration: { kind: "team", teamId: "team-9", teamName: "Acme" },
  };

  const RESUME_TARGET: StagedSandboxTarget = {
    kind: "existing",
    hostId: "host-sbx",
    sandboxId: "sbx-1",
    name: "build-box",
    configuration: { kind: "personal" },
    verb: "resume",
  };

  const START_TARGET: StagedSandboxTarget = {
    ...RESUME_TARGET,
    verb: "start",
  };

  function hand(epicId: string) {
    return handLandingSandboxSend({
      fromSurfaceKey: SURFACE,
      epicId,
      content: MESSAGE_CONTENT,
      text: SUBMITTED_PROMPT,
      settings: PICKED_SETTINGS,
      now: Date.now(),
    });
  }

  /** A reload: the composer's stage is gone with the window, drafts are read back. */
  async function reloadWindow(): Promise<void> {
    const saved = localStorage.getItem(LANDING_DRAFT_PERSIST_KEY);
    useStagedSandboxStore.getState().clear(SURFACE);
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    if (saved !== null) localStorage.setItem(LANDING_DRAFT_PERSIST_KEY, saved);
    await useLandingDraftStore.persist.rehydrate();
  }

  function onlyPendingSend() {
    const sends = Object.values(usePendingSandboxSendStore.getState().sends);
    expect(sends).toHaveLength(1);
    return sends[0];
  }

  it.each([
    ["a new sandbox", NEW_TARGET],
    ["a suspended sandbox", RESUME_TARGET],
    ["a stopped sandbox", START_TARGET],
  ] as const)(
    "opens the task for %s at once: navigates and records the message before epic.create settles, and creates it with no chat",
    async (_label, target) => {
      useStagedSandboxStore.getState().stage(SURFACE, target);
      const created = deferred<unknown>();
      landingMocks.request.mockImplementation((method: string) =>
        method === "epic.create" ? created.promise : Promise.resolve({}),
      );
      const queryClient = newQueryClient();
      const { result } = renderHook(
        () => useLandingComposerActions(useTestPlacementTarget()),
        { wrapper: queryClientWrapper(queryClient) },
      );

      let refusal: { readonly message: string } | null = {
        message: "unset",
      };
      act(() => {
        refusal = result.current.startTaskOnStagedSandbox({
          draftId: null,
          owner: null,
          sandboxTeamId: null,
          text: SUBMITTED_PROMPT,
          hand,
        });
      });

      // The create has not answered: the task is open already.
      expect(refusal).toBeNull();
      expect(landingMocks.navigate).toHaveBeenCalled();
      await waitFor(() => {
        expect(hasEpicCreateRequest()).toBe(true);
      });
      const payload = epicCreatePayload();
      expect(chatFromCreatePayload(payload)).toBeNull();
      const send = onlyPendingSend();
      expect(epicIdFromCreatePayload(payload)).toBe(send.epicId);
      expect(send).toMatchObject({
        request: { kind: "chat", parentId: null, placement: null },
        text: SUBMITTED_PROMPT,
        settings: PICKED_SETTINGS,
      });
      // The stage went with the message, under the send's key, and the
      // composer's own holds nothing.
      expect(readStagedSandbox(SURFACE)).toBeNull();
      expect(readStagedSandbox(pendingSendSurfaceKey(send.id))).toMatchObject({
        target,
      });
      // The task's create is still on its way: the sandbox is not started yet.
      expect(send.epicConfirmed).toBe(false);

      await act(async () => {
        created.resolve({ roomInfo: null });
        await created.promise;
      });
      await waitFor(() => {
        expect(
          usePendingSandboxSendStore.getState().sends[send.id]?.epicConfirmed,
        ).toBe(true);
      });
      queryClient.clear();
    },
  );

  it("attaches a team-staged task on Personal before confirming its sandbox send", async () => {
    useStagedSandboxStore.getState().stage(SURFACE, TEAM_TARGET);
    const attach = deferred<unknown>();
    landingMocks.request.mockImplementation((method: string) => {
      if (method === "epic.attachEnvironment") return attach.promise;
      return Promise.resolve({ roomInfo: null });
    });
    const queryClient = newQueryClient();
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      { wrapper: queryClientWrapper(queryClient) },
    );

    act(() => {
      result.current.startTaskOnStagedSandbox({
        draftId: null,
        owner: null,
        sandboxTeamId: "team-9",
        text: SUBMITTED_PROMPT,
        hand,
      });
    });

    await waitFor(() => {
      expect(hasEpicCreateRequest()).toBe(true);
    });
    const send = onlyPendingSend();
    expect(epicCreatePayload()).toMatchObject({ owner: null });
    expect(send.epicConfirmed).toBe(false);
    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some(
          ([method]) => method === "epic.attachEnvironment",
        ),
      ).toBe(true);
    });
    const methods = landingMocks.request.mock.calls.map(([method]) => method);
    expect(methods.indexOf("epic.create")).toBeLessThan(
      methods.indexOf("epic.attachEnvironment"),
    );
    expect(send.epicConfirmed).toBe(false);

    await act(async () => {
      attach.resolve({ attached: true });
      await attach.promise;
    });
    await waitFor(() => {
      expect(
        usePendingSandboxSendStore.getState().sends[send.id]?.epicConfirmed,
      ).toBe(true);
    });
    queryClient.clear();
  });

  it("continues when the placement host does not support team attachment", async () => {
    useStagedSandboxStore.getState().stage(SURFACE, TEAM_TARGET);
    landingMocks.request.mockImplementation((method: string) => {
      if (method === "epic.attachEnvironment") {
        return Promise.reject(
          new HostRpcError({
            code: "E_HOST_UNSUPPORTED",
            message: "This host does not support task attachments.",
            requestId: "request-attach-unsupported",
            method,
            fatalDetails: null,
          }),
        );
      }
      return Promise.resolve({ roomInfo: null });
    });
    const queryClient = newQueryClient();
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      { wrapper: queryClientWrapper(queryClient) },
    );

    act(() => {
      result.current.startTaskOnStagedSandbox({
        draftId: null,
        owner: null,
        sandboxTeamId: "team-9",
        text: SUBMITTED_PROMPT,
        hand,
      });
    });

    await waitFor(() => {
      expect(onlyPendingSend().epicConfirmed).toBe(true);
    });
    expect(landingMocks.request.mock.calls.map(([method]) => method)).toEqual([
      "epic.create",
      "epic.attachEnvironment",
    ]);
    queryClient.clear();
  });

  it.each([
    ["a new sandbox", TEAM_TARGET],
    [
      "a resting sandbox",
      { ...RESUME_TARGET, configuration: TEAM_TARGET.configuration },
    ],
  ] as const)(
    "keeps %s and the Traycer pick after attachment refusal, so the second Send stays on the sandbox",
    async (_label, target) => {
      useStagedSandboxStore.getState().stage(SURFACE, target);
      landingMocks.request.mockImplementation((method: string) => {
        if (method === "epic.attachEnvironment") {
          return Promise.reject(attachBusy());
        }
        return Promise.resolve({ roomInfo: null });
      });
      const queryClient = newQueryClient();
      const { result } = renderHook(
        () => useLandingComposerActions(useTestPlacementTarget()),
        { wrapper: queryClientWrapper(queryClient) },
      );

      act(() => {
        result.current.startTaskOnStagedSandbox({
          draftId: null,
          owner: null,
          sandboxTeamId: "team-9",
          text: SUBMITTED_PROMPT,
          hand,
        });
      });

      await waitFor(() => {
        expect(usePendingSandboxSendStore.getState().sends).toEqual({});
      });
      // The task the refused Send created is deleted on its placement, so the
      // second Send below starts its own.
      const firstEpicId = createdEpicId();
      await waitFor(() => {
        expect(landingMocks.deleteRequest).toHaveBeenCalledWith(TEST_HOST_ID, {
          ids: [firstEpicId],
        });
      });
      await waitFor(() => {
        expect(wasEpicCreatedThisSession(firstEpicId)).toBe(false);
      });
      expect(
        Object.values(useEpicCanvasStore.getState().tabsById),
      ).toHaveLength(0);
      // The give-back records the sandbox on the draft and stages nothing.
      expect(readStagedSandbox(SURFACE)).toBeNull();
      expect(useLandingDraftStore.getState().drafts).toHaveLength(1);
      expect(useLandingDraftStore.getState().drafts[0]).toMatchObject({
        content: MESSAGE_CONTENT,
        settings: PICKED_SETTINGS,
        closed: false,
        returnedSandbox: { target },
      });
      const returnedDraft = useLandingDraftStore.getState().drafts[0];
      const requestId = returnedDraft.returnedSandbox?.clientRequestId ?? null;
      // The composer showing the draft stages it.
      const shown = renderHook(() =>
        useLandingReturnedSandbox(SURFACE, returnedDraft.id, true),
      );
      expect(readStagedSandbox(SURFACE)).toMatchObject({
        target,
        phase: "staged",
        sendTaken: false,
        clientRequestId: requestId,
      });
      shown.unmount();
      // A reload before the second Send: the draft puts its sandbox back on
      // the composer, create key and all.
      await reloadWindow();
      expect(readStagedSandbox(SURFACE)).toBeNull();
      renderHook(() =>
        useLandingReturnedSandbox(SURFACE, returnedDraft.id, true),
      );
      expect(readStagedSandbox(SURFACE)).toMatchObject({
        target,
        phase: "staged",
        clientRequestId: requestId,
      });
      expect(landingMocks.request.mock.calls.map(([method]) => method)).toEqual(
        ["epic.create", "epic.attachEnvironment"],
      );
      landingMocks.request.mockResolvedValue({ attached: true });
      act(() => {
        result.current.startTaskOnStagedSandbox({
          draftId: returnedDraft.id,
          owner: null,
          sandboxTeamId: "team-9",
          text: SUBMITTED_PROMPT,
          hand: (epicId) =>
            handLandingSandboxSend({
              fromSurfaceKey: SURFACE,
              epicId,
              content: returnedDraft.content,
              text: SUBMITTED_PROMPT,
              settings: returnedDraft.settings ?? PICKED_SETTINGS,
              now: Date.now(),
            }),
        });
      });
      await waitFor(() => expect(onlyPendingSend().epicConfirmed).toBe(true));
      const secondSend = onlyPendingSend();
      expect(secondSend.settings).toEqual(PICKED_SETTINGS);
      expect(
        readStagedSandbox(pendingSendSurfaceKey(secondSend.id)),
      ).toMatchObject({
        target,
        // A new sandbox's create is named again; a resting one only wakes.
        ...(requestId === null ? {} : { clientRequestId: requestId }),
      });
      const creates = landingMocks.request.mock.calls.filter(
        ([method]) => method === "epic.create",
      );
      expect(creates).toHaveLength(2);
      expect(
        new Set(creates.map(([, payload]) => epicIdFromCreatePayload(payload)))
          .size,
      ).toBe(2);
      for (const [, payload] of creates)
        expect(chatFromCreatePayload(payload)).toBeNull();
      queryClient.clear();
    },
  );

  it("takes a given-back sandbox off the composer when another draft is shown, and back on with its key", async () => {
    useStagedSandboxStore.getState().stage(SURFACE, TEAM_TARGET);
    landingMocks.request.mockImplementation((method: string) =>
      method === "epic.attachEnvironment"
        ? Promise.reject(
            new HostRpcError({
              code: "FORBIDDEN",
              message: "This task cannot be attached to that team.",
              requestId: "request-attach-refused",
              method,
              fatalDetails: null,
            }),
          )
        : Promise.resolve({ roomInfo: null }),
    );
    const queryClient = newQueryClient();
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      { wrapper: queryClientWrapper(queryClient) },
    );
    act(() => {
      result.current.startTaskOnStagedSandbox({
        draftId: null,
        owner: null,
        sandboxTeamId: "team-9",
        text: SUBMITTED_PROMPT,
        hand,
      });
    });
    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    const returnedDraft = useLandingDraftStore.getState().drafts[0];
    const requestId = returnedDraft.returnedSandbox?.clientRequestId ?? null;
    if (requestId === null)
      throw new Error("expected the create's key on the returned draft");
    useLandingDraftStore.getState().installLandingDraft({
      id: "draft-other",
      content: MESSAGE_CONTENT,
      selection: null,
      lastTouchedAt: Date.now(),
      settings: PICKED_SETTINGS,
      composerMode: "chat",
      workspace: emptyLandingDraftWorkspaceSnapshot(),
      closed: false,
      returnedSandbox: null,
      durability: "saved",
    });
    const composer = renderHook<void, { readonly draftId: string }>(
      (props) => useLandingReturnedSandbox(SURFACE, props.draftId, true),
      { initialProps: { draftId: returnedDraft.id } },
    );

    composer.rerender({ draftId: "draft-other" });
    expect(readStagedSandbox(SURFACE)).toBeNull();

    composer.rerender({ draftId: returnedDraft.id });
    expect(readStagedSandbox(SURFACE)).toMatchObject({
      target: TEAM_TARGET,
      phase: "staged",
      clientRequestId: requestId,
    });
    queryClient.clear();
  });

  it("gives a sandbox the send created back as that sandbox, staged fresh when its draft is shown", async () => {
    useStagedSandboxStore.getState().stage(SURFACE, TEAM_TARGET);
    const attach = deferred<unknown>();
    landingMocks.request.mockImplementation((method: string) =>
      method === "epic.attachEnvironment"
        ? attach.promise
        : Promise.resolve({ roomInfo: null }),
    );
    const queryClient = newQueryClient();
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      { wrapper: queryClientWrapper(queryClient) },
    );
    act(() => {
      result.current.startTaskOnStagedSandbox({
        draftId: null,
        owner: null,
        sandboxTeamId: "team-9",
        text: SUBMITTED_PROMPT,
        hand,
      });
    });
    await waitFor(() =>
      expect(
        landingMocks.request.mock.calls.some(
          ([method]) => method === "epic.attachEnvironment",
        ),
      ).toBe(true),
    );
    const pending = pendingSendSurfaceKey(onlyPendingSend().id);
    const requestId = readStagedSandbox(pending)?.clientRequestId;
    // The send got somewhere before its task was refused.
    act(() => {
      useStagedSandboxStore.getState().report(pending, {
        startedAt: Date.now() - 30_000,
        step: "booting",
        stepAt: Date.now(),
        createdSandboxId: "sbx-9",
        createdHostId: "sbx-9-host",
        failure: { kind: "timed-out", step: "booting" },
      });
    });

    await act(async () => {
      attach.reject(
        new HostRpcError({
          code: "FORBIDDEN",
          message: "This task cannot be attached to that team.",
          requestId: "request-attach-refused",
          method: "epic.attachEnvironment",
          fatalDetails: null,
        }),
      );
      await attach.promise.catch(() => undefined);
    });

    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    // The sandbox exists now: the draft records it, to wake, with no create
    // key. The give-back stages nothing.
    expect(requestId).not.toBeNull();
    expect(readStagedSandbox(SURFACE)).toBeNull();
    const returnedDraft = useLandingDraftStore.getState().drafts[0];
    const created = {
      kind: "existing",
      hostId: "sbx-9-host",
      sandboxId: "sbx-9",
      name: TEAM_TARGET.name,
      configuration: TEAM_TARGET.configuration,
      verb: "resume",
    };
    expect(returnedDraft.returnedSandbox).toMatchObject({
      target: created,
      clientRequestId: null,
    });
    // Shown, a fresh stage on it: nothing of the send's progress, failure or
    // timing carries over.
    renderHook(() =>
      useLandingReturnedSandbox(SURFACE, returnedDraft.id, true),
    );
    expect(readStagedSandbox(SURFACE)).toMatchObject({
      target: created,
      phase: "staged",
      clientRequestId: null,
      sendTaken: false,
      startedAt: null,
      stepAt: null,
      createdSandboxId: null,
      createdHostId: null,
      failure: null,
    });
    queryClient.clear();
  });

  it("saves the message in Drafts and deletes the task when a late refusal lands after the source staged another sandbox", async () => {
    useStagedSandboxStore.getState().stage(SURFACE, TEAM_TARGET);
    const attach = deferred<unknown>();
    landingMocks.request.mockImplementation((method: string) =>
      method === "epic.attachEnvironment"
        ? attach.promise
        : Promise.resolve({ roomInfo: null }),
    );
    const queryClient = newQueryClient();
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      { wrapper: queryClientWrapper(queryClient) },
    );
    act(() => {
      result.current.startTaskOnStagedSandbox({
        draftId: null,
        owner: null,
        sandboxTeamId: "team-9",
        text: SUBMITTED_PROMPT,
        hand,
      });
    });
    await waitFor(() =>
      expect(
        landingMocks.request.mock.calls.some(
          ([method]) => method === "epic.attachEnvironment",
        ),
      ).toBe(true),
    );
    const epicId = createdEpicId();
    useStagedSandboxStore.getState().stage(SURFACE, NEW_TARGET);
    const newerStage = readStagedSandbox(SURFACE);
    await act(async () => {
      attach.reject(attachBusy());
      await attach.promise.catch(() => undefined);
    });
    await waitFor(() => expect(result.current.isPending).toBe(false));
    // The composer keeps the newer choice; the refused message is in Drafts
    // with its own sandbox, and no pending send or task is left behind.
    expect(readStagedSandbox(SURFACE)).toBe(newerStage);
    expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    expect(useLandingDraftStore.getState().drafts).toHaveLength(1);
    expect(useLandingDraftStore.getState().drafts[0]).toMatchObject({
      content: MESSAGE_CONTENT,
      returnedSandbox: { target: TEAM_TARGET },
    });
    await waitFor(() => {
      expect(landingMocks.deleteRequest).toHaveBeenCalledWith(TEST_HOST_ID, {
        ids: [epicId],
      });
    });
    queryClient.clear();
  });

  it("sends the rollback's delete to the placement host by its id, never to the app-wide host", async () => {
    useStagedSandboxStore.getState().stage(SURFACE, TEAM_TARGET);
    const placementRequest =
      vi.fn<(method: string, payload: unknown) => Promise<unknown>>();
    placementRequest.mockImplementation((method: string) =>
      method === "epic.attachEnvironment"
        ? Promise.reject(attachBusy())
        : Promise.resolve({ roomInfo: null }),
    );
    const placementClient = {
      request: placementRequest,
      requestWithSignalRequiringHostMethodVersion: (
        method: string,
        payload: unknown,
      ): Promise<unknown> => placementRequest(method, payload),
      requestWithOptions: (
        method: string,
        payload: unknown,
      ): Promise<unknown> => placementRequest(method, payload),
      getActiveHostId: () => PLACEMENT_HOST_ID,
      getRequestContextUserId: landingMocks.getRequestContextUserId,
    };
    if (!isStubHostClient(placementClient)) {
      throw new Error("The placement stub is not a host client.");
    }
    const queryClient = newQueryClient();
    const { result } = renderHook(
      () => ({
        actions: useLandingComposerActions({
          resolvedHostId: PLACEMENT_HOST_ID,
          client: placementClient,
          hostLabel: "Placement",
          isPinned: true,
          namedHostDead: false,
        }),
      }),
      { wrapper: queryClientWrapper(queryClient) },
    );

    act(() => {
      result.current.actions.startTaskOnStagedSandbox({
        draftId: null,
        owner: null,
        sandboxTeamId: "team-9",
        text: SUBMITTED_PROMPT,
        hand,
      });
    });

    await waitFor(() => {
      expect(landingMocks.deleteRequest).toHaveBeenCalledTimes(1);
    });
    const createCall = placementRequest.mock.calls.find(
      ([method]) => method === "epic.create",
    );
    const epicId = epicIdFromCreatePayload(createCall?.[1]);
    expect(epicId).not.toBeNull();
    expect(landingMocks.deleteRequest).toHaveBeenCalledWith(PLACEMENT_HOST_ID, {
      ids: [epicId],
    });
    // The two reads that decided the delete went to the placement host too.
    expect(
      landingMocks.readRequest.mock.calls.map(([hostId, method, payload]) => [
        hostId,
        method,
        payload,
      ]),
    ).toEqual(
      expect.arrayContaining(
        READ_METHODS.map((method) => [
          PLACEMENT_HOST_ID,
          method,
          { epicId, hasDocReplica: false, knownRevision: null },
        ]),
      ),
    );
    // Only the terminal-agent list carries a version floor, and it reached the
    // placement host's connection; the chat list carries none.
    expect(landingMocks.floors).toEqual([
      {
        hostId: PLACEMENT_HOST_ID,
        method: "epic.listTuiAgents",
        requirement: {
          method: "epic.listTuiAgents",
          version: { major: 1, minor: 1 },
        },
      },
    ]);
    // The app-wide host (TEST_HOST_ID) is a different machine: it was asked
    // for nothing, a delete or a read included.
    expect(
      landingMocks.readRequest.mock.calls.filter(
        ([hostId]) => hostId === TEST_HOST_ID,
      ),
    ).toEqual([]);
    expect(landingMocks.getActiveHostId()).toBe(TEST_HOST_ID);
    expect(
      landingMocks.request.mock.calls.filter(
        ([method]) => method === "epic.batchDelete",
      ),
    ).toEqual([]);
    expect(
      landingMocks.deleteRequest.mock.calls.filter(
        ([hostId]) => hostId === TEST_HOST_ID,
      ),
    ).toEqual([]);
    queryClient.clear();
  });

  /**
   * A staged team Send whose `epic.attachEnvironment` is held open, so a test
   * can change the world while the Send waits and then refuse it.
   */
  async function startSendWithHeldAttach(): Promise<{
    readonly epicId: string;
    readonly refuseAttach: (error: HostRpcError) => Promise<void>;
    readonly queryClient: QueryClient;
  }> {
    useStagedSandboxStore.getState().stage(SURFACE, TEAM_TARGET);
    const attach = deferred<unknown>();
    landingMocks.request.mockImplementation((method: string) =>
      method === "epic.attachEnvironment"
        ? attach.promise
        : Promise.resolve({ roomInfo: null }),
    );
    const queryClient = newQueryClient();
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      { wrapper: queryClientWrapper(queryClient) },
    );
    act(() => {
      result.current.startTaskOnStagedSandbox({
        draftId: null,
        owner: null,
        sandboxTeamId: "team-9",
        text: SUBMITTED_PROMPT,
        hand,
      });
    });
    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some(
          ([method]) => method === "epic.attachEnvironment",
        ),
      ).toBe(true);
    });
    return {
      epicId: createdEpicId(),
      queryClient,
      refuseAttach: async (error) => {
        await act(async () => {
          attach.reject(error);
          await attach.promise.catch(() => undefined);
        });
      },
    };
  }

  /** The message is a draft again with its sandbox, and nothing was sent. */
  function expectMessageBackUnsent(): void {
    expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    expect(useLandingDraftStore.getState().drafts).toHaveLength(1);
    expect(useLandingDraftStore.getState().drafts[0]).toMatchObject({
      content: MESSAGE_CONTENT,
      settings: PICKED_SETTINGS,
      closed: false,
      returnedSandbox: { target: TEAM_TARGET },
    });
    expect(landingMocks.createTerminalAgent).not.toHaveBeenCalled();
    expect(landingMocks.request.mock.calls.map(([method]) => method)).toEqual([
      "epic.create",
      "epic.attachEnvironment",
    ]);
  }

  /**
   * The attachment is refused and the rollback, when there is one, is over:
   * no mutation of the Send's client is left pending.
   */
  async function refusalSettled(queryClient: QueryClient): Promise<void> {
    await waitFor(() => {
      expect(queryClient.isMutating()).toBe(0);
    });
  }

  async function bothReadsSent(): Promise<void> {
    await waitFor(() => {
      expect(
        landingMocks.readRequest.mock.calls.map(([, method]) => method).sort(),
      ).toEqual([...READ_METHODS].sort());
    });
  }

  it.each(PROMOTION_PENDING_CODES)(
    "a Send refused while the task is still being set up leaves no empty task, and the message comes back unsent (%s)",
    async (code) => {
      const { epicId, refuseAttach, queryClient } =
        await startSendWithHeldAttach();
      await refuseAttach(attachRefusal(code));

      await waitFor(() => {
        expect(landingMocks.deleteRequest).toHaveBeenCalledWith(TEST_HOST_ID, {
          ids: [epicId],
        });
      });
      await waitFor(() => {
        expect(wasEpicCreatedThisSession(epicId)).toBe(false);
      });
      expect(
        Object.values(useEpicCanvasStore.getState().tabsById),
      ).toHaveLength(0);
      expectMessageBackUnsent();
      queryClient.clear();
    },
  );

  it.each([
    ["a chat", "epic.listChatRecords", { chatId: "chat-started" }],
    ["a terminal agent", "epic.listTuiAgents", { tuiAgentId: "tui-started" }],
  ] as const)(
    "a Send refused while the task is still being set up keeps a task with an agent in it, and the message comes back unsent (%s)",
    async (_label, readMethod, row) => {
      vi.mocked(toast.error).mockClear();
      const { epicId, refuseAttach, queryClient } =
        await startSendWithHeldAttach();
      // The person starts the agent while the attachment is pending.
      landingMocks.readRequest.mockImplementation((_hostId, method) =>
        Promise.resolve(heldRows(method, method === readMethod ? [row] : [])),
      );
      await refuseAttach(attachBusy());

      await bothReadsSent();
      await refusalSettled(queryClient);
      expect(landingMocks.deleteRequest).not.toHaveBeenCalled();
      expect(wasEpicCreatedThisSession(epicId)).toBe(true);
      expect(
        Object.values(useEpicCanvasStore.getState().tabsById),
      ).toHaveLength(1);
      expect(toast.error).not.toHaveBeenCalledWith(
        DISCARD_CREATED_EPIC_FAILED_COPY,
      );
      expectMessageBackUnsent();
      queryClient.clear();
    },
  );

  it.each([
    ["E_SHARE_NOT_OWNED", attachRefusal("E_SHARE_NOT_OWNED")],
    ["E_SHARE_NEEDS_CLOUD_SYNC", attachRefusal("E_SHARE_NEEDS_CLOUD_SYNC")],
    ["E_SHARE_REFUSED", attachRefusal("E_SHARE_REFUSED")],
    ["FORBIDDEN", attachRefusal("FORBIDDEN")],
    ["a plain RPC_ERROR", attachRefusal("RPC_ERROR")],
    [
      "a transport failure",
      new HostTransportFailureError({
        code: "RPC_ERROR",
        message: "Host is unreachable",
        requestId: "request-attach-transport",
        method: "epic.attachEnvironment",
        fatalDetails: null,
      }),
    ],
  ] as const)(
    "a Send refused for any other reason keeps its empty task, and the message comes back unsent (%s)",
    async (_label, error) => {
      const { epicId, refuseAttach, queryClient } =
        await startSendWithHeldAttach();
      await refuseAttach(error);

      // Nothing follows the message's return but the refusal's own line.
      await waitFor(() => {
        expect(useLandingDraftStore.getState().drafts).toHaveLength(1);
      });
      await refusalSettled(queryClient);
      // Nothing was asked of the host about the task, let alone deleted.
      expect(landingMocks.readRequest).not.toHaveBeenCalled();
      expect(landingMocks.deleteRequest).not.toHaveBeenCalled();
      expect(wasEpicCreatedThisSession(epicId)).toBe(true);
      expect(
        Object.values(useEpicCanvasStore.getState().tabsById),
      ).toHaveLength(1);
      expectMessageBackUnsent();
      queryClient.clear();
    },
  );

  /**
   * Where the refused Send's message goes, set while the attachment is held:
   * the composer (the default), Drafts (the source composer holds a newer
   * stage), nowhere (its pending stage is gone), or back to the person who
   * took it back.
   */
  type MessageFate =
    | "composer"
    | "drafts"
    | "nowhere"
    | "taken-back"
    | "cancelled";

  /** Refuses the held attachment and returns every toast that came after. */
  async function toastsFromRefusal(
    fate: MessageFate,
    error: HostRpcError,
  ): Promise<ShownToast[]> {
    const { refuseAttach, queryClient } = await startSendWithHeldAttach();
    const pending = pendingSendSurfaceKey(onlyPendingSend().id);
    if (fate === "drafts") {
      useStagedSandboxStore.getState().stage(SURFACE, NEW_TARGET);
    }
    if (fate === "nowhere") {
      useStagedSandboxStore.setState((state) => ({
        bySurface: Object.fromEntries(
          Object.entries(state.bySurface).filter(([key]) => key !== pending),
        ),
      }));
    }
    if (fate === "taken-back") {
      returnPendingSandboxSend(onlyPendingSend().id);
    }
    if (fate === "cancelled") {
      // The setup line's Cancel: the message goes to Drafts on its sandbox
      // while the attachment is held, and the cancellation keeps its receipt.
      const send = onlyPendingSend();
      const returned = returnPendingSandboxSendToSandbox(send.id, {
        kind: "stage",
        target: TEAM_TARGET,
        clientRequestId: null,
      });
      if (
        !Object.hasOwn(usePendingSandboxSendStore.getState().sends, send.id)
      ) {
        recordCancelledSandboxSend(send, returned);
      }
    }
    const shownBefore = toastLog.length;
    await refuseAttach(error);
    // A task still being set up is rolled back unless the Send was taken back:
    // its delete is the last thing that can follow.
    if (
      fate !== "taken-back" &&
      fate !== "cancelled" &&
      PROMOTION_PENDING_CODES.some((code) => code === error.code)
    ) {
      await waitFor(() => {
        expect(landingMocks.deleteRequest).toHaveBeenCalledTimes(1);
      });
    }
    await refusalSettled(queryClient);
    queryClient.clear();
    return toastLog.slice(shownBefore);
  }

  it.each([
    ["E_SHARE_PENDING_BUSY"],
    ["E_SHARE_PENDING_RECENT_ATTEMPT"],
  ] as const)(
    "a Send refused while the task is still being set up says to Send again, once, with the message in the composer (%s)",
    async (code) => {
      expect(await toastsFromRefusal("composer", attachRefusal(code))).toEqual([
        errorToast(SETTING_UP_LINE),
      ]);
    },
  );

  it("says both that the task was still being set up and that the message is in Drafts when the composer holds a newer message", async () => {
    expect(await toastsFromRefusal("drafts", attachBusy())).toEqual([
      DRAFTS_TOAST,
      errorToast(SETTING_UP_LINE),
    ]);
  });

  it.each([
    "E_SHARE_PENDING_OFFLINE",
    "E_SHARE_PENDING_UNVERIFIED",
    "E_SHARE_PENDING_FAILED",
    "E_SHARE_NOT_OWNED",
    "E_SHARE_NEEDS_CLOUD_SYNC",
    "E_SHARE_REFUSED",
    "FORBIDDEN",
    "RPC_ERROR",
  ] as const)(
    "a Send refused with nothing to act on says the message is back in the composer, once (%s)",
    async (code) => {
      expect(await toastsFromRefusal("composer", attachRefusal(code))).toEqual([
        errorToast(BACK_IN_COMPOSER_LINE),
      ]);
    },
  );

  it("says only that the message is saved in Drafts, with no refusal line, for a refusal with nothing to act on", async () => {
    expect(
      await toastsFromRefusal(
        "drafts",
        attachRefusal("E_SHARE_PENDING_OFFLINE"),
      ),
    ).toEqual([DRAFTS_TOAST]);
  });

  it("keeps a transport failure a plain notice, not an error, with the message in the composer", async () => {
    expect(
      await toastsFromRefusal(
        "composer",
        new HostTransportFailureError({
          code: "RPC_ERROR",
          message: "Host is unreachable",
          requestId: "request-attach-transport",
          method: "epic.attachEnvironment",
          fatalDetails: null,
        }),
      ),
    ).toEqual([{ via: "toast", message: BACK_IN_COMPOSER_LINE, action: null }]);
  });

  it.each([
    [
      "an aborted request",
      new HostRequestAbortedError({
        message: "authority replaced",
        requestId: "request-attach-abort",
        method: "epic.attachEnvironment",
        mayHaveDispatched: false,
      }),
    ],
    [
      "a recoverable sign-in check",
      new HostRpcError({
        code: "UNAUTHORIZED",
        message: "token refresh in flight",
        requestId: "request-attach-auth",
        method: "epic.attachEnvironment",
        fatalDetails: null,
      }),
    ],
  ] as const)(
    "says only that the message is saved in Drafts when the attachment is silent and the composer holds a newer message (%s)",
    async (_label, error) => {
      expect(await toastsFromRefusal("drafts", error)).toEqual([DRAFTS_TOAST]);
      expect(useLandingDraftStore.getState().drafts).toHaveLength(1);
      expect(useLandingDraftStore.getState().drafts[0]).toMatchObject({
        content: MESSAGE_CONTENT,
        settings: PICKED_SETTINGS,
        returnedSandbox: { target: TEAM_TARGET },
      });
    },
  );

  it.each([
    [
      "an aborted request",
      new HostRequestAbortedError({
        message: "authority replaced",
        requestId: "request-attach-abort",
        method: "epic.attachEnvironment",
        mayHaveDispatched: false,
      }),
    ],
    [
      "a recoverable sign-in check",
      new HostRpcError({
        code: "UNAUTHORIZED",
        message: "token refresh in flight",
        requestId: "request-attach-auth",
        method: "epic.attachEnvironment",
        fatalDetails: null,
      }),
    ],
  ] as const)(
    "says nothing and saves no draft when the attachment is silent and nothing was returned (%s)",
    async (_label, error) => {
      expect(await toastsFromRefusal("nowhere", error)).toEqual([]);
      expect(useLandingDraftStore.getState().drafts).toEqual([]);
    },
  );

  it("adds no second toast to a refusal after the person cancelled the Send into Drafts", async () => {
    expect(await toastsFromRefusal("cancelled", attachBusy())).toEqual([]);
    // The cancellation's own receipt says the message is in Drafts: the
    // setup line renders `returnedSandboxMessageLine` from this record.
    const receipts = Object.values(
      useStoppedSandboxSendReceiptStore.getState().receipts,
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      kind: "cancelled",
      returned: { kind: "landing-draft" },
    });
    expect(useLandingDraftStore.getState().drafts).toHaveLength(1);
    expect(useLandingDraftStore.getState().drafts[0]).toMatchObject({
      content: MESSAGE_CONTENT,
      returnedSandbox: { target: TEAM_TARGET },
    });
    // The Send was withdrawn, so the refusal rolled nothing back.
    expect(landingMocks.deleteRequest).not.toHaveBeenCalled();
  });

  it("says nothing, saves no draft and leaves the pending send alone when the account changed and the composer held a newer message", async () => {
    const { refuseAttach, queryClient } = await startSendWithHeldAttach();
    const sendBefore = onlyPendingSend();
    useStagedSandboxStore.getState().stage(SURFACE, NEW_TARGET);
    act(() => {
      useAuthStore
        .getState()
        .setSignedIn(
          { userId: "other-user", userName: "Other", email: "o@example.com" },
          { userId: "other-user", username: "Other" },
          [],
        );
    });
    const shownBefore = toastLog.length;
    await refuseAttach(attachBusy());
    await refusalSettled(queryClient);
    expect(toastLog.slice(shownBefore)).toEqual([]);
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
    expect(onlyPendingSend()).toEqual(sendBefore);
    expect(landingMocks.deleteRequest).not.toHaveBeenCalled();
    queryClient.clear();
  });

  it("keeps a retryable attestation a plain notice, with the host's raw reason shown nowhere", async () => {
    const shown = await toastsFromRefusal(
      "composer",
      new RetryableTransportError({
        replaySafetyFromKey: false,
        code: "RPC_ERROR",
        message: "Host timed out awaiting the request frame",
        requestId: "request-attach-attestation",
        method: "epic.attachEnvironment",
        fatalDetails: {
          code: "RPC_REQUEST_TIMEOUT",
          reason: "Host timed out awaiting the request frame",
          incompatibleMethods: null,
          upgradeGuidance: null,
          retryable: true,
        },
      }),
    );
    expect(shown).toEqual([
      { via: "toast", message: BACK_IN_COMPOSER_LINE, action: null },
    ]);
    expect(JSON.stringify(shown)).not.toContain("timed out");
  });

  it.each([
    ["a task still being set up", attachBusy()],
    ["a plain failure", attachRefusal("RPC_ERROR")],
  ] as const)(
    "says nothing at all when the person took the message back before the refusal (%s)",
    async (_label, error) => {
      expect(await toastsFromRefusal("taken-back", error)).toEqual([]);
    },
  );

  it.each([
    ["a task still being set up", attachBusy()],
    ["a plain failure", attachRefusal("RPC_ERROR")],
  ] as const)(
    "says only that the message was not sent when nothing was returned (%s)",
    async (_label, error) => {
      expect(await toastsFromRefusal("nowhere", error)).toEqual([
        errorToast(NOT_SENT_LINE),
      ]);
    },
  );

  it("says nothing when the account changed during the wait", async () => {
    const { refuseAttach, queryClient } = await startSendWithHeldAttach();
    act(() => {
      useAuthStore
        .getState()
        .setSignedIn(
          { userId: "other-user", userName: "Other", email: "o@example.com" },
          { userId: "other-user", username: "Other" },
          [],
        );
    });
    const shownBefore = toastLog.length;
    await refuseAttach(attachBusy());
    await refusalSettled(queryClient);
    expect(toastLog.slice(shownBefore)).toEqual([]);
    queryClient.clear();
  });

  it("says the host is out of disk space, and nothing more, when the composer holds the message", async () => {
    expect(
      await toastsFromRefusal("composer", attachRefusal("E_HOST_STORAGE_FULL")),
    ).toEqual([errorToast(STORAGE_FULL_LINE)]);
  });

  it("says the host is out of disk space after the Drafts line when the message was saved there", async () => {
    expect(
      await toastsFromRefusal("drafts", attachRefusal("E_HOST_STORAGE_FULL")),
    ).toEqual([DRAFTS_TOAST, errorToast(STORAGE_FULL_LINE)]);
  });

  it.each([
    [
      "an aborted request",
      new HostRequestAbortedError({
        message: "authority replaced",
        requestId: "request-attach-abort",
        method: "epic.attachEnvironment",
        mayHaveDispatched: false,
      }),
    ],
    [
      "a recoverable sign-in check",
      new HostRpcError({
        code: "UNAUTHORIZED",
        message: "token refresh in flight",
        requestId: "request-attach-auth",
        method: "epic.attachEnvironment",
        fatalDetails: null,
      }),
    ],
  ] as const)(
    "says nothing from the attachment for %s, the message back in the composer",
    async (_label, error) => {
      expect(await toastsFromRefusal("composer", error)).toEqual([]);
    },
  );

  /**
   * The rollback of a refused Send has ended: the gate told the person the
   * task stays, or, with no gate, the delete went out. Waiting on either
   * lets a delete be asserted before the toasts it would shadow.
   */
  async function rollbackEnded(queryClient: QueryClient): Promise<void> {
    await waitFor(() => {
      expect(
        toastLog.length >= 2 ||
          landingMocks.deleteRequest.mock.calls.length > 0,
      ).toBe(true);
    });
    await refusalSettled(queryClient);
  }

  /** What a refused Send on a host that cannot prove its lists complete leaves. */
  async function expectTaskKeptUnread(
    queryClient: QueryClient,
    epicId: string,
  ): Promise<void> {
    await rollbackEnded(queryClient);
    expect(landingMocks.deleteRequest).not.toHaveBeenCalled();
    // The read below the floor never reached the host: only the other list did.
    expect(
      landingMocks.readRequest.mock.calls.map(([, method]) => method),
    ).not.toContain("epic.listTuiAgents");
    expect(toastLog.map(({ message }) => message)).toEqual([
      SETTING_UP_LINE,
      "This Send may have left an empty task. Delete it from your tasks if you don't need it.",
    ]);
    expect(toastLog.map(({ via }) => via)).toEqual(["error", "error"]);
    expect(wasEpicCreatedThisSession(epicId)).toBe(true);
    expect(Object.values(useEpicCanvasStore.getState().tabsById)).toHaveLength(
      1,
    );
    expectMessageBackUnsent();
    queryClient.clear();
  }

  it.each([
    [
      "negotiated epic.listTuiAgents@1.0, which withholds agents only the doc holds",
      (): void => undefined,
      {
        "epic.listChatRecords": { major: 1, minor: 3 },
        "epic.listTuiAgents": { major: 1, minor: 0 },
      },
    ],
    [
      "does not advertise epic.listTuiAgents",
      (): void => undefined,
      { "epic.listChatRecords": { major: 1, minor: 3 } },
    ],
    [
      "negotiated epic.listTuiAgents@1.0 though the cached manifest still says @1.3 (the host was replaced mid-Send)",
      (): void =>
        recordNegotiatedHostManifest(TEST_HOST_ID, {
          "epic.listChatRecords": { major: 1, minor: 3 },
          "epic.listTuiAgents": { major: 1, minor: 3 },
        }),
      {
        "epic.listChatRecords": { major: 1, minor: 3 },
        "epic.listTuiAgents": { major: 1, minor: 0 },
      },
    ],
  ] as const)(
    "a Send refused while the task is still being set up keeps its task, and says so, when the placement connection %s",
    async (_label, seedCachedManifest, negotiated) => {
      seedCachedManifest();
      landingMocks.connections.set(TEST_HOST_ID, negotiated);
      const { epicId, refuseAttach, queryClient } =
        await startSendWithHeldAttach();
      await refuseAttach(attachBusy());

      await expectTaskKeptUnread(queryClient, epicId);
    },
  );

  it("judges the rollback by the placement host's connection, not by the host the attachment went to", async () => {
    // The placement is a team's sandbox, so the attachment goes to the
    // person's own app-wide host instead; only the placement holds the task.
    installHostDirectoryRows([
      sandboxHostEntry(PLACEMENT_HOST_ID, { id: "team-9", name: "Acme" }),
    ]);
    landingMocks.connections.set(PLACEMENT_HOST_ID, {
      "epic.listChatRecords": { major: 1, minor: 3 },
      "epic.listTuiAgents": { major: 1, minor: 0 },
    });
    landingMocks.connections.set(TEST_HOST_ID, landingMocks.modernConnection);
    useStagedSandboxStore.getState().stage(SURFACE, TEAM_TARGET);
    const attach = deferred<unknown>();
    const placementRequest =
      vi.fn<(method: string, payload: unknown) => Promise<unknown>>();
    placementRequest.mockImplementation((method: string) =>
      Promise.resolve(method === "epic.create" ? { roomInfo: null } : {}),
    );
    landingMocks.request.mockImplementation((method: string) =>
      method === "epic.attachEnvironment"
        ? attach.promise
        : Promise.reject(new Error(`unexpected ${method} on the attach host`)),
    );
    const placementClient = {
      request: placementRequest,
      requestWithSignalRequiringHostMethodVersion: (
        method: string,
        payload: unknown,
      ): Promise<unknown> => placementRequest(method, payload),
      requestWithOptions: (
        method: string,
        payload: unknown,
      ): Promise<unknown> => placementRequest(method, payload),
      getActiveHostId: () => PLACEMENT_HOST_ID,
      getRequestContextUserId: landingMocks.getRequestContextUserId,
    };
    if (!isStubHostClient(placementClient)) {
      throw new Error("The placement stub is not a host client.");
    }
    const queryClient = newQueryClient();
    const { result } = renderHook(
      () =>
        useLandingComposerActions({
          resolvedHostId: PLACEMENT_HOST_ID,
          client: placementClient,
          hostLabel: "Placement",
          isPinned: true,
          namedHostDead: false,
        }),
      { wrapper: queryClientWrapper(queryClient) },
    );
    act(() => {
      result.current.startTaskOnStagedSandbox({
        draftId: null,
        owner: null,
        sandboxTeamId: "team-9",
        text: SUBMITTED_PROMPT,
        hand,
      });
    });
    // The attachment is sent on the app-wide host, the create on the placement.
    await waitFor(() => {
      expect(landingMocks.request.mock.calls.map(([method]) => method)).toEqual(
        ["epic.attachEnvironment"],
      );
    });
    const createCall = placementRequest.mock.calls.find(
      ([method]) => method === "epic.create",
    );
    const epicId = epicIdFromCreatePayload(createCall?.[1]);
    if (epicId === null) throw new Error("epic.create was never sent");

    await act(async () => {
      attach.reject(attachBusy());
      await attach.promise.catch(() => undefined);
    });

    await rollbackEnded(queryClient);
    // The floor reached the placement's connection, not the app-wide host's
    // modern one, and nothing was deleted anywhere.
    expect(landingMocks.deleteRequest).not.toHaveBeenCalled();
    expect(landingMocks.floors.map(({ hostId }) => hostId)).toEqual([
      PLACEMENT_HOST_ID,
    ]);
    expect(
      landingMocks.readRequest.mock.calls.filter(
        ([hostId]) => hostId === TEST_HOST_ID,
      ),
    ).toEqual([]);
    expect(toastLog.map(({ message }) => message)).toEqual([
      SETTING_UP_LINE,
      "This Send may have left an empty task. Delete it from your tasks if you don't need it.",
    ]);
    expect(wasEpicCreatedThisSession(epicId)).toBe(true);
    queryClient.clear();
  });

  it.each(READ_METHODS)(
    "a refused Send keeps the task, tells the person, and gives the message back when the host rejects %s as unsupported although its connection met the floor",
    async (failing) => {
      landingMocks.readRequest.mockImplementation((_hostId, method) =>
        method === failing
          ? Promise.reject(
              new HostRpcError({
                code: "E_HOST_UNSUPPORTED",
                message: "unreadable",
                requestId: "request-read",
                method,
                fatalDetails: null,
              }),
            )
          : Promise.resolve(heldRows(method, [])),
      );
      vi.mocked(toast.error).mockClear();
      const { epicId, refuseAttach, queryClient } =
        await startSendWithHeldAttach();
      await refuseAttach(attachBusy());

      await waitFor(() => {
        expect(toastLog.map(({ message }) => message)).toEqual([
          SETTING_UP_LINE,
          "This Send may have left an empty task. Delete it from your tasks if you don't need it.",
        ]);
      });
      expect(landingMocks.deleteRequest).not.toHaveBeenCalled();
      expect(wasEpicCreatedThisSession(epicId)).toBe(true);
      expectMessageBackUnsent();
      queryClient.clear();
    },
  );

  it("deletes nothing when the account changes while the task's agents are being read", async () => {
    const reads = new Map<string, Deferred<unknown>>();
    landingMocks.readRequest.mockImplementation((_hostId, method) => {
      const held = deferred<unknown>();
      reads.set(method, held);
      return held.promise;
    });
    const { epicId, refuseAttach, queryClient } =
      await startSendWithHeldAttach();
    await refuseAttach(attachBusy());
    await bothReadsSent();

    landingMocks.getRequestContextUserId.mockReturnValue("other-user");
    await act(async () => {
      for (const [method, held] of reads) held.resolve(heldRows(method, []));
      await Promise.all([...reads.values()].map((held) => held.promise));
    });
    await refusalSettled(queryClient);

    expect(landingMocks.deleteRequest).not.toHaveBeenCalled();
    expect(wasEpicCreatedThisSession(epicId)).toBe(true);
    queryClient.clear();
  });

  it.each([
    [
      "the host rejects the delete",
      () =>
        Promise.reject(
          new HostRpcError({
            code: "RPC_ERROR",
            message: "disk unavailable",
            requestId: "request-discard",
            method: "epic.batchDelete",
            fatalDetails: null,
          }),
        ),
    ],
    [
      "the host answers that the task was not deleted",
      (payload: unknown) =>
        Promise.resolve({
          results: deletedIdsOf(payload).map((taskId) => ({
            taskId,
            success: false,
          })),
        }),
    ],
  ] as const)(
    "tells the person the empty task stayed when %s",
    async (_label, answer) => {
      useStagedSandboxStore.getState().stage(SURFACE, TEAM_TARGET);
      landingMocks.request.mockImplementation((method: string) =>
        method === "epic.attachEnvironment"
          ? Promise.reject(attachBusy())
          : Promise.resolve({ roomInfo: null }),
      );
      landingMocks.deleteRequest.mockImplementation((_hostId, payload) =>
        answer(payload),
      );
      vi.mocked(toast.error).mockClear();
      const queryClient = newQueryClient();
      const { result } = renderHook(
        () => useLandingComposerActions(useTestPlacementTarget()),
        { wrapper: queryClientWrapper(queryClient) },
      );
      act(() => {
        result.current.startTaskOnStagedSandbox({
          draftId: null,
          owner: null,
          sandboxTeamId: "team-9",
          text: SUBMITTED_PROMPT,
          hand,
        });
      });
      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith(
          DISCARD_CREATED_EPIC_FAILED_COPY,
        );
      });
      // The message is still given back.
      expect(useLandingDraftStore.getState().drafts).toHaveLength(1);
      queryClient.clear();
    },
  );

  it("keeps a refused attachment with its pending send, and deletes nothing, when the account changes", async () => {
    useStagedSandboxStore.getState().stage(SURFACE, TEAM_TARGET);
    const attach = deferred<unknown>();
    landingMocks.request.mockImplementation((method: string) => {
      if (method === "epic.attachEnvironment") return attach.promise;
      return Promise.resolve({ roomInfo: null });
    });
    const queryClient = newQueryClient();
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      { wrapper: queryClientWrapper(queryClient) },
    );

    act(() => {
      result.current.startTaskOnStagedSandbox({
        draftId: null,
        owner: null,
        sandboxTeamId: "team-9",
        text: SUBMITTED_PROMPT,
        hand,
      });
    });
    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some(
          ([method]) => method === "epic.attachEnvironment",
        ),
      ).toBe(true);
    });
    const send = onlyPendingSend();

    act(() => {
      useAuthStore.getState().setSignedIn(
        {
          userId: "other-user",
          userName: "Other",
          email: "other@example.com",
        },
        { userId: "other-user", username: "Other" },
        [],
      );
    });
    await act(async () => {
      attach.reject(attachBusy());
      await attach.promise.catch(() => undefined);
    });

    await waitFor(() => expect(result.current.isPending).toBe(false));
    // The other account's window deletes nothing of this account's.
    expect(landingMocks.deleteRequest).not.toHaveBeenCalled();
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
    expect(readStagedSandbox(SURFACE)).toBeNull();
    expect(usePendingSandboxSendStore.getState().sends[send.id]).toMatchObject({
      epicConfirmed: false,
    });
    expect(readStagedSandbox(pendingSendSurfaceKey(send.id))).toMatchObject({
      target: TEAM_TARGET,
    });
    queryClient.clear();
  });

  it("does not attach a task after its pending send is returned while create is in flight", async () => {
    useStagedSandboxStore.getState().stage(SURFACE, TEAM_TARGET);
    const created = deferred<unknown>();
    landingMocks.request.mockImplementation((method: string) =>
      method === "epic.create" ? created.promise : Promise.resolve({}),
    );
    const queryClient = newQueryClient();
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      { wrapper: queryClientWrapper(queryClient) },
    );

    act(() => {
      result.current.startTaskOnStagedSandbox({
        draftId: null,
        owner: null,
        sandboxTeamId: "team-9",
        text: SUBMITTED_PROMPT,
        hand,
      });
    });

    await waitFor(() => {
      expect(hasEpicCreateRequest()).toBe(true);
    });
    const send = onlyPendingSend();
    expect(returnPendingSandboxSend(send.id).kind).toBe("landing-draft");

    await act(async () => {
      created.resolve({ roomInfo: null });
      await created.promise;
    });

    expect(
      landingMocks.request.mock.calls.some(
        ([method]) => method === "epic.attachEnvironment",
      ),
    ).toBe(false);
    expect(
      usePendingSandboxSendStore.getState().sends[send.id],
    ).toBeUndefined();
    queryClient.clear();
  });

  it.each([
    [
      "refuses the task",
      () =>
        Promise.resolve({
          roomInfo: null,
          refusal: {
            kind: "local-store-unavailable",
            message: "Traycer can't open this device's local store.",
            remedy: "Quit the other Traycer on this machine, then rebind.",
          },
        }),
    ],
    [
      "fails the task's create",
      () => Promise.reject(new Error("epic.create failed")),
    ],
  ] as const)(
    "gives the whole message back to an opened start-task draft when the host %s",
    async (_label, answer) => {
      useStagedSandboxStore.getState().stage(SURFACE, NEW_TARGET);
      landingMocks.request.mockImplementation((method: string) =>
        method === "epic.create" ? answer() : Promise.resolve({}),
      );
      const queryClient = newQueryClient();
      const { result } = renderHook(
        () => useLandingComposerActions(useTestPlacementTarget()),
        { wrapper: queryClientWrapper(queryClient) },
      );

      act(() => {
        result.current.startTaskOnStagedSandbox({
          draftId: null,
          owner: null,
          sandboxTeamId: null,
          text: SUBMITTED_PROMPT,
          hand,
        });
      });

      await waitFor(() => {
        expect(usePendingSandboxSendStore.getState().sends).toEqual({});
      });
      // The send held the message's only copy: it is a draft again, with the
      // agent and model it was sent with and its sandbox, and the window goes
      // to that draft. The composer stages the sandbox when it shows it.
      expect(readStagedSandbox(SURFACE)).toBeNull();
      const drafts = useLandingDraftStore.getState().drafts;
      expect(drafts).toHaveLength(1);
      expect(drafts[0]).toMatchObject({
        content: MESSAGE_CONTENT,
        settings: PICKED_SETTINGS,
        closed: false,
        returnedSandbox: { target: NEW_TARGET },
      });
      renderHook(() => useLandingReturnedSandbox(SURFACE, drafts[0].id, true));
      expect(readStagedSandbox(SURFACE)).toMatchObject({
        target: NEW_TARGET,
        phase: "staged",
        sendTaken: false,
      });
      expect(landingMocks.navigate).toHaveBeenLastCalledWith(
        expect.objectContaining({
          to: "/draft/$draftId",
          params: { draftId: drafts[0].id },
        }),
      );
      queryClient.clear();
    },
  );

  it("saves the message in Drafts with its sandbox when the task is refused after the source picked another", async () => {
    useStagedSandboxStore.getState().stage(SURFACE, NEW_TARGET);
    const create = deferred<unknown>();
    landingMocks.request.mockImplementation((method: string) =>
      method === "epic.create" ? create.promise : Promise.resolve({}),
    );
    const queryClient = newQueryClient();
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      { wrapper: queryClientWrapper(queryClient) },
    );
    act(() => {
      result.current.startTaskOnStagedSandbox({
        draftId: null,
        owner: null,
        sandboxTeamId: null,
        text: SUBMITTED_PROMPT,
        hand,
      });
    });
    await waitFor(() =>
      expect(
        landingMocks.request.mock.calls.some(
          ([method]) => method === "epic.create",
        ),
      ).toBe(true),
    );
    const requestId = readStagedSandbox(
      pendingSendSurfaceKey(onlyPendingSend().id),
    )?.clientRequestId;
    // The person is already composing the next message, on another sandbox.
    useStagedSandboxStore.getState().stage(SURFACE, RESUME_TARGET);
    const newerStage = readStagedSandbox(SURFACE);
    const navigationsBefore = landingMocks.navigate.mock.calls.length;

    await act(async () => {
      create.resolve({
        roomInfo: null,
        refusal: {
          kind: "local-store-unavailable",
          message: "Traycer can't open this device's local store.",
          remedy: "Quit the other Traycer on this machine, then rebind.",
        },
      });
      await create.promise;
    });

    await waitFor(() => {
      expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    });
    expect(readStagedSandbox(SURFACE)).toBe(newerStage);
    const drafts = useLandingDraftStore.getState().drafts;
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      content: MESSAGE_CONTENT,
      settings: PICKED_SETTINGS,
      closed: true,
      returnedSandbox: { target: NEW_TARGET, clientRequestId: requestId },
    });
    // Saved, not opened: the composer stays on the newer message.
    expect(landingMocks.navigate.mock.calls.length).toBe(navigationsBefore);
    const toastCall = toastMessage.mock.calls.at(-1);
    if (toastCall === undefined) throw new Error("expected a toast");
    expect(toastCall[0]).toBe(returnedSandboxMessageLine(true));
    const toastOptions = toastCall[1];
    if (toastOptions === undefined) throw new Error("expected an action");
    expect(toastOptions.action.label).toBe("Open draft");
    act(() => {
      toastOptions.action.onClick();
    });
    expect(landingMocks.navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        to: "/draft/$draftId",
        params: { draftId: drafts[0].id },
      }),
    );
    queryClient.clear();
  });

  it.each([
    ["no host at all", null, null],
    [
      "only a resting sandbox",
      "host-resting-sbx",
      {
        ...sandboxHostEntry("host-resting-sbx", null),
        // Suspended: nothing to dial until it is woken.
        websocketUrl: null,
      },
    ],
  ] as const)(
    "says the placement cannot take a task with %s, so the staged send starts its sandbox first",
    (_label, hostId, entry) => {
      landingMocks.getActiveHostId.mockReturnValue(hostId);
      landingMocks.getActiveHost.mockReturnValue(entry);
      const queryClient = newQueryClient();
      const { result } = renderHook(
        () => useLandingComposerActions(useTestPlacementTarget()),
        { wrapper: queryClientWrapper(queryClient) },
      );
      expect(result.current.placementAdmitsTask()).toBe(false);
      queryClient.clear();
    },
  );

  it("says a usable placement can take a task", () => {
    const queryClient = newQueryClient();
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      { wrapper: queryClientWrapper(queryClient) },
    );
    expect(result.current.placementAdmitsTask()).toBe(true);
    queryClient.clear();
  });

  it("creates nothing and opens nothing when the surface has no stage to hand over", async () => {
    const queryClient = newQueryClient();
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      { wrapper: queryClientWrapper(queryClient) },
    );

    let refusal: { readonly message: string } | null = {
      message: "unset",
    };
    act(() => {
      refusal = result.current.startTaskOnStagedSandbox({
        draftId: null,
        owner: null,
        sandboxTeamId: null,
        text: SUBMITTED_PROMPT,
        hand,
      });
    });

    expect(refusal).toBeNull();
    await flushPending();
    expect(hasEpicCreateRequest()).toBe(false);
    expect(landingMocks.navigate).not.toHaveBeenCalled();
    queryClient.clear();
  });

  it("refuses a team owner the host cannot create for before it hands anything over", async () => {
    recordNegotiatedHostManifest(TEST_HOST_ID, {
      "epic.create": { major: 1, minor: 2 },
    });
    useStagedSandboxStore.getState().stage(SURFACE, NEW_TARGET);
    const queryClient = newQueryClient();
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      { wrapper: queryClientWrapper(queryClient) },
    );

    let refusal: { readonly message: string } | null = null;
    act(() => {
      refusal = result.current.startTaskOnStagedSandbox({
        draftId: null,
        owner: ACME_OWNER,
        sandboxTeamId: null,
        text: SUBMITTED_PROMPT,
        hand,
      });
    });

    expect(refusal).toEqual({ message: HOST_TOO_OLD });
    await flushPending();
    expect(hasEpicCreateRequest()).toBe(false);
    expect(landingMocks.navigate).not.toHaveBeenCalled();
    expect(usePendingSandboxSendStore.getState().sends).toEqual({});
    expect(readStagedSandbox(SURFACE)).not.toBeNull();
    queryClient.clear();
  });
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: Error) => void = () => undefined;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function queryClientWrapper(
  queryClient: QueryClient,
): (props: { readonly children: ReactNode }) => ReactNode {
  return function QueryClientWrapper(props: { readonly children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
  };
}

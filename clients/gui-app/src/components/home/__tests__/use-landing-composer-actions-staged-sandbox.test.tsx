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
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { sandboxHostEntry } from "@/lib/sandboxes/__tests__/sandbox-host-directory-fixture";
// Type-only, so it is erased before `vi.hoisted` runs and cannot re-enter the
// module this file mocks.
import type { ImageReclaimOutcome } from "@/lib/composer/landing-image-store";
import { useHostClient } from "@/lib/host";
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
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { draftRuntimeRegistry } from "@/stores/home/draft-runtime-registry";
import { useTabsStore } from "@/stores/tabs/store";
import { setSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useWorkspaceFoldersStore } from "@/stores/workspace/workspace-folders-store";
import { useWorktreeIntentStagingStore } from "@/stores/worktree/worktree-intent-staging-store";
import { returnPendingSandboxSend } from "@/lib/sandboxes/pending-sandbox-send";
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
import { persistKey, STORE_KEYS } from "@/lib/persist";
import { recordMapStoragePrefix } from "@/lib/persist/keys";
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
  request: vi.fn<(method: string, payload: unknown) => Promise<unknown>>(),
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
}));

vi.mock("@/lib/host", () => ({
  useHostBinding: () => null,
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

function useTestPlacementTarget(): LandingPlacementTarget {
  return {
    resolvedHostId: landingMocks.getActiveHostId(),
    client: useHostClient(),
    hostLabel: "Local",
    isPinned: false,
    namedHostDead: false,
  };
}

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
  },
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
    landingMocks.request.mockReset();
    landingMocks.createTerminalAgent.mockReset();
    landingMocks.navigate.mockReset();
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

  /** A reload of the staged store: memory gone, then read back from storage. */
  async function reloadStagedSandboxes(): Promise<void> {
    const name = persistKey(STORE_KEYS.stagedSandboxSend);
    const prefix = recordMapStoragePrefix(name);
    const saved: Array<readonly [string, string]> = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      const value = key === null ? null : localStorage.getItem(key);
      if (
        key !== null &&
        value !== null &&
        (key === name || key.startsWith(prefix))
      )
        saved.push([key, value]);
    }
    useStagedSandboxStore.setState({ bySurface: {} });
    for (const [key, value] of saved) localStorage.setItem(key, value);
    await useStagedSandboxStore.persist.rehydrate();
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
          return Promise.reject(
            new HostRpcError({
              code: "FORBIDDEN",
              message: "This task cannot be attached to that team.",
              requestId: "request-attach-refused",
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
        expect(usePendingSandboxSendStore.getState().sends).toEqual({});
      });
      expect(readStagedSandbox(SURFACE)).toMatchObject({
        target,
        phase: "staged",
        sendTaken: false,
      });
      expect(useLandingDraftStore.getState().drafts).toHaveLength(1);
      expect(useLandingDraftStore.getState().drafts[0]).toMatchObject({
        content: MESSAGE_CONTENT,
        settings: PICKED_SETTINGS,
        closed: false,
      });
      const returnedDraft = useLandingDraftStore.getState().drafts[0];
      const requestId = readStagedSandbox(SURFACE)?.clientRequestId;
      // A reload before the second Send: the stage comes back with its draft.
      await reloadStagedSandboxes();
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
        clientRequestId: requestId,
      });
      const creates = landingMocks.request.mock.calls.filter(
        ([method]) => method === "epic.create",
      );
      expect(creates).toHaveLength(2);
      for (const [, payload] of creates)
        expect(chatFromCreatePayload(payload)).toBeNull();
      queryClient.clear();
    },
  );

  it("keeps a late refusal with its pending send when the source has a newer explicit stage", async () => {
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
    const send = onlyPendingSend();
    useStagedSandboxStore.getState().stage(SURFACE, NEW_TARGET);
    const newerStage = readStagedSandbox(SURFACE);
    await act(async () => {
      attach.reject(new Error("attachment refused"));
      await attach.promise.catch(() => undefined);
    });
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(readStagedSandbox(SURFACE)).toBe(newerStage);
    expect(onlyPendingSend()).toEqual(send);
    expect(readStagedSandbox(pendingSendSurfaceKey(send.id))?.target).toEqual(
      TEAM_TARGET,
    );
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
    queryClient.clear();
  });

  it("keeps a refused attachment with its pending send when the account changes", async () => {
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
      attach.reject(new Error("attachment refused"));
      await attach.promise.catch(() => undefined);
    });

    await waitFor(() => expect(result.current.isPending).toBe(false));
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
      expect(readStagedSandbox(SURFACE)).toMatchObject({
        target: NEW_TARGET,
        phase: "staged",
        sendTaken: false,
      });
      // The send held the message's only copy: it is a draft again, with the
      // agent and model it was sent with, and the window goes to that draft.
      const drafts = useLandingDraftStore.getState().drafts;
      expect(drafts).toHaveLength(1);
      expect(drafts[0]).toMatchObject({
        content: MESSAGE_CONTENT,
        settings: PICKED_SETTINGS,
        closed: false,
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

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: Error) => void;
} {
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

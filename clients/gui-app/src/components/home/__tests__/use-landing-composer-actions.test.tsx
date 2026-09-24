import { useLandingComposerActions } from "@/components/home/hooks/use-landing-composer-actions";
import type { LandingPlacementTarget } from "@/lib/composer/landing-placement";
// Type-only, so it is erased before `vi.hoisted` runs and cannot re-enter the
// module this file mocks.
import type { ImageReclaimOutcome } from "@/lib/composer/landing-image-store";
import { useHostClient } from "@/lib/host";
import { epicDisplayTitle } from "@/lib/display-title";
import { createEpicName } from "@/lib/epic-name";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  selectHasActiveInitialChatHandoffForEpic,
  useInitialChatHandoffStore,
} from "@/stores/epics/initial-chat-handoff-store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { draftRuntimeRegistry } from "@/stores/home/draft-runtime-registry";
import { useTabsStore } from "@/stores/tabs/store";
import { setSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import { tabItemId, type SplitStripItem } from "@/stores/tabs/layout";
import { useSettingsStore } from "@/stores/settings/settings-store";
import {
  selectWorkspaceFoldersBucket,
  useWorkspaceFoldersStore,
} from "@/stores/workspace/workspace-folders-store";
import {
  useWorktreeIntentStagingStore,
  worktreeStagingKeyString,
  type WorktreeStagingKey,
} from "@/stores/worktree/worktree-intent-staging-store";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import { createComposerEditorIncarnation } from "@/lib/composer/composer-editor-incarnation";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import {
  clearSessionCreatedEpics,
  sessionCreatedEpicHostId,
  wasEpicCreatedRecentlyThisSession,
  wasEpicCreatedThisSession,
} from "@/lib/epics/session-created-epics";
import {
  clearEpicCreateSeedPending,
  EPIC_CREATE_SEED_HOLD_TIMEOUT_MS,
  readEpicCreateSeed,
} from "@/lib/worktree/pending-epic-create-seeds";
import { resetDraftBlobTransportForTests } from "@/lib/drafts/draft-blob-transport";
import { HostTransportFailureError } from "@traycer-clients/shared/host-transport/host-messenger";
import { createOutcomeIsDecidable } from "@/lib/epics/epic-existence-poll";

interface CapturedNavigation {
  readonly search?: (
    previous: Readonly<Record<string, unknown>>,
  ) => Readonly<Record<string, unknown>>;
}

const landingMocks = vi.hoisted(() => ({
  request: vi.fn<(method: string, payload: unknown) => Promise<unknown>>(),
  createTerminalAgent: vi.fn<(input: unknown) => Promise<void>>(),
  navigate: vi.fn<(options: CapturedNavigation) => void>(),
  getActiveHostId: vi.fn(() => "host-landing"),
  getRequestContextUserId: vi.fn<() => string | null>(() => "user-landing"),
  // The directory's LOCAL host id - the machine the user is typing on,
  // deliberately distinct from `getActiveHostId` (the target the chat is
  // created on) so a suite that reads both from the same constant can't
  // pass by coincidence.
  getLocalHostId: vi.fn<() => string | null>(() => "host-local-typing"),
  floorsRequested: new Array<unknown>(),
  dispatchOptions: new Array<{
    readonly method: string;
    readonly options: unknown;
  }>(),
  getActiveHost: vi.fn(() => ({
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
    // An UNVERIFIED create dispatches here instead: the floor that decides
    // whether this host creates locally rides on the request now, answered by
    // the transport from its own handshake. Delegating to the same `request`
    // spy is what a host MEETING the floor does, which is the second half of
    // the case below; the floor is recorded so the admitted dispatch is
    // distinguishable from an authorized one.
    requestWithSignalRequiringHostMethodVersion: (
      method: string,
      payload: unknown,
      _signal: AbortSignal | undefined,
      requiredHostMethodVersion: unknown,
    ): Promise<unknown> => {
      landingMocks.floorsRequested.push(requiredHostMethodVersion);
      return landingMocks.request(method, payload);
    },
    // A KEYED dispatch takes this entry point instead - it is the only one
    // that can carry the idempotency key and the version floor at once, so
    // `epic.create` reaches it whatever the auth verdict is. The floor is
    // pushed to the SAME array the narrow entry point above uses, so a case
    // asserting "this create paid a floor" stays true wherever it was decided,
    // and the whole option bag is recorded beside it for the key.
    requestWithOptions: (
      method: string,
      payload: unknown,
      options: {
        readonly idempotencyKey: string | null;
        readonly requiredHostMethodVersion: unknown;
      },
    ): Promise<unknown> => {
      landingMocks.dispatchOptions.push({ method, options });
      if (options.requiredHostMethodVersion !== null) {
        landingMocks.floorsRequested.push(options.requiredHostMethodVersion);
      }
      return landingMocks.request(method, payload);
    },
    getActiveHostId: landingMocks.getActiveHostId,
    getActiveHost: landingMocks.getActiveHost,
    getRequestContextUserId: landingMocks.getRequestContextUserId,
  }),
}));

vi.mock("@/lib/host/runtime", () => ({
  getHostBindingSnapshot: () => ({
    hostClient: { getActiveHostId: landingMocks.getActiveHostId },
    // The create stamps `sentFromHostId` from the directory's local host at
    // submit - see `landingMocks.getLocalHostId` for the default and the
    // sender-host-placement cases below for the assertions.
    directory: { getLocalHostId: landingMocks.getLocalHostId },
  }),
}));

vi.mock("@/hooks/agent/use-create-tui-agent", () => ({
  useCreateTuiAgentForClient: () => ({
    create: landingMocks.createTerminalAgent,
    isPending: false,
  }),
}));

/**
 * The composer's resolved placement (redesign P1.2). These tests exercise the
 * READY arm - `resolveLandingPlacement`'s own refusals have their own unit
 * suite - so the target names the same host the mocked client addresses.
 */
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

// Every other rejection settles immediately through `settleUnlandedLandingEpic`
// (a plain `Error` is not even `instanceof HostRpcError`, so it never reaches
// this seam) - only the ambiguous-drop/keyReuseConflict arm calls
// `pollEpicExistence`, and only the by-hash cases below drive that arm.
// `createOutcomeIsDecidable` stays REAL (via `importOriginal`) so a case that
// exercises it is pinning the actual classifier, not a stub of it.
const pollMocks = vi.hoisted(() => ({
  pollEpicExistence:
    vi.fn<(input: unknown) => Promise<"exists" | "absent" | "unknown">>(),
}));
vi.mock("@/lib/epics/epic-existence-poll", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/epics/epic-existence-poll")>();
  return { ...actual, pollEpicExistence: pollMocks.pollEpicExistence };
});

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
  // The partition is EMPTY AND ALREADY ENUMERATED, which is one stand-in, not
  // five: `imageHashKeys` answering `[]` is only coherent alongside a hydration
  // that has finished and a presence set that agrees with it.
  //
  // `landingImageSizesHydrated` answers `true` for that reason and not because
  // a case here depends on it - no assertion in this file moves when it is
  // flipped, which was checked. A from-scratch factory never runs the startup
  // pass, so `false` would not model "not yet measured"; it would model a
  // partition whose contents are unknown while `imageHashKeys` beside it claims
  // to know they are none, and `rootByteCost` prices those two answers very
  // differently.
  ensureMeasuredImageSizes: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  landingImageSizesHydrated: vi.fn<() => boolean>(() => true),
  measuredLandingImageSize: vi.fn<(hash: string) => number | null>(() => null),
  hasLandingImageBytes: vi.fn<(hash: string) => boolean>(() => false),
  flushReclaimCustody: vi.fn<() => Promise<number>>(() => Promise.resolve(0)),
  // Unreachable with an empty partition - the sweep only reclaims a hash it
  // enumerated - so this answers the one outcome that matches that emptiness
  // rather than pretending a delete happened.
  reclaimImageBytes: vi.fn<
    (hash: string, isRooted: () => boolean) => Promise<ImageReclaimOutcome>
  >(() => Promise.resolve("absent")),
}));

// Every export the module graph under test actually reads, not only the ones
// this file calls: `landing-image-gc` and `landing-image-budget` import from
// here too, and a from-scratch factory that omits one makes vitest warn and the
// importer read `undefined` at call time.
vi.mock("@/lib/composer/landing-image-store", () => ({
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

const SUBMITTED_PROMPT = "Plan the host chat bootstrap";

// The recorded RPC payload is `unknown` at this boundary, so the folded chat's
// id is narrowed structurally rather than asserted through a cast.
function foldedChatIdFromCreateEpicPayload(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  if (!("chat" in payload)) return null;
  const chat = payload.chat;
  if (typeof chat !== "object" || chat === null) return null;
  if (!("chatId" in chat)) return null;
  const chatId = chat.chatId;
  return typeof chatId === "string" ? chatId : null;
}

// Same structural-narrowing shape as the chat-id reader above, for the
// epic's own id - present on both flows' `epic.create` payload (`chat` is
// `null` on the terminal-agent flow, but `epic.id` always rides along).
function deferWorktreeProvisioningFromCreateEpicPayload(
  payload: unknown,
): boolean | "absent" {
  if (typeof payload !== "object" || payload === null) return "absent";
  if (!("chat" in payload)) return "absent";
  const chat = payload.chat;
  if (typeof chat !== "object" || chat === null) return "absent";
  if (!("deferWorktreeProvisioning" in chat)) return "absent";
  return chat.deferWorktreeProvisioning === true;
}

function epicIdFromCreateEpicPayload(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  if (!("epic" in payload)) return null;
  const epic = payload.epic;
  if (typeof epic !== "object" || epic === null) return null;
  if (!("id" in epic)) return null;
  const id = epic.id;
  return typeof id === "string" ? id : null;
}
const WORKSPACE_PATH = "/tmp/traycer";
const DRAFT_WORKSPACE_PATH = "/tmp/draft-workspace";
const GLOBAL_WORKSPACE_PATH = "/tmp/global-workspace";
const UNKNOWN_WORKSPACE_PATH = "/tmp/unknown-workspace";

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

// Every workspace-folder / run-settings bucket in this suite is keyed by
// this host id, matching `landingMocks.getActiveHostId()`'s default return
// value - the same id `client.getActiveHostId()` resolves to via the mocked
// `@/lib/host` client.
const TEST_HOST_ID = "host-landing";

function setGlobalWorkspaceFolders(input: {
  readonly folders: ReadonlyArray<string>;
  readonly folderInfoByPath: Readonly<
    Record<
      string,
      {
        readonly path: string;
        readonly name: string;
        readonly repoIdentifier: { owner: string; repo: string } | null;
        readonly hostId: string | null;
      }
    >
  >;
  readonly primaryPath?: string | null;
}): void {
  useWorkspaceFoldersStore.setState({
    byHost: {
      [TEST_HOST_ID]: {
        folders: input.folders,
        folderInfoByPath: input.folderInfoByPath,
        primaryPath: input.primaryPath ?? null,
      },
    },
  });
}

describe("useLandingComposerActions", () => {
  beforeEach(() => {
    __resetTabNavigationControllerForTesting();
    draftRuntimeRegistry.resetForTesting();
    window.localStorage.clear();
    // Creation is admitted for a session holding a cloud verdict; the
    // unverified admission has its own case below.
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
    // Beside its siblings, for the same reason as the popover's recorder: this
    // one lives in the SAME object as the mocks reset here and was the single
    // member skipped, which is how a recorder drifts out of the reset
    // discipline the rest of the fixture already follows.
    //
    // No false pass was measured here, and the assertion this feeds is an
    // exact-array `toEqual`, which is already empty-refusing and already pins
    // the count - so unlike the popover's, that assertion needs no change.
    //
    // Its untreated hazard was still the mirror image of the popover's, and
    // runs in the direction execution does: an EARLIER sibling dispatching a
    // floored create leaves a record this case then reads, so its exact-array
    // `toEqual` sees two elements and reddens - a false FAILURE pointing at
    // innocent code, rather than the popover's false pass. (The same residue
    // the other way is this case contaminating a LATER sibling that grows its
    // own exact-array assertion.) A later case cannot reach back and change an
    // assertion that has already run; only what precedes it can.
    landingMocks.floorsRequested.length = 0;
    // Same residue risk as `floorsRequested` just above: an earlier test's
    // `drafts.putBlob` dispatch would otherwise still be sitting here when a
    // later by-hash case asserts "no putBlob went out", reading as a false
    // failure that has nothing to do with that later case's own behavior.
    landingMocks.dispatchOptions.length = 0;
    landingMocks.request.mockResolvedValue({ roomInfo: null });
    landingMocks.createTerminalAgent.mockResolvedValue(undefined);
    landingMocks.getActiveHostId.mockReset();
    landingMocks.getActiveHostId.mockReturnValue("host-landing");
    landingMocks.getLocalHostId.mockReset();
    landingMocks.getLocalHostId.mockReturnValue("host-local-typing");
    landingMocks.getActiveHost.mockReset();
    landingMocks.getActiveHost.mockReturnValue({
      hostId: "host-landing",
      label: "Local",
      kind: "local",
      websocketUrl: "ws://127.0.0.1:4917/rpc",
      version: "0.0.0-test",
      transportDialability: "dialable",
    });
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.info).mockClear();
    imageStoreMocks.sessionImageBytes.mockReset();
    imageStoreMocks.sessionImageBytes.mockReturnValue(null);
    imageStoreMocks.getImageBytes.mockReset();
    imageStoreMocks.getImageBytes.mockResolvedValue(undefined);
    pollMocks.pollEpicExistence.mockReset();
    pollMocks.pollEpicExistence.mockResolvedValue("unknown");
    resetDraftBlobTransportForTests();
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
    // Pre-created drafts read the real composer host snapshot. Match the
    // mocked client's host so they inherit the workspace/settings fixtures.
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

  // Regression: consuming the landing session was gated on the SUBMITTING
  // host having an intent, so staging on host A and then submitting from a
  // folderless host B left A's slot alive - to seed the next landing session
  // (null draft) or linger against the staging cap (minted draft).
  it("consumes another host's staged pick even when the submitting host has none", async () => {
    const otherHostKey: WorktreeStagingKey = {
      surface: "landing",
      hostId: "host-other",
      draftId: null,
    };
    useWorktreeIntentStagingStore.getState().setIntent(otherHostKey, {
      entries: [
        {
          kind: "local",
          workspacePath: "/elsewhere/repo",
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      {
        wrapper: queryClientWrapper(queryClient),
      },
    );

    act(() => {
      result.current.submit({
        draftId: null,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });

    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
      ).toBe(true);
    });
    // The submitting host is folderless, so its own intent is null...
    const createEpicCall = landingMocks.request.mock.calls.find(
      (c) => c[0] === "epic.create",
    );
    expect(createEpicCall?.[1]).toMatchObject({
      chat: { worktreeIntent: null },
    });
    // ...and the other host's copy is still consumed with the session.
    await waitFor(() => {
      expect(
        useWorktreeIntentStagingStore.getState().intentByKey[
          worktreeStagingKeyString(otherHostKey)
        ],
      ).toBeUndefined();
    });

    queryClient.clear();
  });

  it("creates a folderless epic without a selected workspace folder", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      {
        wrapper: queryClientWrapper(queryClient),
      },
    );

    act(() => {
      result.current.submit({
        draftId: null,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });

    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
      ).toBe(true);
    });

    const createEpicCall = landingMocks.request.mock.calls.find(
      (c) => c[0] === "epic.create",
    );
    expect(createEpicCall?.[1]).toMatchObject({
      repoIdentifiers: [],
      workspaces: [],
      chat: {
        workspaceMode: "folderless",
        worktreeIntent: null,
      },
    });
    expect(landingMocks.navigate).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(useEpicCanvasStore.getState().openTabOrder).toHaveLength(1);
    });
    expect(toast.error).not.toHaveBeenCalled();

    queryClient.clear();
  });

  // `sentFromHostId` names the machine the user is TYPING on (the local host,
  // read from `readLocalHostIdSnapshot`), never `activeHostId` (the tab/target
  // host the chat is created on). This suite's default mocks already make the
  // two diverge - `getLocalHostId` answers "host-local-typing",
  // `getActiveHostId` answers "host-landing" - so a reader that was quietly
  // replaced by the target host would fail this alongside a reader replaced
  // by a constant.
  it("stamps the initial message's sentFromHostId with the local host id, not the target host", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      {
        wrapper: queryClientWrapper(queryClient),
      },
    );

    act(() => {
      result.current.submit({
        draftId: null,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });

    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
      ).toBe(true);
    });

    const createEpicCall = landingMocks.request.mock.calls.find(
      (c) => c[0] === "epic.create",
    );
    expect(createEpicCall?.[1]).toMatchObject({
      chat: {
        hostId: "host-landing",
        initialMessage: { sentFromHostId: "host-local-typing" },
      },
    });

    queryClient.clear();
  });

  // Widening the divergence beyond the suite defaults: an explicit target
  // host that is neither `undefined` nor coincidentally equal to the local
  // host id, still pinned against the local id and not the target.
  it("stamps sentFromHostId with the local host id even when the target host is switched", async () => {
    landingMocks.getActiveHostId.mockReturnValue("host-target-different");
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      {
        wrapper: queryClientWrapper(queryClient),
      },
    );

    act(() => {
      result.current.submit({
        draftId: null,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });

    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
      ).toBe(true);
    });

    const createEpicCall = landingMocks.request.mock.calls.find(
      (c) => c[0] === "epic.create",
    );
    expect(createEpicCall?.[1]).toMatchObject({
      chat: {
        hostId: "host-target-different",
        initialMessage: { sentFromHostId: "host-local-typing" },
      },
    });

    queryClient.clear();
  });

  // The null path stays pinned: a shell with no local host (browser, mobile,
  // or before the runtime has resolved a binding) sends no sender host,
  // rather than falling back to the target host.
  it("sends a null sentFromHostId when the directory has no local host", async () => {
    landingMocks.getLocalHostId.mockReturnValue(null);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      {
        wrapper: queryClientWrapper(queryClient),
      },
    );

    act(() => {
      result.current.submit({
        draftId: null,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });

    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
      ).toBe(true);
    });

    const createEpicCall = landingMocks.request.mock.calls.find(
      (c) => c[0] === "epic.create",
    );
    expect(createEpicCall?.[1]).toMatchObject({
      chat: { initialMessage: { sentFromHostId: null } },
    });

    queryClient.clear();
  });

  it("folds the SAME chat id into epic.create that the launch handoff carries", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      {
        wrapper: queryClientWrapper(queryClient),
      },
    );

    act(() => {
      result.current.submit({
        draftId: null,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });

    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
      ).toBe(true);
    });

    // ONE MINT. The launch tab is opened around `handoff.chatId` (see
    // `initial-chat-handoff.test.tsx`, which asserts the eager-opened tile
    // carries exactly that id) and the chat itself is created by the folded
    // seed on this request - so if these two ids could ever diverge, the tab
    // would sit on a chat id that exists on no host and in no cloud row while
    // the real chat lived under the other one.
    const createEpicCall = landingMocks.request.mock.calls.find(
      (c) => c[0] === "epic.create",
    );
    const foldedChatId = foldedChatIdFromCreateEpicPayload(createEpicCall?.[1]);
    const handoff = Object.values(
      useInitialChatHandoffStore.getState().handoffs,
    ).at(0);
    expect(foldedChatId).not.toBeNull();
    expect(handoff?.chatId).toBe(foldedChatId);

    queryClient.clear();
  });

  it("refuses launch while a staged worktree path has unresolved metadata", () => {
    setSingleWorkspace();
    const key = {
      surface: "landing" as const,
      hostId: TEST_HOST_ID,
      draftId: null,
    };
    useWorktreeIntentStagingStore.getState().stageIntent(key, {
      entries: [
        {
          kind: "worktree",
          scripts: null,
          workspacePath: WORKSPACE_PATH,
          repoIdentifier: null,
          isPrimary: true,
          branch: {
            type: "new",
            name: "feat-unresolved",
            source: "main",
            carryUncommittedChanges: false,
          },
        },
      ],
    });
    useWorktreeIntentStagingStore
      .getState()
      .setSuspendedWorkspacePaths(key, [WORKSPACE_PATH]);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      {
        wrapper: queryClientWrapper(queryClient),
      },
    );

    act(() => {
      result.current.submit({
        draftId: null,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });

    expect(landingMocks.request).not.toHaveBeenCalled();
    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString({
          surface: "landing",
          hostId: TEST_HOST_ID,
          draftId: null,
        })
      ],
    ).toBeDefined();
    queryClient.clear();
  });

  it("refuses an unverified session's create on a host without the local-first line, and admits it on one with it", async () => {
    // `epic.create@1.0` cannot say whether this host creates locally or sends
    // the create to the cloud on the retained credential; the host's
    // `epic.listTasks` line can, and it is negotiated.
    setSingleWorkspace();
    useAuthStore
      .getState()
      .setUnverifiedSession(
        { userId: "user-landing", userName: "U", email: "u@example.com" },
        { userId: "user-landing", username: "U" },
      );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      {
        wrapper: queryClientWrapper(queryClient),
      },
    );

    // No manifest recorded for the host: fails closed.
    let refusal: { readonly message: string } | null = null;
    act(() => {
      refusal = result.current.submit({
        draftId: null,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });
    expect(refusal).not.toBeNull();
    expect(landingMocks.request).not.toHaveBeenCalled();

    // The host advertises the local-first line: the same session is admitted.
    recordNegotiatedHostManifest(TEST_HOST_ID, {
      "epic.create": { major: 1, minor: 1 },
    });
    let admitted: { readonly message: string } | null = { message: "unset" };
    act(() => {
      admitted = result.current.submit({
        draftId: null,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });
    expect(admitted).toBeNull();
    await waitFor(() => {
      expect(landingMocks.request).toHaveBeenCalled();
    });
    // The admitted create carries the floor, which is what makes it safe to
    // admit: the composer's own gate reads the negotiated-manifest registry,
    // and that registry can name a host process already replaced by the time
    // this create's handshake runs. The floor is what the connection carrying
    // the create answers for itself.
    expect(landingMocks.floorsRequested).toEqual([
      { method: "epic.create", version: { major: 1, minor: 1 } },
    ]);
    queryClient.clear();
  });

  it("threads a non-ambient profileId into the initial chat message's run settings", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      {
        wrapper: queryClientWrapper(queryClient),
      },
    );

    act(() => {
      result.current.submit({
        draftId: null,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        toolbar: {
          ...defaultToolbar(),
          selection: {
            ...defaultToolbar().selection,
            profileId: "work-profile",
          },
        },
      });
    });

    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
      ).toBe(true);
    });

    // `finalizeSubmission` writes the emitted settings to the sticky
    // run-settings store unconditionally (independent of the initial-message
    // path, which needs a signed-in profile this suite doesn't mock).
    expect(
      useComposerRunSettingsStore.getState().getGlobalRunSettings(TEST_HOST_ID)
        ?.profileId,
    ).toBe("work-profile");

    queryClient.clear();
  });

  it("creates a folderless terminal-agent epic without a selected workspace folder", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      {
        wrapper: queryClientWrapper(queryClient),
      },
    );

    act(() => {
      result.current.selectTerminalAgent(
        {
          harnessId: "claude",
          model: null,
          reasoningEffort: null,
          terminalAgentArgs: "",
          profileId: null,
        },
        null,
      );
    });

    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(landingMocks.createTerminalAgent).toHaveBeenCalledTimes(1);
    });

    const createEpicCall = landingMocks.request.mock.calls.find(
      (c) => c[0] === "epic.create",
    );
    expect(createEpicCall?.[1]).toMatchObject({
      repoIdentifiers: [],
      workspaces: [],
      chat: null,
    });
    expect(landingMocks.createTerminalAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceMode: "folderless",
        worktreeIntent: null,
      }),
    );
    expect(landingMocks.navigate).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();

    queryClient.clear();
  });

  it("threads a non-ambient profileId into the terminal-agent create call", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      {
        wrapper: queryClientWrapper(queryClient),
      },
    );

    act(() => {
      result.current.selectTerminalAgent(
        {
          harnessId: "claude",
          model: null,
          reasoningEffort: null,
          terminalAgentArgs: "",
          profileId: "work-profile",
        },
        null,
      );
    });

    await waitFor(() => {
      expect(landingMocks.createTerminalAgent).toHaveBeenCalledTimes(1);
    });
    expect(landingMocks.createTerminalAgent).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "work-profile" }),
    );

    queryClient.clear();
  });

  it("blocks epic creation while the model slug is unresolved", () => {
    setGlobalWorkspaceFolders({
      folders: [WORKSPACE_PATH],
      folderInfoByPath: {
        [WORKSPACE_PATH]: {
          path: WORKSPACE_PATH,
          name: "traycer",
          repoIdentifier: { owner: "traycerai", repo: "traycer" },
          hostId: TEST_HOST_ID,
        },
      },
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      {
        wrapper: queryClientWrapper(queryClient),
      },
    );

    act(() => {
      result.current.submit({
        draftId: null,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        toolbar: {
          ...defaultToolbar(),
          selection: { harnessId: "codex", modelSlug: "", profileId: null },
        },
      });
    });

    expect(landingMocks.request).not.toHaveBeenCalled();
    expect(landingMocks.navigate).not.toHaveBeenCalled();
    expect(
      useComposerRunSettingsStore.getState().getGlobalRunSettings(TEST_HOST_ID),
    ).toBeNull();
    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]);

    queryClient.clear();
  });

  it("creates an epic with workspace paths and repo identifiers, then navigates", async () => {
    setGlobalWorkspaceFolders({
      folders: [WORKSPACE_PATH],
      folderInfoByPath: {
        [WORKSPACE_PATH]: {
          path: WORKSPACE_PATH,
          name: "traycer",
          repoIdentifier: { owner: "traycerai", repo: "traycer" },
          hostId: TEST_HOST_ID,
        },
      },
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      {
        wrapper: queryClientWrapper(queryClient),
      },
    );

    act(() => {
      result.current.submit({
        draftId: null,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });

    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
      ).toBe(true);
    });

    const createEpicCall = landingMocks.request.mock.calls.find(
      (c) => c[0] === "epic.create",
    );
    // Chat epics store an empty `title` (`""`) at create - the prompt is the
    // display-derivation source, carried on `initialUserPrompt`, not baked into
    // the stored title.
    expect(createEpicCall?.[1]).toMatchObject({
      epic: { title: "", initialUserPrompt: SUBMITTED_PROMPT },
      repoIdentifiers: [{ owner: "traycerai", repo: "traycer" }],
      workspaces: [{ workspacePath: WORKSPACE_PATH }],
    });

    await waitFor(() => {
      expect(useEpicCanvasStore.getState().openTabOrder).toHaveLength(1);
    });
    expect(landingMocks.navigate).not.toHaveBeenCalled();

    const tabIds = useEpicCanvasStore.getState().openTabOrder;
    expect(tabIds).toHaveLength(1);
    const firstTab = useEpicCanvasStore.getState().tabsById[tabIds[0]];
    if (firstTab === undefined) throw new Error("expected created tab");
    // The tab carries the RAW empty title; the prompt slice is derived at render
    // via `epicDisplayTitle`, never persisted into the tab `name`.
    expect(firstTab.name).toBe("");
    expect(
      epicDisplayTitle({
        title: firstTab.name,
        initialUserPrompt: SUBMITTED_PROMPT,
      }),
    ).toBe(createEpicName(SUBMITTED_PROMPT));
    const expectedSettings = {
      harnessId: "codex",
      model: "gpt-5-codex",
      permissionMode: "supervised",
      reasoningEffort: "high",
      serviceTier: null,
      agentMode: "regular",
      profileId: null,
    };
    expect(
      useComposerRunSettingsStore.getState().getGlobalRunSettings(TEST_HOST_ID),
    ).toEqual(expectedSettings);
    expect(
      useComposerRunSettingsStore
        .getState()
        .getEpicRunSettings(firstTab.epicId, TEST_HOST_ID),
    ).toEqual(expectedSettings);

    queryClient.clear();
  });

  it("re-inlines a same-session image synchronously and keeps navigation sync", async () => {
    setSingleWorkspace();
    imageStoreMocks.sessionImageBytes.mockReturnValue(HELLO_BYTES);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      {
        wrapper: queryClientWrapper(queryClient),
      },
    );

    act(() => {
      result.current.submit({
        draftId: null,
        editor: editorHandleForHashImage("hash-same-session", "look here"),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });

    // The session fast path resolves bytes without an await, but placement waits
    // for the one-shot create response and never steals foreground focus.
    expect(landingMocks.navigate).not.toHaveBeenCalled();
    expect(imageStoreMocks.getImageBytes).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
      ).toBe(true);
    });
    // The BYTES go on the wire, re-inlined, with no hash left for the host to
    // resolve. That is what "re-inlines a same-session image" claims.
    const sentAttrs = imageAttrsFromEpicCreate();
    expect(sentAttrs.b64content).toBe(HELLO_BASE64);
    // `?? null` because `inlineHashOnlyImageBytes` DROPS the `hash` attr
    // rather than nulling it - a re-inlined node is byte-for-byte the shape a
    // fresh inline paste produces, which is what makes an old host's ingest
    // work unchanged. Absent and explicit-null both mean the same thing here:
    // nothing left for the host to resolve.
    expect(sentAttrs.hash ?? null).toBeNull();
    // The handoff copy is the mirror image, and deliberately so: hash-only, so
    // nothing base64 is persisted under the handoff key, and the hash roots
    // those bytes against the image GC until the resend inlines them.
    const handoffNode = handoffImageNode();
    // `?? null` because ABSENT and explicit-null both mean "no bytes here": the
    // node this document started from never carried a `b64content` key, and
    // only the persist-time strip normalizes one to null. The invariant being
    // pinned is that nothing base64 reaches the handoff, either way.
    expect(handoffNode.attrs?.b64content ?? null).toBeNull();
    expect(handoffNode.attrs?.hash).toBe("hash-same-session");

    queryClient.clear();
  });

  // The workspace context is read for the host active at submit; on the
  // session-cold image path an IndexedDB await separates that read from the
  // create, and `epic.create` dispatches to whichever host is active THEN.
  // Creating on B with A's paths would bind the epic to a machine the user
  // never composed against and file its remembered intent under a host that
  // will never read it.
  it("does not trip the drift refusal when the binding flips mid-await - placement and context are both captured at submit", async () => {
    setSingleWorkspace();
    imageStoreMocks.sessionImageBytes.mockReturnValue(null);
    const imageGate = deferred<Uint8Array | undefined>();
    imageStoreMocks.getImageBytes.mockReturnValue(imageGate.promise);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      {
        wrapper: queryClientWrapper(queryClient),
      },
    );

    act(() => {
      result.current.submit({
        draftId: null,
        editor: editorHandleForHashImage("hash-restored", "restored draft"),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });

    // The app binding moves while the IndexedDB read is in flight. Under the
    // frozen-placement model the placement target AND the workspace context
    // were both captured at submit, so the flip cannot make them diverge -
    // the fail-closed divergence guard stays silent and the flow proceeds to
    // the create attempt (which this suite's stub client then rejects; that
    // host-error toast is the non-vacuity signal the flow really ran).
    landingMocks.getActiveHostId.mockReturnValue("host-switched");
    await act(async () => {
      imageGate.resolve(HELLO_BYTES);
      await imageGate.promise;
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
    expect(toast.error).not.toHaveBeenCalledWith(
      "Couldn't create epic.",
      expect.objectContaining({
        description:
          "The active device changed while this was being prepared. Try again.",
      }),
    );

    landingMocks.getActiveHostId.mockReturnValue(TEST_HOST_ID);
    queryClient.clear();
  });

  it("awaits IndexedDB for a restored (session-cold) image before sending", async () => {
    setSingleWorkspace();
    imageStoreMocks.sessionImageBytes.mockReturnValue(null);
    imageStoreMocks.getImageBytes.mockResolvedValue(HELLO_BYTES);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      {
        wrapper: queryClientWrapper(queryClient),
      },
    );

    act(() => {
      result.current.submit({
        draftId: null,
        editor: editorHandleForHashImage("hash-restored", "restored draft"),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });

    // Cold cache → the optimistic block waits on the async IndexedDB read; nothing
    // has navigated yet on the synchronous tick.
    expect(landingMocks.navigate).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(useEpicCanvasStore.getState().openTabOrder).toHaveLength(1);
    });
    expect(landingMocks.navigate).not.toHaveBeenCalled();
    expect(imageStoreMocks.getImageBytes).toHaveBeenCalledWith("hash-restored");

    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
      ).toBe(true);
    });
    // The awaited bytes are what went out - the point of the await.
    const sentAttrs = imageAttrsFromEpicCreate();
    expect(sentAttrs.b64content).toBe(HELLO_BASE64);
    // Absent OR explicit null: the rewrite drops the attr (see above).
    expect(sentAttrs.hash ?? null).toBeNull();
    // And the persisted handoff still holds only the hash.
    const handoffNode = handoffImageNode();
    expect(handoffNode.attrs?.b64content ?? null).toBeNull();
    expect(handoffNode.attrs?.hash).toBe("hash-restored");

    queryClient.clear();
  });

  it("blocks the send with a toast when an image's bytes are missing", async () => {
    setSingleWorkspace();
    imageStoreMocks.sessionImageBytes.mockReturnValue(null);
    imageStoreMocks.getImageBytes.mockResolvedValue(undefined);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      {
        wrapper: queryClientWrapper(queryClient),
      },
    );

    act(() => {
      result.current.submit({
        draftId: null,
        editor: editorHandleForHashImage("hash-missing", "wiped image"),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Couldn't attach an image.", {
        description: "Re-add the image and try sending again.",
      });
    });
    // The send is aborted: no navigation, no epic created.
    expect(landingMocks.navigate).not.toHaveBeenCalled();
    expect(
      landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
    ).toBe(false);

    queryClient.clear();
  });

  it("a rejected IndexedDB read falls through to the other legs and still aborts audibly", async () => {
    setSingleWorkspace();
    imageStoreMocks.sessionImageBytes.mockReturnValue(null);
    imageStoreMocks.getImageBytes.mockRejectedValue(
      new Error("idb unavailable"),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      {
        wrapper: queryClientWrapper(queryClient),
      },
    );

    act(() => {
      result.current.submit({
        draftId: null,
        editor: editorHandleForHashImage("hash-error", "unreadable image"),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });

    // Submission resolves through the THREE-LEG resolver now, not the partition
    // alone, and that resolver CONTAINS an IndexedDB fault by design: a broken
    // local store is precisely when the host and cloud legs matter. So a
    // rejected read no longer aborts on the spot with a storage message - it
    // becomes a leg-1 miss, the other two are tried, and the create is refused
    // only when all three come back empty.
    //
    // What this test has always guaranteed is unchanged and is what it still
    // asserts: the failure is NOT silent, and no epic is created behind it.
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't attach an image.",
        expect.objectContaining({
          description: "Re-add the image and try sending again.",
        }),
      );
    });
    expect(landingMocks.navigate).not.toHaveBeenCalled();
    expect(
      landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
    ).toBe(false);

    queryClient.clear();
  });

  it("guards a double submit while a restored image resolves (creates one epic)", async () => {
    setSingleWorkspace();
    imageStoreMocks.sessionImageBytes.mockReturnValue(null);
    imageStoreMocks.getImageBytes.mockResolvedValue(HELLO_BYTES);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      {
        wrapper: queryClientWrapper(queryClient),
      },
    );

    // Two synchronous submits before the async IndexedDB read resolves. The second
    // hits the in-flight guard; without it, both would resolve and finalize → two
    // epics.
    act(() => {
      const editor = editorHandleForHashImage(
        "hash-restored",
        "restored draft",
      );
      result.current.submit({
        draftId: null,
        editor,
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
      result.current.submit({
        draftId: null,
        editor,
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });

    await waitFor(() => {
      expect(useEpicCanvasStore.getState().openTabOrder).toHaveLength(1);
    });
    // Let any second (unguarded) dispatch flush before asserting.
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      landingMocks.request.mock.calls.filter((c) => c[0] === "epic.create"),
    ).toHaveLength(1);
    expect(landingMocks.navigate).not.toHaveBeenCalled();

    // The guarded submit still STARTED an attempt before bailing, and each
    // `draftId: null` resolves to its own draft - so the guard has to settle
    // the attempt it is refusing. Otherwise that second draft keeps a composer
    // disabled forever with nothing left in flight to release it.
    const stillSubmitting = useLandingDraftStore
      .getState()
      .drafts.filter(
        (draft) =>
          draftRuntimeRegistry.getOrHydrate(draft.id)?.store.getState()
            .isSubmitting === true,
      );
    expect(stillSubmitting).toEqual([]);

    queryClient.clear();
  });

  it("marks the first valid optimistic workspace binding as primary", async () => {
    setGlobalWorkspaceFolders({
      folders: [UNKNOWN_WORKSPACE_PATH, WORKSPACE_PATH],
      folderInfoByPath: {
        [WORKSPACE_PATH]: {
          path: WORKSPACE_PATH,
          name: "traycer",
          repoIdentifier: { owner: "traycerai", repo: "traycer" },
          hostId: TEST_HOST_ID,
        },
      },
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      {
        wrapper: queryClientWrapper(queryClient),
      },
    );

    act(() => {
      result.current.submit({
        draftId: null,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });

    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
      ).toBe(true);
    });

    const seededBindings = queryClient.getQueriesData<{
      readonly rows: ReadonlyArray<{
        readonly runningDir: string;
        readonly isPrimary: boolean;
      }>;
    }>({
      queryKey: hostQueryKeys.methodScope(
        "host-landing",
        "worktree.listBindingsForEpic",
      ),
    });
    expect(seededBindings.map(([, data]) => data?.rows)).toEqual([
      [
        expect.objectContaining({
          runningDir: WORKSPACE_PATH,
          isPrimary: true,
        }),
      ],
    ]);

    queryClient.clear();
  });

  it("emits associations primary-first and restamps the outgoing intent when the explicit primary isn't the first folder", async () => {
    const SECOND_PATH = "/tmp/second-workspace";
    setGlobalWorkspaceFolders({
      folders: [WORKSPACE_PATH, SECOND_PATH],
      folderInfoByPath: {
        [WORKSPACE_PATH]: {
          path: WORKSPACE_PATH,
          name: "traycer",
          repoIdentifier: { owner: "traycerai", repo: "traycer" },
          hostId: TEST_HOST_ID,
        },
        [SECOND_PATH]: {
          path: SECOND_PATH,
          name: "second",
          repoIdentifier: null,
          hostId: TEST_HOST_ID,
        },
      },
      // The user explicitly switched primary to the SECOND folder.
      primaryPath: SECOND_PATH,
    });
    // The staged intent still carries a STALE primary bit on the first
    // folder (staged before the switch) - launch must restamp it by path.
    useWorktreeIntentStagingStore.getState().setIntent(
      { surface: "landing", hostId: TEST_HOST_ID, draftId: null },
      {
        entries: [
          {
            kind: "local",
            workspacePath: WORKSPACE_PATH,
            repoIdentifier: { owner: "traycerai", repo: "traycer" },
            isPrimary: true,
          },
          {
            kind: "local",
            workspacePath: SECOND_PATH,
            repoIdentifier: null,
            isPrimary: false,
          },
        ],
      },
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      {
        wrapper: queryClientWrapper(queryClient),
      },
    );

    act(() => {
      result.current.submit({
        draftId: null,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });

    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
      ).toBe(true);
    });

    const createEpicCall = landingMocks.request.mock.calls.find(
      (c) => c[0] === "epic.create",
    );
    // Associations are emitted primary-first for the legacy order-sensitive
    // host creation; picker display order is untouched (store still holds
    // [first, second]).
    expect(createEpicCall?.[1]).toMatchObject({
      workspaces: [
        { workspacePath: SECOND_PATH },
        { workspacePath: WORKSPACE_PATH },
      ],
      chat: {
        worktreeIntent: {
          entries: [
            expect.objectContaining({
              workspacePath: WORKSPACE_PATH,
              isPrimary: false,
            }),
            expect.objectContaining({
              workspacePath: SECOND_PATH,
              isPrimary: true,
            }),
          ],
        },
      },
    });
    expect(
      selectWorkspaceFoldersBucket(
        useWorkspaceFoldersStore.getState(),
        TEST_HOST_ID,
      ).folders,
    ).toEqual([WORKSPACE_PATH, SECOND_PATH]);

    queryClient.clear();
  });

  it("never lets a ghost folder from corrupt persisted state reach the launch payload or intent restamp", async () => {
    // The reviewer's corrupt-persistence scenario, end to end: a persisted
    // payload whose folder array carries a ghost path with no metadata, a
    // staged intent still naming that ghost as primary - after rehydration
    // + submit, neither the associations nor the intent may carry the ghost,
    // and the real folder must be the (single) primary.
    window.localStorage.setItem(
      "traycer-gui-app:workspace-folders",
      JSON.stringify({
        version: 1,
        state: {
          folders: ["/tmp/ghost", WORKSPACE_PATH],
          folderInfoByPath: {
            [WORKSPACE_PATH]: {
              path: WORKSPACE_PATH,
              name: "traycer",
              repoIdentifier: { owner: "traycerai", repo: "traycer" },
              hostId: TEST_HOST_ID,
            },
          },
          primaryPath: "/tmp/ghost",
        },
      }),
    );
    await useWorkspaceFoldersStore.persist.rehydrate();
    useWorktreeIntentStagingStore.getState().setIntent(
      { surface: "landing", hostId: TEST_HOST_ID, draftId: null },
      {
        entries: [
          {
            kind: "local",
            workspacePath: "/tmp/ghost",
            repoIdentifier: null,
            isPrimary: true,
          },
          {
            kind: "local",
            workspacePath: WORKSPACE_PATH,
            repoIdentifier: { owner: "traycerai", repo: "traycer" },
            isPrimary: false,
          },
        ],
      },
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      {
        wrapper: queryClientWrapper(queryClient),
      },
    );

    act(() => {
      result.current.submit({
        draftId: null,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });

    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
      ).toBe(true);
    });

    const createEpicCall = landingMocks.request.mock.calls.find(
      (c) => c[0] === "epic.create",
    );
    expect(createEpicCall?.[1]).toMatchObject({
      workspaces: [{ workspacePath: WORKSPACE_PATH }],
      chat: {
        worktreeIntent: {
          entries: [
            expect.objectContaining({
              workspacePath: WORKSPACE_PATH,
              isPrimary: true,
            }),
          ],
        },
      },
    });

    queryClient.clear();
  });

  it("synthesizes a local entry for a NON-GIT primary that was never staged, instead of launching with zero primaries", async () => {
    // The mixed git/non-git regression. Only git folders are ever auto-staged
    // (the seeding effect iterates git summaries), so a non-git folder has NO
    // staged entry. Promoting it to primary restamps the only staged (git)
    // entry to `isPrimary: false` and has nothing to promote in its place -
    // so the launch boundary MUST synthesize a `local` entry for it, or the
    // outgoing intent carries zero primaries.
    const NON_GIT_PATH = "/tmp/non-git-workspace";
    setGlobalWorkspaceFolders({
      folders: [WORKSPACE_PATH, NON_GIT_PATH],
      folderInfoByPath: {
        [WORKSPACE_PATH]: {
          path: WORKSPACE_PATH,
          name: "traycer",
          repoIdentifier: { owner: "traycerai", repo: "traycer" },
          hostId: TEST_HOST_ID,
        },
        [NON_GIT_PATH]: {
          path: NON_GIT_PATH,
          name: "non-git",
          repoIdentifier: null,
          hostId: TEST_HOST_ID,
        },
      },
      // The user clicked the pin on the NON-GIT folder.
      primaryPath: NON_GIT_PATH,
    });
    // What `setPrimaryFolder`'s restamp actually leaves behind: the git
    // folder's worktree entry, demoted, and no entry at all for the non-git
    // folder it was demoted in favour of.
    useWorktreeIntentStagingStore.getState().setIntent(
      { surface: "landing", hostId: TEST_HOST_ID, draftId: null },
      {
        entries: [
          {
            kind: "worktree",
            scripts: null,
            workspacePath: WORKSPACE_PATH,
            repoIdentifier: { owner: "traycerai", repo: "traycer" },
            isPrimary: false,
            branch: {
              type: "new",
              name: "traycer/feature",
              source: "main",
              carryUncommittedChanges: false,
            },
          },
        ],
      },
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      {
        wrapper: queryClientWrapper(queryClient),
      },
    );

    act(() => {
      result.current.submit({
        draftId: null,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });

    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
      ).toBe(true);
    });

    const createEpicCall = landingMocks.request.mock.calls.find(
      (c) => c[0] === "epic.create",
    );
    expect(createEpicCall?.[1]).toMatchObject({
      workspaces: [
        { workspacePath: NON_GIT_PATH },
        { workspacePath: WORKSPACE_PATH },
      ],
      chat: {
        worktreeIntent: {
          // Entries follow workspace order. The git folder survives its
          // demotion with its branch selection intact, and the non-git folder
          // gains a synthesized `local` entry carrying the primary flag - so
          // the set holds EXACTLY ONE primary (`toMatchObject` pins the array
          // length, so a third entry or a second primary fails here).
          entries: [
            expect.objectContaining({
              kind: "worktree",
              workspacePath: WORKSPACE_PATH,
              isPrimary: false,
              // The demoted git folder keeps its branch selection intact -
              // demotion restamps `isPrimary`, it never rebuilds the entry.
              branch: {
                type: "new",
                name: "traycer/feature",
                source: "main",
                carryUncommittedChanges: false,
              },
            }),
            expect.objectContaining({
              kind: "local",
              workspacePath: NON_GIT_PATH,
              repoIdentifier: null,
              isPrimary: true,
            }),
          ],
        },
      },
    });

    queryClient.clear();
  });

  it("clears pre-seeded epic settings when epic creation fails", async () => {
    landingMocks.request.mockRejectedValue(new Error("create failed"));
    setGlobalWorkspaceFolders({
      folders: [WORKSPACE_PATH],
      folderInfoByPath: {
        [WORKSPACE_PATH]: {
          path: WORKSPACE_PATH,
          name: "traycer",
          repoIdentifier: { owner: "traycerai", repo: "traycer" },
          hostId: TEST_HOST_ID,
        },
      },
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      {
        wrapper: queryClientWrapper(queryClient),
      },
    );

    act(() => {
      result.current.submit({
        draftId: null,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });

    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
      ).toBe(true);
    });
    // T6 does not materialize a tab before the one-shot create succeeds, so a
    // rejected request leaves no optimistic result to clean up.
    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]);
    expect(
      useComposerRunSettingsStore.getState().getGlobalRunSettings(TEST_HOST_ID),
    ).toEqual({
      harnessId: "codex",
      model: "gpt-5-codex",
      permissionMode: "supervised",
      reasoningEffort: "high",
      serviceTier: null,
      agentMode: "regular",
      profileId: null,
    });

    queryClient.clear();
  });

  it("places a success after close once in the background without navigating", async () => {
    const draftId = useLandingDraftStore
      .getState()
      .createDraftWithId("draft-closing", null);
    const draftRef = { kind: "draft" as const, id: draftId };
    useTabsStore.setState({
      items: [{ kind: "tab", id: tabItemId(draftRef), ref: draftRef }],
      activeItemId: tabItemId(draftRef),
      systemTabs: { history: null, settings: null },
      stripOrder: [draftRef],
    });
    const createGate = deferred<unknown>();
    landingMocks.request.mockImplementation((method) =>
      method === "epic.create" ? createGate.promise : Promise.resolve({}),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      {
        wrapper: queryClientWrapper(queryClient),
      },
    );

    act(() => {
      result.current.submit({
        draftId,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });
    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some(
          (call) => call[0] === "epic.create",
        ),
      ).toBe(true);
    });
    expect(tabCommandCoordinator.closeRef(draftRef)).toBe(true);
    createGate.resolve({ roomInfo: null });

    await waitFor(() => {
      expect(useEpicCanvasStore.getState().openTabOrder).toHaveLength(1);
    });
    expect(landingMocks.navigate).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith("Epic created in the background.");
    queryClient.clear();
  });

  it("re-preflights a moved draft ref and replaces its current location", async () => {
    const draftId = useLandingDraftStore
      .getState()
      .createDraftWithId("draft-moving", null);
    const draftRef = { kind: "draft" as const, id: draftId };
    useTabsStore.setState({
      items: [{ kind: "tab", id: tabItemId(draftRef), ref: draftRef }],
      activeItemId: tabItemId(draftRef),
      systemTabs: { history: null, settings: null },
      stripOrder: [draftRef],
    });
    const createGate = deferred<unknown>();
    landingMocks.request.mockImplementation((method) =>
      method === "epic.create" ? createGate.promise : Promise.resolve({}),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      {
        wrapper: queryClientWrapper(queryClient),
      },
    );

    act(() => {
      result.current.submit({
        draftId,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });
    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some(
          (call) => call[0] === "epic.create",
        ),
      ).toBe(true);
    });
    // Another layout mutation moves the same ref; success must not revive the
    // captured original item id.
    useTabsStore.setState({
      items: [{ kind: "tab", id: "moved-draft-item", ref: draftRef }],
      activeItemId: "moved-draft-item",
      systemTabs: { history: null, settings: null },
      stripOrder: [draftRef],
    });
    createGate.resolve({ roomInfo: null });

    await waitFor(() => {
      expect(useTabsStore.getState().items[0]).toMatchObject({
        kind: "tab",
        ref: { kind: "epic" },
      });
    });
    expect(landingMocks.navigate).toHaveBeenCalledTimes(1);
    queryClient.clear();
  });

  it("keeps Settings open when a submitted draft finishes creating", async () => {
    const draftId = useLandingDraftStore
      .getState()
      .createDraftWithId("draft-settings-race", null);
    const draftRef = { kind: "draft" as const, id: draftId };
    useTabsStore.setState({
      items: [{ kind: "tab", id: tabItemId(draftRef), ref: draftRef }],
      activeItemId: tabItemId(draftRef),
      systemTabs: { history: null, settings: null },
      stripOrder: [draftRef],
    });
    const createGate = deferred<unknown>();
    landingMocks.request.mockImplementation((method) =>
      method === "epic.create" ? createGate.promise : Promise.resolve({}),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      { wrapper: queryClientWrapper(queryClient) },
    );

    act(() => {
      result.current.submit({
        draftId,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });
    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some(
          (call) => call[0] === "epic.create",
        ),
      ).toBe(true);
    });

    // Settings opens while epic.create is still in flight. It is URL-backed,
    // so the success navigation must carry its search flag onto the new Epic
    // route instead of dismissing the modal.
    setSystemTabModalApi({
      active: { kind: "settings", section: "general" },
      openSettings: () => undefined,
      openHistory: () => undefined,
      close: () => undefined,
      setSection: () => undefined,
      promoteToTab: () => undefined,
      isOverlayActive: (kind) => kind === "settings",
    });
    createGate.resolve({ roomInfo: null });

    await waitFor(() => {
      expect(landingMocks.navigate).toHaveBeenCalledTimes(1);
    });
    const search = landingMocks.navigate.mock.calls[0]?.[0].search;
    if (search === undefined) {
      throw new Error("expected created-task navigation to preserve search");
    }
    expect(search({ settingsOverlay: true })).toEqual({
      settingsOverlay: true,
    });
    expect(useTabsStore.getState().items[0]).toMatchObject({
      kind: "tab",
      ref: { kind: "epic" },
    });
    queryClient.clear();
  });

  it("creates an epic from the active draft workspace instead of the global workspace", async () => {
    setGlobalWorkspaceFolders({
      folders: [DRAFT_WORKSPACE_PATH],
      folderInfoByPath: {
        [DRAFT_WORKSPACE_PATH]: {
          path: DRAFT_WORKSPACE_PATH,
          name: "draft-workspace",
          repoIdentifier: { owner: "traycerai", repo: "draft-workspace" },
          hostId: TEST_HOST_ID,
        },
      },
    });
    const draftId = useLandingDraftStore.getState().createDraft(null);
    setGlobalWorkspaceFolders({
      folders: [GLOBAL_WORKSPACE_PATH],
      folderInfoByPath: {
        [GLOBAL_WORKSPACE_PATH]: {
          path: GLOBAL_WORKSPACE_PATH,
          name: "global-workspace",
          repoIdentifier: { owner: "traycerai", repo: "global-workspace" },
          hostId: TEST_HOST_ID,
        },
      },
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      {
        wrapper: queryClientWrapper(queryClient),
      },
    );

    act(() => {
      result.current.submit({
        draftId,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });

    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
      ).toBe(true);
    });

    const createEpicCall = landingMocks.request.mock.calls.find(
      (c) => c[0] === "epic.create",
    );
    expect(createEpicCall?.[1]).toMatchObject({
      repoIdentifiers: [{ owner: "traycerai", repo: "draft-workspace" }],
      workspaces: [{ workspacePath: DRAFT_WORKSPACE_PATH }],
    });
    expect(JSON.stringify(createEpicCall?.[1])).not.toContain(
      GLOBAL_WORKSPACE_PATH,
    );

    queryClient.clear();
  });

  it("retires a started create at identity teardown without opening, navigating, or updating its handoff", async () => {
    const draftId = useLandingDraftStore
      .getState()
      .createDraftWithId("draft-retired", null);
    const draftRef = { kind: "draft" as const, id: draftId };
    useTabsStore.setState({
      items: [{ kind: "tab", id: tabItemId(draftRef), ref: draftRef }],
      activeItemId: tabItemId(draftRef),
      systemTabs: { history: null, settings: null },
      stripOrder: [draftRef],
    });
    const createGate = deferred<unknown>();
    landingMocks.request.mockImplementation((method) =>
      method === "epic.create" ? createGate.promise : Promise.resolve({}),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      {
        wrapper: queryClientWrapper(queryClient),
      },
    );

    act(() => {
      result.current.submit({
        draftId,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });
    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some(
          (call) => call[0] === "epic.create",
        ),
      ).toBe(true);
    });
    const handoffBefore = Object.values(
      useInitialChatHandoffStore.getState().handoffs,
    )[0];
    expect(handoffBefore.status).toBe("pending");

    draftRuntimeRegistry.teardown();
    createGate.resolve({ initialTurnStarted: true });

    await act(async () => {
      await Promise.resolve();
    });
    expect(useTabsStore.getState().items).toEqual([
      { kind: "tab", id: tabItemId(draftRef), ref: draftRef },
    ]);
    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]);
    expect(landingMocks.navigate).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
    const handoffAfter = Object.values(
      useInitialChatHandoffStore.getState().handoffs,
    )[0];
    expect(handoffAfter.status).toBe("pending");
    queryClient.clear();
  });

  it("retires a REJECTED create at identity teardown without marking its handoff failed", async () => {
    // The mirror of the test above on the failure arm. A late rejection after
    // teardown must not write `failed` back onto the torn-down identity: the
    // bridge has already moved on, so the next identity would inherit a
    // failure banner for a submission it never made.
    const draftId = useLandingDraftStore
      .getState()
      .createDraftWithId("draft-retired-reject", null);
    const draftRef = { kind: "draft" as const, id: draftId };
    useTabsStore.setState({
      items: [{ kind: "tab", id: tabItemId(draftRef), ref: draftRef }],
      activeItemId: tabItemId(draftRef),
      systemTabs: { history: null, settings: null },
      stripOrder: [draftRef],
    });
    const createGate = deferred<unknown>();
    landingMocks.request.mockImplementation((method) =>
      method === "epic.create" ? createGate.promise : Promise.resolve({}),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      {
        wrapper: queryClientWrapper(queryClient),
      },
    );

    act(() => {
      result.current.submit({
        draftId,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });
    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some(
          (call) => call[0] === "epic.create",
        ),
      ).toBe(true);
    });
    expect(
      Object.values(useInitialChatHandoffStore.getState().handoffs)[0].status,
    ).toBe("pending");

    draftRuntimeRegistry.teardown();
    createGate.reject(new Error("epic.create rejected after teardown"));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      Object.values(useInitialChatHandoffStore.getState().handoffs)[0].status,
    ).toBe("pending");
    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]);
    queryClient.clear();
  });

  it("preserves a newer exact-draft snapshot and backgrounds the earlier create", async () => {
    const draftId = useLandingDraftStore
      .getState()
      .createDraftWithId("draft-post-intent-edit", null);
    const draftRef = { kind: "draft" as const, id: draftId };
    useTabsStore.setState({
      items: [{ kind: "tab", id: tabItemId(draftRef), ref: draftRef }],
      activeItemId: tabItemId(draftRef),
      systemTabs: { history: null, settings: null },
      stripOrder: [draftRef],
    });
    const createGate = deferred<unknown>();
    landingMocks.request.mockImplementation((method) =>
      method === "epic.create" ? createGate.promise : Promise.resolve({}),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      {
        wrapper: queryClientWrapper(queryClient),
      },
    );

    act(() => {
      result.current.submit({
        draftId,
        editor: editorHandleForPrompt("first request"),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });
    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some(
          (call) => call[0] === "epic.create",
        ),
      ).toBe(true);
    });
    const runtime = draftRuntimeRegistry.getOrHydrate(draftId);
    if (runtime === null) throw new Error("expected draft runtime");
    const newerContent = jsonContentForPrompt("newer unsent draft");
    runtime.setSnapshot(newerContent, null);
    runtime.flush();

    createGate.resolve({ roomInfo: null });
    await waitFor(() => {
      expect(useEpicCanvasStore.getState().openTabOrder).toHaveLength(1);
    });
    expect(
      useLandingDraftStore
        .getState()
        .drafts.find((draft) => draft.id === draftId)?.content,
    ).toEqual(newerContent);
    expect(useTabsStore.getState().stripOrder).toEqual([draftRef]);
    expect(landingMocks.navigate).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith("Epic created in the background.");
    queryClient.clear();
  });

  it("replaces the draft in place when only the caret moves after submit", async () => {
    // Under the event-driven contract, `setEditable(!disabled, false)` no
    // longer re-emits a document `update` on submit, and selection moves go
    // through `setSelection` (no contentRevision bump). A caret-only path
    // after submit must keep settlement current so the epic replaces the
    // draft tab in place - not a background tab with the sent prompt left
    // behind on the landing page.
    const draftId = useLandingDraftStore
      .getState()
      .createDraftWithId("draft-editable-echo", null);
    const draftRef = { kind: "draft" as const, id: draftId };
    useTabsStore.setState({
      items: [{ kind: "tab", id: tabItemId(draftRef), ref: draftRef }],
      activeItemId: tabItemId(draftRef),
      systemTabs: { history: null, settings: null },
      stripOrder: [draftRef],
    });
    const createGate = deferred<unknown>();
    landingMocks.request.mockImplementation((method) =>
      method === "epic.create" ? createGate.promise : Promise.resolve({}),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      {
        wrapper: queryClientWrapper(queryClient),
      },
    );

    act(() => {
      result.current.submit({
        draftId,
        // A fresh object per `getJSON()` call, exactly like the real editor.
        editor: {
          ...editorHandleForPrompt(SUBMITTED_PROMPT),
          getJSON: () => jsonContentForPrompt(SUBMITTED_PROMPT),
        },
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });
    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some(
          (call) => call[0] === "epic.create",
        ),
      ).toBe(true);
    });

    // Caret-only after submit - must not retire the placement.
    const runtime = draftRuntimeRegistry.getOrHydrate(draftId);
    if (runtime === null) throw new Error("expected draft runtime");
    runtime.setSelection({ from: 2, to: 2 });

    createGate.resolve({ roomInfo: null });
    await waitFor(() => {
      expect(useTabsStore.getState().items[0]).toMatchObject({
        kind: "tab",
        ref: { kind: "epic" },
      });
    });
    expect(useTabsStore.getState().items).toHaveLength(1);
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
    expect(landingMocks.navigate).toHaveBeenCalledTimes(1);
    expect(toast.info).not.toHaveBeenCalledWith(
      "Epic created in the background.",
    );
    queryClient.clear();
  });

  it("keeps foreground suppressed when focus was acquired after submit intent", async () => {
    const draftA = useLandingDraftStore
      .getState()
      .createDraftWithId("draft-a", null);
    const draftB = useLandingDraftStore
      .getState()
      .createDraftWithId("draft-b", null);
    const refA = { kind: "draft" as const, id: draftA };
    const refB = { kind: "draft" as const, id: draftB };
    useTabsStore.setState({
      items: [splitItem("focus-split", refA, refB, "right")],
      activeItemId: "focus-split",
      systemTabs: { history: null, settings: null },
      stripOrder: [refA, refB],
    });
    const createGate = deferred<unknown>();
    landingMocks.request.mockImplementation((method) =>
      method === "epic.create" ? createGate.promise : Promise.resolve({}),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      {
        wrapper: queryClientWrapper(queryClient),
      },
    );

    act(() => {
      result.current.submit({
        draftId: draftA,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });
    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some(
          (call) => call[0] === "epic.create",
        ),
      ).toBe(true);
    });
    useTabsStore.setState({
      items: [splitItem("focus-split", refA, refB, "left")],
      activeItemId: "focus-split",
      systemTabs: { history: null, settings: null },
      stripOrder: [refA, refB],
    });
    // Focus away and back after intent cannot retroactively grant ownership.
    useTabsStore.setState({
      items: [splitItem("focus-split", refA, refB, "right")],
      activeItemId: "focus-split",
      systemTabs: { history: null, settings: null },
      stripOrder: [refA, refB],
    });
    useTabsStore.setState({
      items: [splitItem("focus-split", refA, refB, "left")],
      activeItemId: "focus-split",
      systemTabs: { history: null, settings: null },
      stripOrder: [refA, refB],
    });

    createGate.resolve({ roomInfo: null });
    await waitFor(() => {
      expect(useTabsStore.getState().items[0]).toMatchObject({
        kind: "split",
        left: { kind: "tab", ref: { kind: "epic" } },
        right: { kind: "tab", ref: refB },
        focusedSide: "left",
      });
    });
    expect(landingMocks.navigate).not.toHaveBeenCalled();
    queryClient.clear();
  });

  it("replaces a moved draft in its current split side without disturbing its partner or focus", async () => {
    const draftA = useLandingDraftStore
      .getState()
      .createDraftWithId("draft-move-a", null);
    const draftB = useLandingDraftStore
      .getState()
      .createDraftWithId("draft-move-b", null);
    const refA = { kind: "draft" as const, id: draftA };
    const refB = { kind: "draft" as const, id: draftB };
    useTabsStore.setState({
      items: [splitItem("move-split", refA, refB, "left")],
      activeItemId: "move-split",
      systemTabs: { history: null, settings: null },
      stripOrder: [refA, refB],
    });
    const createGate = deferred<unknown>();
    landingMocks.request.mockImplementation((method) =>
      method === "epic.create" ? createGate.promise : Promise.resolve({}),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      {
        wrapper: queryClientWrapper(queryClient),
      },
    );

    act(() => {
      result.current.submit({
        draftId: draftA,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });
    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some(
          (call) => call[0] === "epic.create",
        ),
      ).toBe(true);
    });
    useTabsStore.setState({
      items: [splitItem("move-split", refB, refA, "right")],
      activeItemId: "move-split",
      systemTabs: { history: null, settings: null },
      stripOrder: [refB, refA],
    });

    createGate.resolve({ roomInfo: null });
    await waitFor(() => {
      expect(useTabsStore.getState().items[0]).toMatchObject({
        kind: "split",
        id: "move-split",
        left: { kind: "tab", ref: refB },
        right: { kind: "tab", ref: { kind: "epic" } },
        focusedSide: "right",
        routeBackingSide: "right",
      });
    });
    expect(useTabsStore.getState().stripOrder).toEqual([
      refB,
      expect.objectContaining({ kind: "epic" }),
    ]);
    expect(landingMocks.navigate).toHaveBeenCalledTimes(1);
    queryClient.clear();
  });

  it("settles simultaneous exact-draft submissions in their own split members and preserves newer focus", async () => {
    const draftA = useLandingDraftStore
      .getState()
      .createDraftWithId("draft-dual-a", null);
    const draftB = useLandingDraftStore
      .getState()
      .createDraftWithId("draft-dual-b", null);
    const refA = { kind: "draft" as const, id: draftA };
    const refB = { kind: "draft" as const, id: draftB };
    useTabsStore.setState({
      items: [splitItem("dual-split", refA, refB, "left")],
      activeItemId: "dual-split",
      systemTabs: { history: null, settings: null },
      stripOrder: [refA, refB],
    });
    const firstCreate = deferred<unknown>();
    const secondCreate = deferred<unknown>();
    let createCount = 0;
    landingMocks.request.mockImplementation((method) => {
      if (method !== "epic.create") return Promise.resolve({});
      createCount += 1;
      return createCount === 1 ? firstCreate.promise : secondCreate.promise;
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      {
        wrapper: queryClientWrapper(queryClient),
      },
    );

    act(() => {
      result.current.submit({
        draftId: draftA,
        editor: editorHandleForPrompt("submit A"),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });
    await waitFor(() => expect(createCount).toBe(1));
    useTabsStore.setState({
      items: [splitItem("dual-split", refA, refB, "right")],
      activeItemId: "dual-split",
      systemTabs: { history: null, settings: null },
      stripOrder: [refA, refB],
    });
    act(() => {
      result.current.submit({
        draftId: draftB,
        editor: editorHandleForPrompt("submit B"),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });
    await waitFor(() => expect(createCount).toBe(2));

    firstCreate.resolve({ roomInfo: null });
    secondCreate.resolve({ roomInfo: null });
    await waitFor(() => {
      expect(useTabsStore.getState().items[0]).toMatchObject({
        kind: "split",
        left: { kind: "tab", ref: { kind: "epic" } },
        right: { kind: "tab", ref: { kind: "epic" } },
        focusedSide: "right",
      });
    });
    expect(useTabsStore.getState().activeItemId).toBe("dual-split");
    expect(landingMocks.navigate).toHaveBeenCalledTimes(1);
    queryClient.clear();
  });

  it("uses the caller's terminal-agent draft in an A/B split, not the active sibling", async () => {
    setWorkspace("/tmp/terminal-a", "terminal-a");
    const draftA = useLandingDraftStore
      .getState()
      .createDraftWithId("terminal-a", null);
    setWorkspace("/tmp/terminal-b", "terminal-b");
    const draftB = useLandingDraftStore
      .getState()
      .createDraftWithId("terminal-b", null);
    const refA = { kind: "draft" as const, id: draftA };
    const refB = { kind: "draft" as const, id: draftB };
    useTabsStore.setState({
      items: [splitItem("terminal-split", refA, refB, "right")],
      activeItemId: "terminal-split",
      systemTabs: { history: null, settings: null },
      stripOrder: [refA, refB],
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      {
        wrapper: queryClientWrapper(queryClient),
      },
    );

    act(() => {
      result.current.selectTerminalAgent(
        {
          harnessId: "claude",
          model: null,
          reasoningEffort: null,
          terminalAgentArgs: "",
          profileId: null,
        },
        draftA,
      );
    });
    await waitFor(() => {
      expect(landingMocks.createTerminalAgent).toHaveBeenCalledTimes(1);
    });
    const createCall = landingMocks.request.mock.calls.find(
      (call) => call[0] === "epic.create",
    );
    expect(createCall?.[1]).toMatchObject({
      workspaces: [{ workspacePath: "/tmp/terminal-a" }],
    });
    expect(JSON.stringify(createCall?.[1])).not.toContain("/tmp/terminal-b");
    expect(useTabsStore.getState().items[0]).toMatchObject({
      kind: "split",
      left: { kind: "tab", ref: { kind: "epic" } },
      right: { kind: "tab", ref: refB },
    });
    queryClient.clear();
  });

  it("retains a staged intent when image preparation aborts before create", async () => {
    setSingleWorkspace();
    const stagingKey = {
      surface: "landing" as const,
      hostId: TEST_HOST_ID,
      draftId: null,
    };
    const stagedIntent = worktreeIntentFor(WORKSPACE_PATH, "retry-precreate");
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(stagingKey, stagedIntent);
    imageStoreMocks.sessionImageBytes.mockReturnValue(null);
    const imageGate = deferred<Uint8Array | undefined>();
    imageStoreMocks.getImageBytes.mockReturnValue(imageGate.promise);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      {
        wrapper: queryClientWrapper(queryClient),
      },
    );

    act(() => {
      result.current.submit({
        draftId: null,
        editor: editorHandleForHashImage("retry-image", "retry"),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });
    await waitFor(() => {
      expect(useLandingDraftStore.getState().activeDraftId).not.toBeNull();
    });
    const draftId = useLandingDraftStore.getState().activeDraftId;
    if (draftId === null) throw new Error("expected generated draft");
    draftRuntimeRegistry.close(draftId);
    imageGate.resolve(HELLO_BYTES);
    await act(async () => {
      await Promise.resolve();
    });
    expect(landingMocks.request).not.toHaveBeenCalled();
    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString({
          surface: "landing",
          hostId: TEST_HOST_ID,
          draftId: null,
        })
      ],
    ).toEqual(stagedIntent);
    queryClient.clear();
  });

  it("retains a staged intent when the one-shot create rejects", async () => {
    setSingleWorkspace();
    const stagingKey = {
      surface: "landing" as const,
      hostId: TEST_HOST_ID,
      draftId: null,
    };
    const stagedIntent = worktreeIntentFor(WORKSPACE_PATH, "retry-reject");
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(stagingKey, stagedIntent);
    landingMocks.request.mockRejectedValue(new Error("create rejected"));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      {
        wrapper: queryClientWrapper(queryClient),
      },
    );

    act(() => {
      result.current.submit({
        draftId: null,
        editor: editorHandleForPrompt("retry create"),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });
    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some(
          (call) => call[0] === "epic.create",
        ),
      ).toBe(true);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString({
          surface: "landing",
          hostId: TEST_HOST_ID,
          draftId: null,
        })
      ],
    ).toEqual(stagedIntent);
    queryClient.clear();
  });

  it("retains a staged intent and opens nothing when the create is REFUSED", async () => {
    // The third member of the retain-for-retry class above, and the one the
    // other two cannot stand in for: a refusal RESOLVES. `epic.create@1.1`
    // carries it as an optional key on an ordinary response, so the fulfilled
    // continuation runs for a create that did not happen - and everything in
    // it is staged on the assumption that the epic exists.
    setSingleWorkspace();
    const stagingKey = {
      surface: "landing" as const,
      hostId: TEST_HOST_ID,
      draftId: null,
    };
    const stagedIntent = worktreeIntentFor(WORKSPACE_PATH, "retry-refused");
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(stagingKey, stagedIntent);
    landingMocks.request.mockImplementation((method) =>
      method === "epic.create"
        ? Promise.resolve({
            roomInfo: null,
            refusal: {
              kind: "local-store-unavailable",
              message: "Traycer can't open this device's local store.",
              remedy: "Quit the other Traycer on this machine, then rebind.",
            },
          })
        : Promise.resolve({}),
    );
    // `gcTime: Infinity` for the same reason as the accepted-create control
    // below: under the shared `gcTime: 0` the observer-less seed is collected
    // the moment it is written, so the rollback assertion at the end of this
    // test would read `undefined` whether or not a rollback happened. It did
    // exactly that on first run, and only the control caught it.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      {
        wrapper: queryClientWrapper(queryClient),
      },
    );

    act(() => {
      result.current.submit({
        draftId: null,
        editor: editorHandleForPrompt("refused create"),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });
    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some(
          (call) => call[0] === "epic.create",
        ),
      ).toBe(true);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // The retry must see the exact intent the user staged.
    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(stagingKey)
      ],
    ).toEqual(stagedIntent);
    // And the optimistic binding seed is ROLLED BACK. This is the third
    // continuation on the create promise - the one inside `createLandingEpic`
    // itself, which runs before either call site's - and its rollback lived
    // only in `.catch`, which a resolving refusal never reaches. Left seeded,
    // the in-epic chip and the palette's Files/Diff openers would list folders
    // for an epic id the host never created.
    expect(
      queryClient.getQueryData(
        hostQueryKeys.method(TEST_HOST_ID, "worktree.listBindingsForEpic", {
          epicId: createdEpicIdFromRequests(),
        }),
      ),
    ).toBeUndefined();
    // And nothing was opened or navigated to. In this flow the tile open and
    // the navigation both live INSIDE the fulfilled continuation, so a missing
    // refusal branch would land the user on an epic route whose
    // `epic.subscribe` then fails - a second, unrelated-looking error for one
    // refusal.
    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]);
    expect(landingMocks.navigate).not.toHaveBeenCalled();
    // The initial-chat handoff registered at submit time must not outlive
    // the epic it names: a REFUSED create now settles it to `failed` instead
    // of leaving it `pending` forever.
    const refusedEpicId = createdEpicIdFromRequests();
    const handoffAfterRefusal = Object.values(
      useInitialChatHandoffStore.getState().handoffs,
    )[0];
    expect(handoffAfterRefusal.status).toBe("failed");
    expect(handoffAfterRefusal.failureReason).toBe("Couldn't create the epic.");
    expect(
      selectHasActiveInitialChatHandoffForEpic(
        useInitialChatHandoffStore.getState(),
        refusedEpicId,
      ),
    ).toBe(false);
    queryClient.clear();
  });

  it("keeps the optimistic binding seed when the create is ACCEPTED", async () => {
    // The positive control for the rollback above, and it is load-bearing:
    // `toBeUndefined()` passes just as well if the seed is never written - if
    // the staged folders did not reach `buildOptimisticWorkspaceBindingRows`,
    // or the key is built differently than this test builds it. This row
    // proves the key and the seed are real, so the other row's absence is a
    // rollback rather than a miss.
    setSingleWorkspace();
    landingMocks.request.mockImplementation((method) =>
      method === "epic.create"
        ? Promise.resolve({ roomInfo: null })
        : Promise.resolve({}),
    );
    // `gcTime: Infinity`, unlike every other case in this file. The seed is a
    // `setQueryData` with no observer in this harness - no epic route is
    // mounted to subscribe to it - and under the shared `gcTime: 0` such an
    // entry is collected the instant it is written. Reading it back would then
    // answer `undefined` whether or not the rollback ran, which is exactly how
    // the refusal assertion below first passed while proving nothing.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      {
        wrapper: queryClientWrapper(queryClient),
      },
    );

    act(() => {
      result.current.submit({
        draftId: null,
        editor: editorHandleForPrompt("accepted create"),
        slashCatalog: null,
        toolbar: defaultToolbar(),
      });
    });
    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some(
          (call) => call[0] === "epic.create",
        ),
      ).toBe(true);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      queryClient.getQueryData(
        hostQueryKeys.method(TEST_HOST_ID, "worktree.listBindingsForEpic", {
          epicId: createdEpicIdFromRequests(),
        }),
      ),
    ).toEqual({
      rows: [expect.objectContaining({ workspacePath: WORKSPACE_PATH })],
    });
    queryClient.clear();
  });

  it("does not chain the terminal agent onto a REFUSED create", async () => {
    // The terminal-agent flow is the dangerous half: it navigates and opens
    // its placeholder tile BEFORE the round-trip, so the refusal cannot undo
    // the navigation - what it must prevent is the CHAINED
    // `agent.tui.prepareLaunch` / `epic.createTuiAgent` against an epic that
    // does not exist, whose own error toast would report the refusal twice in
    // two unrelated vocabularies. The marker is dropped so the existence
    // reconciler prunes the orphan tab, exactly as on the rejection arm.
    landingMocks.request.mockImplementation((method) =>
      method === "epic.create"
        ? Promise.resolve({
            roomInfo: null,
            refusal: {
              kind: "local-store-unavailable",
              message: "Traycer can't open this device's local store.",
              remedy: "Quit the other Traycer on this machine, then rebind.",
            },
          })
        : Promise.resolve({}),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      {
        wrapper: queryClientWrapper(queryClient),
      },
    );

    act(() => {
      result.current.selectTerminalAgent(
        {
          harnessId: "claude",
          model: null,
          reasoningEffort: null,
          terminalAgentArgs: "",
          profileId: null,
        },
        null,
      );
    });
    await waitFor(() => {
      expect(
        landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
      ).toBe(true);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(landingMocks.createTerminalAgent).not.toHaveBeenCalled();
    const createCall = landingMocks.request.mock.calls.find(
      (c) => c[0] === "epic.create",
    );
    const refusedEpicId = (
      createCall?.[1] as { readonly epic: { readonly id: string } } | undefined
    )?.epic.id;
    // Read from the payload rather than asserted against a literal: the id is
    // generated, and a `toBe(false)` on an id that was never marked would pass
    // for the wrong reason.
    expect(typeof refusedEpicId).toBe("string");
    expect(wasEpicCreatedThisSession(refusedEpicId ?? "")).toBe(false);
    queryClient.clear();
  });

  /**
   * `isPending`, the field `landing-composer.tsx`'s `isSubmitting` now reads
   * (`runtimeState.isSubmitting || actions.isPending`). Before that change
   * the composer built its OWN `useEpicCreateForClient` /
   * `useCreateTuiAgentForClient` pair and read `isPending` off THOSE - two
   * observers nobody ever called `.mutate()` on, so the read was permanently
   * `false` no matter what a create in flight was actually doing. These pins
   * are on the hook that now backs it, exercising the REAL
   * `useEpicCreateForClient(target.client)` mutation this suite's harness
   * already wires (a deferred `landingMocks.request`, not a mocked
   * `isPending`), so a regression back to a second, uncalled observer would
   * fail this rather than pass silently the way it did before.
   */
  describe("isPending", () => {
    it("is false before any submit", () => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      const { result } = renderHook(
        () => useLandingComposerActions(useTestPlacementTarget()),
        { wrapper: queryClientWrapper(queryClient) },
      );

      expect(result.current.isPending).toBe(false);
      queryClient.clear();
    });

    it("goes true while epic.create is in flight, and false again once it settles", async () => {
      const createGate = deferred<unknown>();
      landingMocks.request.mockImplementation((method) =>
        method === "epic.create" ? createGate.promise : Promise.resolve({}),
      );
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      const { result } = renderHook(
        () => useLandingComposerActions(useTestPlacementTarget()),
        { wrapper: queryClientWrapper(queryClient) },
      );
      expect(result.current.isPending).toBe(false);

      act(() => {
        result.current.submit({
          draftId: null,
          editor: editorHandleForPrompt(SUBMITTED_PROMPT),
          slashCatalog: null,
          toolbar: defaultToolbar(),
        });
      });

      await waitFor(() => {
        expect(
          landingMocks.request.mock.calls.some(
            (call) => call[0] === "epic.create",
          ),
        ).toBe(true);
      });
      await waitFor(() => {
        expect(result.current.isPending).toBe(true);
      });

      createGate.resolve({ roomInfo: null });

      await waitFor(() => {
        expect(result.current.isPending).toBe(false);
      });
      queryClient.clear();
    });

    it("goes false again after epic.create REJECTS - a failed create must not strand the composer disabled", async () => {
      const createGate = deferred<unknown>();
      landingMocks.request.mockImplementation((method) =>
        method === "epic.create" ? createGate.promise : Promise.resolve({}),
      );
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      const { result } = renderHook(
        () => useLandingComposerActions(useTestPlacementTarget()),
        { wrapper: queryClientWrapper(queryClient) },
      );

      act(() => {
        result.current.submit({
          draftId: null,
          editor: editorHandleForPrompt(SUBMITTED_PROMPT),
          slashCatalog: null,
          toolbar: defaultToolbar(),
        });
      });
      await waitFor(() => {
        expect(result.current.isPending).toBe(true);
      });

      createGate.reject(new Error("create rejected"));

      await waitFor(() => {
        expect(result.current.isPending).toBe(false);
      });
      queryClient.clear();
    });
  });

  // `markEpicCreatedThisSession` fires once before `epic.create` (for the
  // existence reconciler) and again in each flow's SUCCESS handler, to
  // re-anchor `CREATE_RACE_WINDOW_MS` (2 minutes) on COMPLETION rather than on
  // the request. `epic.create` can legitimately hold a 30s host RPC deadline
  // (longer under retry), so anchoring on the request alone would let a slow
  // create hand an already-expired seed to the session that opens right after
  // it - reintroducing the exact NOT_FOUND race this marker exists to
  // prevent. `Date` is faked (not the timer queue) so the clock is fully
  // controllable while `waitFor`'s own real-timer polling - and every
  // TanStack Query internal `setTimeout(0)` hop the mutation pipeline relies
  // on - keeps working unmodified.
  describe("create-race window re-anchoring on completion", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("keeps the create-race window open 90s after a GUI-chat create resolves, even though the request itself took 60s", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      setSingleWorkspace();
      const createGate = deferred<unknown>();
      landingMocks.request.mockImplementation((method) =>
        method === "epic.create" ? createGate.promise : Promise.resolve({}),
      );
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      const { result } = renderHook(
        () => useLandingComposerActions(useTestPlacementTarget()),
        { wrapper: queryClientWrapper(queryClient) },
      );

      act(() => {
        result.current.submit({
          draftId: null,
          editor: editorHandleForPrompt(SUBMITTED_PROMPT),
          slashCatalog: null,
          toolbar: defaultToolbar(),
        });
      });

      await waitFor(() => {
        expect(
          landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
        ).toBe(true);
      });
      const createEpicCall = landingMocks.request.mock.calls.find(
        (c) => c[0] === "epic.create",
      );
      const epicId = epicIdFromCreateEpicPayload(createEpicCall?.[1]);
      if (epicId === null) throw new Error("expected an epic id");

      // The request is still pending - advance 60s before it resolves.
      vi.advanceTimersByTime(60_000);

      await act(async () => {
        createGate.resolve({ roomInfo: null });
        await createGate.promise;
      });
      await waitFor(() => {
        expect(useEpicCanvasStore.getState().openTabOrder).toHaveLength(1);
      });

      // 90s after completion - 150s after the request, past the 2-minute
      // window if it were still anchored there. Only the success handler's
      // re-anchor keeps this seed alive.
      vi.advanceTimersByTime(90_000);

      expect(sessionCreatedEpicHostId(epicId)).toBe(TEST_HOST_ID);
      expect(wasEpicCreatedRecentlyThisSession(epicId)).toBe(true);

      queryClient.clear();
    });

    it("keeps the create-race window open 90s after a terminal-agent create resolves, even though the request itself took 60s", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const createGate = deferred<unknown>();
      landingMocks.request.mockImplementation((method) =>
        method === "epic.create" ? createGate.promise : Promise.resolve({}),
      );
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      const { result } = renderHook(
        () => useLandingComposerActions(useTestPlacementTarget()),
        { wrapper: queryClientWrapper(queryClient) },
      );

      act(() => {
        result.current.selectTerminalAgent(
          {
            harnessId: "claude",
            model: null,
            reasoningEffort: null,
            terminalAgentArgs: "",
            profileId: null,
          },
          null,
        );
      });

      await waitFor(() => {
        expect(
          landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
        ).toBe(true);
      });
      const createEpicCall = landingMocks.request.mock.calls.find(
        (c) => c[0] === "epic.create",
      );
      const epicId = epicIdFromCreateEpicPayload(createEpicCall?.[1]);
      if (epicId === null) throw new Error("expected an epic id");

      // The request is still pending - advance 60s before it resolves.
      vi.advanceTimersByTime(60_000);

      await act(async () => {
        createGate.resolve({ roomInfo: null });
        await createGate.promise;
      });
      await waitFor(() => {
        expect(landingMocks.createTerminalAgent).toHaveBeenCalledTimes(1);
      });

      // 90s after completion - 150s after the request, past the 2-minute
      // window if it were still anchored there. Only the success handler's
      // re-anchor keeps this seed alive.
      vi.advanceTimersByTime(90_000);

      expect(sessionCreatedEpicHostId(epicId)).toBe(TEST_HOST_ID);
      expect(wasEpicCreatedRecentlyThisSession(epicId)).toBe(true);

      queryClient.clear();
    });

    it("does not restore the create marker when the identity changed while the create was in flight", async () => {
      useAuthStore.getState().setSignedIn(
        {
          userId: "user-initial",
          userName: "Initial User",
          email: "initial@example.com",
        },
        { userId: "user-initial", username: "initial" },
        [],
      );
      const createGate = deferred<unknown>();
      landingMocks.request.mockImplementation((method) =>
        method === "epic.create" ? createGate.promise : Promise.resolve({}),
      );
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      const { result } = renderHook(
        () => useLandingComposerActions(useTestPlacementTarget()),
        { wrapper: queryClientWrapper(queryClient) },
      );

      act(() => {
        result.current.selectTerminalAgent(
          {
            harnessId: "claude",
            model: null,
            reasoningEffort: null,
            terminalAgentArgs: "",
            profileId: null,
          },
          null,
        );
      });

      await waitFor(() => {
        expect(
          landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
        ).toBe(true);
      });
      const createEpicCall = landingMocks.request.mock.calls.find(
        (c) => c[0] === "epic.create",
      );
      const epicId = epicIdFromCreateEpicPayload(createEpicCall?.[1]);
      if (epicId === null) throw new Error("expected an epic id");

      // The identity transition `auth-lifecycle-bridge` performs on
      // sign-out / user-switch: swap in a DIFFERENT user and clear the
      // session-created-epics markers, while the create is still in flight.
      useAuthStore.getState().setSignedIn(
        {
          userId: "user-different",
          userName: "Different User",
          email: "different@example.com",
        },
        { userId: "user-different", username: "different" },
        [],
      );
      clearSessionCreatedEpics();

      await act(async () => {
        createGate.resolve({ roomInfo: null });
        await createGate.promise;
      });
      await waitFor(() => {
        expect(landingMocks.createTerminalAgent).toHaveBeenCalledTimes(1);
      });

      // The completion re-anchor must not restore the marker for the
      // OUTGOING account: the dispatching identity no longer matches the
      // identity live at completion.
      expect(sessionCreatedEpicHostId(epicId)).toBeNull();
      expect(wasEpicCreatedThisSession(epicId)).toBe(false);

      useAuthStore.getState().setSignedOut();
      queryClient.clear();
    });
  });

  describe("deferWorktreeProvisioning opt-in", () => {
    it("a plain local-folder create on a 1.2 host ships no deferWorktreeProvisioning key and marks seedRows only", async () => {
      setSingleWorkspace();
      recordNegotiatedHostManifest(TEST_HOST_ID, {
        "epic.create": { major: 1, minor: 2 },
      });
      const createGate = deferred<unknown>();
      landingMocks.request.mockImplementation((method) =>
        method === "epic.create" ? createGate.promise : Promise.resolve({}),
      );
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      const { result } = renderHook(
        () => useLandingComposerActions(useTestPlacementTarget()),
        { wrapper: queryClientWrapper(queryClient) },
      );

      act(() => {
        result.current.submit({
          draftId: null,
          editor: editorHandleForPrompt(SUBMITTED_PROMPT),
          slashCatalog: null,
          toolbar: defaultToolbar(),
        });
      });
      await waitFor(() => {
        expect(
          landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
        ).toBe(true);
      });
      const payload = landingMocks.request.mock.calls.find(
        (c) => c[0] === "epic.create",
      )?.[1];
      expect(deferWorktreeProvisioningFromCreateEpicPayload(payload)).toBe(
        "absent",
      );
      const epicId = epicIdFromCreateEpicPayload(payload);
      const chatId = foldedChatIdFromCreateEpicPayload(payload);
      if (epicId === null || chatId === null) {
        throw new Error("expected epic and chat ids");
      }
      expect(readEpicCreateSeed(epicId, chatId)).toMatchObject({
        seedRows: true,
        heldForDeferredCreate: false,
      });

      createGate.resolve({ roomInfo: null });
      clearEpicCreateSeedPending(epicId, chatId);
      queryClient.clear();
    });

    it("a worktree-intent create on a 1.2 host ships true and marks held", async () => {
      setSingleWorkspace();
      recordNegotiatedHostManifest(TEST_HOST_ID, {
        "epic.create": { major: 1, minor: 2 },
      });
      useWorktreeIntentStagingStore.getState().setIntent(
        { surface: "landing", hostId: TEST_HOST_ID, draftId: null },
        {
          entries: [
            {
              kind: "worktree",
              scripts: null,
              workspacePath: WORKSPACE_PATH,
              repoIdentifier: null,
              isPrimary: true,
              branch: {
                type: "new",
                name: "feat-defer",
                source: "main",
                carryUncommittedChanges: false,
              },
            },
          ],
        },
      );
      const createGate = deferred<unknown>();
      landingMocks.request.mockImplementation((method) =>
        method === "epic.create" ? createGate.promise : Promise.resolve({}),
      );
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      const { result } = renderHook(
        () => useLandingComposerActions(useTestPlacementTarget()),
        { wrapper: queryClientWrapper(queryClient) },
      );

      act(() => {
        result.current.submit({
          draftId: null,
          editor: editorHandleForPrompt(SUBMITTED_PROMPT),
          slashCatalog: null,
          toolbar: defaultToolbar(),
        });
      });
      await waitFor(() => {
        expect(
          landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
        ).toBe(true);
      });
      const payload = landingMocks.request.mock.calls.find(
        (c) => c[0] === "epic.create",
      )?.[1];
      expect(deferWorktreeProvisioningFromCreateEpicPayload(payload)).toBe(
        true,
      );
      const epicId = epicIdFromCreateEpicPayload(payload);
      const chatId = foldedChatIdFromCreateEpicPayload(payload);
      if (epicId === null || chatId === null) {
        throw new Error("expected epic and chat ids");
      }
      expect(readEpicCreateSeed(epicId, chatId)).toMatchObject({
        seedRows: true,
        heldForDeferredCreate: true,
      });

      createGate.resolve({ roomInfo: null });
      clearEpicCreateSeedPending(epicId, chatId);
      queryClient.clear();
    });

    it("a null negotiated read ships no deferWorktreeProvisioning key", async () => {
      setSingleWorkspace();
      useWorktreeIntentStagingStore.getState().setIntent(
        { surface: "landing", hostId: TEST_HOST_ID, draftId: null },
        {
          entries: [
            {
              kind: "worktree",
              scripts: null,
              workspacePath: WORKSPACE_PATH,
              repoIdentifier: null,
              isPrimary: true,
              branch: {
                type: "new",
                name: "feat-no-handshake",
                source: "main",
                carryUncommittedChanges: false,
              },
            },
          ],
        },
      );
      const createGate = deferred<unknown>();
      landingMocks.request.mockImplementation((method) =>
        method === "epic.create" ? createGate.promise : Promise.resolve({}),
      );
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      const { result } = renderHook(
        () => useLandingComposerActions(useTestPlacementTarget()),
        { wrapper: queryClientWrapper(queryClient) },
      );

      act(() => {
        result.current.submit({
          draftId: null,
          editor: editorHandleForPrompt(SUBMITTED_PROMPT),
          slashCatalog: null,
          toolbar: defaultToolbar(),
        });
      });
      await waitFor(() => {
        expect(
          landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
        ).toBe(true);
      });
      const payload = landingMocks.request.mock.calls.find(
        (c) => c[0] === "epic.create",
      )?.[1];
      expect(deferWorktreeProvisioningFromCreateEpicPayload(payload)).toBe(
        "absent",
      );
      const epicId = epicIdFromCreateEpicPayload(payload);
      const chatId = foldedChatIdFromCreateEpicPayload(payload);
      if (epicId === null || chatId === null) {
        throw new Error("expected epic and chat ids");
      }
      expect(readEpicCreateSeed(epicId, chatId)?.heldForDeferredCreate).toBe(
        false,
      );

      createGate.resolve({ roomInfo: null });
      clearEpicCreateSeedPending(epicId, chatId);
      queryClient.clear();
    });
  });

  describe("recovered-success hold lifecycle (B3-3)", () => {
    afterEach(() => {
      vi.useRealTimers();
      pollMocks.pollEpicExistence.mockReset();
      pollMocks.pollEpicExistence.mockResolvedValue("unknown");
    });

    it("restores the binding seed and arms the backstop when a lost response's create actually landed", async () => {
      // The ambiguous post-send drop `createOutcomeIsDecidable` accepts -
      // checked directly here so the rest of this test is built on a real
      // classification of the fixture error, not an assumption about what
      // "ambiguous" means.
      const ambiguousDrop = new HostTransportFailureError({
        code: "RPC_ERROR",
        message: "WebSocket closed before next frame",
        requestId: "req-drop",
        method: "epic.create",
        fatalDetails: null,
      });
      expect(createOutcomeIsDecidable(ambiguousDrop)).toBe(true);

      setSingleWorkspace();
      landingMocks.request.mockImplementation((method) =>
        method === "epic.create"
          ? Promise.reject(ambiguousDrop)
          : Promise.resolve({}),
      );
      pollMocks.pollEpicExistence.mockResolvedValue("exists");

      // `gcTime: Infinity` - see the accepted-create control above: an
      // observer-less seed under the shared `gcTime: 0` is collected the
      // instant it is written, and reading it back would answer `undefined`
      // whether or not the restore ran.
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: Infinity } },
      });

      // Fake timers from BEFORE submit, and for the whole test: the backstop
      // this case has to prove is armed by a REAL `window.setTimeout` call
      // made inside the recovery closure, and timers faked only after that
      // call would never see it - advancing them later would do nothing.
      // Nothing between submit and the recovery closure running needs a
      // timer of its own (the rejection and the mocked poll are both plain
      // microtasks), so installing this early costs nothing.
      vi.useFakeTimers();

      const { result } = renderHook(
        () => useLandingComposerActions(useTestPlacementTarget()),
        { wrapper: queryClientWrapper(queryClient) },
      );

      act(() => {
        result.current.submit({
          draftId: null,
          editor: editorHandleForPrompt("recovered success"),
          slashCatalog: null,
          toolbar: defaultToolbar(),
        });
      });

      // Drain the promise chain to its end: the rejection, the decidability
      // check, the mocked poll's resolution and the recovery closure it
      // runs - all plain microtasks, so no `waitFor`/real-interval polling
      // is used here. This suite installs no `jest` global, so `waitFor`
      // never recognizes fake timers as active and would schedule its own
      // polling `setInterval` as a FAKE one that nothing is advancing -
      // exactly the hang this drain avoids.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      const payload = landingMocks.request.mock.calls.find(
        (c) => c[0] === "epic.create",
      )?.[1];
      const epicId = epicIdFromCreateEpicPayload(payload);
      const chatId = foldedChatIdFromCreateEpicPayload(payload);
      if (epicId === null || chatId === null) {
        throw new Error("expected epic and chat ids");
      }

      // (a) the entry is back, and matches the submit-time entry -
      // `heldForDeferredCreate` especially: a recovery that re-registered
      // with the wrong value would hand a deferred create's epic to the
      // first refetch that asked.
      expect(readEpicCreateSeed(epicId, chatId)).toMatchObject({
        hostId: TEST_HOST_ID,
        seedRows: true,
        heldForDeferredCreate: false,
      });

      // (b) the seeded bindings query data is back.
      expect(
        queryClient.getQueryData(
          hostQueryKeys.method(TEST_HOST_ID, "worktree.listBindingsForEpic", {
            epicId,
          }),
        ),
      ).toEqual({
        rows: [expect.objectContaining({ workspacePath: WORKSPACE_PATH })],
      });

      // (c) the backstop is ARMED - proved by its effect, not by a spy:
      // advance past its ceiling and the entry must be gone.
      act(() => {
        vi.advanceTimersByTime(EPIC_CREATE_SEED_HOLD_TIMEOUT_MS);
      });
      expect(readEpicCreateSeed(epicId, chatId)).toBeNull();

      queryClient.clear();
    });
  });

  describe("missing-attachment-bytes refusal retry survives the seed (B3-7)", () => {
    // Held, not unheld: an UNHELD entry is cleared by the success arm's own
    // `clearUnheldEpicCreateSeed` the moment the create accepts, which would
    // make "the seed survives" true whether or not the retry behaved - a
    // worktree intent (`heldForDeferredCreate: true`) is what keeps the
    // entry alive past a plain success, so its survival here is evidence
    // about the REFUSAL never reaching the teardown, not about the create
    // having merely succeeded.
    it("the seed and its seeded bindings survive a first refusal the retry then succeeds past", async () => {
      setSingleWorkspace();
      recordNegotiatedHostManifest(TEST_HOST_ID, {
        "epic.create": { major: 1, minor: 2 },
      });
      useWorktreeIntentStagingStore.getState().setIntent(
        { surface: "landing", hostId: TEST_HOST_ID, draftId: null },
        {
          entries: [
            {
              kind: "worktree",
              scripts: null,
              workspacePath: WORKSPACE_PATH,
              repoIdentifier: null,
              isPrimary: true,
              branch: {
                type: "new",
                name: "feat-mab-retry",
                source: "main",
                carryUncommittedChanges: false,
              },
            },
          ],
        },
      );
      const hash = "hash-mab-retry";
      imageStoreMocks.getImageBytes.mockResolvedValue(HELLO_BYTES);
      let epicCreateCalls = 0;
      landingMocks.request.mockImplementation((method) => {
        if (method === "drafts.putBlob") {
          return Promise.resolve({ ok: true });
        }
        if (method === "epic.create") {
          const call = epicCreateCalls;
          epicCreateCalls += 1;
          return Promise.resolve(
            call === 0
              ? {
                  roomInfo: null,
                  refusal: {
                    kind: "missing-attachment-bytes",
                    message:
                      "Traycer couldn't find the bytes for one of these images.",
                    remedy: "Re-upload the image and try again.",
                  },
                }
              : { roomInfo: null, initialTurnStarted: true },
          );
        }
        return Promise.resolve({});
      });
      // `gcTime: Infinity` - same reason as the recovered-success control
      // above: an observer-less seed under the shared `gcTime: 0` is
      // collected the instant it is written.
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: Infinity } },
      });
      const { result } = renderHook(
        () => useLandingComposerActions(useTestPlacementTarget()),
        { wrapper: queryClientWrapper(queryClient) },
      );

      act(() => {
        result.current.submit({
          draftId: null,
          editor: editorHandleForByHashImage(hash, "retry past a refusal"),
          slashCatalog: null,
          toolbar: defaultToolbar(),
        });
      });

      // Both the refusal AND the retry's redispatch happened under this one
      // `submit()` - proof the retry actually ran, not just that the create
      // eventually succeeded some other way.
      await waitFor(() => {
        expect(
          landingMocks.request.mock.calls.filter((c) => c[0] === "epic.create"),
        ).toHaveLength(2);
      });
      // The re-upload the refusal's remedy drives - a second `drafts.putBlob`
      // for the same hash, since the retry bypasses the confirmed-blob memo
      // on purpose.
      await waitFor(() => {
        expect(
          landingMocks.request.mock.calls.filter(
            (c) => c[0] === "drafts.putBlob",
          ),
        ).toHaveLength(2);
      });

      const finalCall = landingMocks.request.mock.calls
        .filter((c) => c[0] === "epic.create")
        .at(-1);
      const epicId = epicIdFromCreateEpicPayload(finalCall?.[1]);
      const chatId = foldedChatIdFromCreateEpicPayload(finalCall?.[1]);
      if (epicId === null || chatId === null) {
        throw new Error("expected epic and chat ids");
      }

      await waitFor(() => {
        expect(readEpicCreateSeed(epicId, chatId)).not.toBeNull();
      });
      // The intervening refusal never reached `createLandingEpic`'s own
      // `.then` - which would have torn this down UNCONDITIONALLY, held or
      // not - because only the mutation's FINAL, already-retried response
      // ever reaches it.
      expect(readEpicCreateSeed(epicId, chatId)).toMatchObject({
        hostId: TEST_HOST_ID,
        heldForDeferredCreate: true,
      });
      expect(
        queryClient.getQueryData(
          hostQueryKeys.method(TEST_HOST_ID, "worktree.listBindingsForEpic", {
            epicId,
          }),
        ),
      ).toEqual({
        rows: [expect.objectContaining({ workspacePath: WORKSPACE_PATH })],
      });

      clearEpicCreateSeedPending(epicId, chatId);
      queryClient.clear();
    });
  });

  describe("attachments by hash - the landing composer's gate", () => {
    it("uploads an eligible hash then ships a hash-only create on a @1.2 host", async () => {
      setSingleWorkspace();
      recordNegotiatedHostManifest(TEST_HOST_ID, {
        "epic.create": { major: 1, minor: 2 },
      });
      imageStoreMocks.getImageBytes.mockResolvedValue(HELLO_BYTES);
      landingMocks.request.mockImplementation((method) =>
        method === "drafts.putBlob"
          ? Promise.resolve({ ok: true })
          : Promise.resolve({ roomInfo: null }),
      );
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      const { result } = renderHook(
        () => useLandingComposerActions(useTestPlacementTarget()),
        { wrapper: queryClientWrapper(queryClient) },
      );

      act(() => {
        result.current.submit({
          draftId: null,
          editor: editorHandleForByHashImage("hash-eligible-1", "by hash"),
          slashCatalog: null,
          toolbar: defaultToolbar(),
        });
      });

      await waitFor(() => {
        expect(
          landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
        ).toBe(true);
      });
      // Positive control: the upload actually happened, keyed on the blob's
      // own digest, before the create - not a document that silently took the
      // inline arm and passed while proving nothing.
      const putBlobCall = landingMocks.dispatchOptions.find(
        (c) => c.method === "drafts.putBlob",
      );
      if (putBlobCall === undefined) {
        throw new Error("expected a drafts.putBlob dispatch");
      }
      expect(putBlobCall.options).toMatchObject({
        idempotencyKey: "hash-eligible-1",
      });
      expect(attachmentsByHashFromEpicCreate()).toBe(true);
      const sentAttrs = imageAttrsFromEpicCreate();
      expect(sentAttrs.hash).toBe("hash-eligible-1");
      expect(sentAttrs.b64content ?? null).toBeNull();

      queryClient.clear();
    });

    it("stays on the inline path when the host has not negotiated epic.create@1.2", async () => {
      setSingleWorkspace();
      recordNegotiatedHostManifest(TEST_HOST_ID, {
        "epic.create": { major: 1, minor: 1 },
      });
      imageStoreMocks.getImageBytes.mockResolvedValue(HELLO_BYTES);
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      const { result } = renderHook(
        () => useLandingComposerActions(useTestPlacementTarget()),
        { wrapper: queryClientWrapper(queryClient) },
      );

      act(() => {
        result.current.submit({
          draftId: null,
          editor: editorHandleForByHashImage("hash-old-host", "inline please"),
          slashCatalog: null,
          toolbar: defaultToolbar(),
        });
      });

      await waitFor(() => {
        expect(
          landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
        ).toBe(true);
      });
      expect(
        landingMocks.dispatchOptions.some((c) => c.method === "drafts.putBlob"),
      ).toBe(false);
      expect(attachmentsByHashFromEpicCreate()).toBe(false);
      const sentAttrs = imageAttrsFromEpicCreate();
      expect(sentAttrs.b64content).toBe(HELLO_BASE64);
      // Absent OR explicit null: the rewrite drops the attr (see above).
      expect(sentAttrs.hash ?? null).toBeNull();

      queryClient.clear();
    });

    it("stays on the inline path for a node the preparer did not mark by-hash eligible", async () => {
      setSingleWorkspace();
      recordNegotiatedHostManifest(TEST_HOST_ID, {
        "epic.create": { major: 1, minor: 2 },
      });
      imageStoreMocks.getImageBytes.mockResolvedValue(HELLO_BYTES);
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      const { result } = renderHook(
        () => useLandingComposerActions(useTestPlacementTarget()),
        { wrapper: queryClientWrapper(queryClient) },
      );

      act(() => {
        result.current.submit({
          draftId: null,
          editor: editorHandleForIneligibleHashImage(
            "hash-ineligible",
            "not eligible",
          ),
          slashCatalog: null,
          toolbar: defaultToolbar(),
        });
      });

      await waitFor(() => {
        expect(
          landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
        ).toBe(true);
      });
      expect(
        landingMocks.dispatchOptions.some((c) => c.method === "drafts.putBlob"),
      ).toBe(false);
      expect(attachmentsByHashFromEpicCreate()).toBe(false);
      const sentAttrs = imageAttrsFromEpicCreate();
      expect(sentAttrs.b64content).toBe(HELLO_BASE64);

      queryClient.clear();
    });

    it("inlines only the unconfirmed hash and keeps the confirmed one hash-only (mixed document)", async () => {
      setSingleWorkspace();
      recordNegotiatedHostManifest(TEST_HOST_ID, {
        "epic.create": { major: 1, minor: 2 },
      });
      // "confirmed" has local bytes and acks; "unconfirmed" has local bytes
      // (so the inline fallback can still fill it in) but the host digest-
      // mismatches its upload - the case `confirmAttachmentsByHash` diffs
      // against the ack, not the upload attempt, to catch.
      imageStoreMocks.getImageBytes.mockResolvedValue(HELLO_BYTES);
      landingMocks.request.mockImplementation((method, payload) => {
        if (method === "drafts.putBlob") {
          const body = payload as { readonly sha256: string };
          return Promise.resolve({ ok: body.sha256 === "hash-confirmed" });
        }
        return Promise.resolve({ roomInfo: null });
      });
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      const { result } = renderHook(
        () => useLandingComposerActions(useTestPlacementTarget()),
        { wrapper: queryClientWrapper(queryClient) },
      );

      act(() => {
        result.current.submit({
          draftId: null,
          editor: editorHandleForTwoByHashImages(
            "hash-confirmed",
            "hash-unconfirmed",
            "mixed",
          ),
          slashCatalog: null,
          toolbar: defaultToolbar(),
        });
      });

      await waitFor(() => {
        expect(
          landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
        ).toBe(true);
      });
      expect(attachmentsByHashFromEpicCreate()).toBe(true);
      const call = landingMocks.request.mock.calls.find(
        (entry) => entry[0] === "epic.create",
      );
      if (call === undefined) throw new Error("expected an epic.create call");
      const allAttrs = allImageAttrsFromEpicCreatePayload(call[1]);
      expect(allAttrs).toHaveLength(2);
      const confirmedAttrs = allAttrs.find(
        (attrs) => attrs.hash === "hash-confirmed",
      );
      const unconfirmedAttrs = allAttrs.find(
        (attrs) => attrs.b64content === HELLO_BASE64,
      );
      if (confirmedAttrs === undefined || unconfirmedAttrs === undefined) {
        throw new Error("expected one hash-only and one inlined node");
      }
      expect(confirmedAttrs.b64content ?? null).toBeNull();
      // Absent OR explicit null: the rewrite drops the attr (see above).
      expect(unconfirmedAttrs.hash ?? null).toBeNull();

      queryClient.clear();
    });

    it("refuses over the per-message hash cap with a toast, before uploading anything", async () => {
      setSingleWorkspace();
      recordNegotiatedHostManifest(TEST_HOST_ID, {
        "epic.create": { major: 1, minor: 2 },
      });
      imageStoreMocks.getImageBytes.mockResolvedValue(HELLO_BYTES);
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      const { result } = renderHook(
        () => useLandingComposerActions(useTestPlacementTarget()),
        { wrapper: queryClientWrapper(queryClient) },
      );

      act(() => {
        result.current.submit({
          draftId: null,
          editor: editorHandleForManyByHashImages(33),
          slashCatalog: null,
          toolbar: defaultToolbar(),
        });
      });

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith("Too many images to attach.", {
          description:
            "A single message can carry at most 32 images. Remove some and try again.",
        });
      });
      expect(
        landingMocks.dispatchOptions.some((c) => c.method === "drafts.putBlob"),
      ).toBe(false);
      expect(
        landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
      ).toBe(false);

      queryClient.clear();
    });

    it("reports isPending while the by-hash upload is in flight and clears it after", async () => {
      setSingleWorkspace();
      recordNegotiatedHostManifest(TEST_HOST_ID, {
        "epic.create": { major: 1, minor: 2 },
      });
      imageStoreMocks.getImageBytes.mockResolvedValue(HELLO_BYTES);
      const putBlobGate = deferred<unknown>();
      landingMocks.request.mockImplementation((method) =>
        method === "drafts.putBlob"
          ? putBlobGate.promise
          : Promise.resolve({ roomInfo: null }),
      );
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      const { result } = renderHook(
        () => useLandingComposerActions(useTestPlacementTarget()),
        { wrapper: queryClientWrapper(queryClient) },
      );

      expect(result.current.isPending).toBe(false);
      act(() => {
        result.current.submit({
          draftId: null,
          editor: editorHandleForByHashImage("hash-pending", "pending"),
          slashCatalog: null,
          toolbar: defaultToolbar(),
        });
      });

      await waitFor(() => {
        expect(result.current.isPending).toBe(true);
      });
      expect(
        landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
      ).toBe(false);

      await act(async () => {
        putBlobGate.resolve({ ok: true });
        await putBlobGate.promise;
      });

      await waitFor(() => {
        expect(
          landingMocks.request.mock.calls.some((c) => c[0] === "epic.create"),
        ).toBe(true);
      });
      await waitFor(() => {
        expect(result.current.isPending).toBe(false);
      });

      queryClient.clear();
    });
  });
});

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

function defaultToolbar() {
  return {
    selection: {
      harnessId: "codex" as const,
      modelSlug: "gpt-5-codex",
      profileId: null,
    },
    reasoning: "high" as const,
    serviceTier: "" as const,
    permission: "supervised" as const,
  };
}

function editorHandleForPrompt(prompt: string): ComposerPromptEditorHandle {
  const content = jsonContentForPrompt(prompt);
  const editorIncarnation = createComposerEditorIncarnation();
  return {
    isReady: () => true,
    getEditorIncarnation: () => editorIncarnation,
    hasFocus: () => false,
    focus: () => undefined,
    focusAtEnd: () => undefined,
    getJSON: () => content,
    isEmpty: () => prompt.length === 0,
    clear: () => undefined,
    setContent: () => undefined,
    syncContent: () => undefined,
    insertImageAttachments: () => undefined,
    insertMentionAttachment: () => false,
    beginPathInsertion: () => null,
    rewriteImageAttachmentHashById: () => false,
    removeImageAttachmentById: () => undefined,
    insertDictatedText: () => undefined,
    dismissActiveSuggestion: () => false,
  };
}

function jsonContentForPrompt(prompt: string): JsonContent {
  if (prompt.length === 0) {
    return { type: "doc", content: [{ type: "paragraph" }] };
  }
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: prompt }],
      },
    ],
  };
}

// A hash-only image draft (an `imageAttachment` node carrying a `hash`, never
// `b64content`) plus a line of text — the shape the live landing editor produces
// after T4.
function editorHandleForHashImage(
  hash: string,
  prompt: string,
): ComposerPromptEditorHandle {
  const content: JsonContent = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "imageAttachment",
            attrs: {
              id: "img-1",
              fileName: "shot.png",
              hash,
              mimeType: "image/png",
              size: 5,
            },
          },
          { type: "text", text: prompt },
        ],
      },
    ],
  };
  return {
    ...editorHandleForPrompt(prompt),
    getJSON: () => content,
  };
}

// A hash-only image node the preparer marked `byHashEligible: true` - the
// shape `planAttachmentsByHash` needs to route a node into `eligible` rather
// than `ineligible`.
function editorHandleForByHashImage(
  hash: string,
  prompt: string,
): ComposerPromptEditorHandle {
  const content: JsonContent = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "imageAttachment",
            attrs: {
              id: "img-1",
              fileName: "shot.png",
              hash,
              mimeType: "image/png",
              size: 5,
              byHashEligible: true,
            },
          },
          { type: "text", text: prompt },
        ],
      },
    ],
  };
  return {
    ...editorHandleForPrompt(prompt),
    getJSON: () => content,
  };
}

// Same shape as {@link editorHandleForHashImage} - `byHashEligible` absent,
// which `imageAttachmentByHashEligible` reads as ineligible - so the gate's
// "at least one eligible node" condition is deliberately unmet.
function editorHandleForIneligibleHashImage(
  hash: string,
  prompt: string,
): ComposerPromptEditorHandle {
  return editorHandleForHashImage(hash, prompt);
}

function editorHandleForTwoByHashImages(
  hashA: string,
  hashB: string,
  prompt: string,
): ComposerPromptEditorHandle {
  const content: JsonContent = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "imageAttachment",
            attrs: {
              id: "img-a",
              fileName: "a.png",
              hash: hashA,
              mimeType: "image/png",
              size: 5,
              byHashEligible: true,
            },
          },
          {
            type: "imageAttachment",
            attrs: {
              id: "img-b",
              fileName: "b.png",
              hash: hashB,
              mimeType: "image/png",
              size: 5,
              byHashEligible: true,
            },
          },
          { type: "text", text: prompt },
        ],
      },
    ],
  };
  return {
    ...editorHandleForPrompt(prompt),
    getJSON: () => content,
  };
}

function editorHandleForManyByHashImages(
  count: number,
): ComposerPromptEditorHandle {
  const imageNodes: JsonContent[] = [];
  for (let i = 0; i < count; i++) {
    imageNodes.push({
      type: "imageAttachment",
      attrs: {
        id: `img-${String(i)}`,
        fileName: `shot-${String(i)}.png`,
        hash: `hash-cap-${String(i)}`,
        mimeType: "image/png",
        size: 5,
        byHashEligible: true,
      },
    });
  }
  const content: JsonContent = {
    type: "doc",
    content: [{ type: "paragraph", content: imageNodes }],
  };
  return {
    ...editorHandleForPrompt(""),
    getJSON: () => content,
  };
}

function findImageNode(node: JsonContent): JsonContent | null {
  if (node.type === "imageAttachment") return node;
  for (const child of node.content ?? []) {
    const found = findImageNode(child);
    if (found !== null) return found;
  }
  return null;
}

/**
 * The handoff's image node, which is HASH-ONLY by design.
 *
 * This helper used to be read as "the canonical source of the submitted
 * content". It is not, and has not been since the composer went hash-first:
 * `finalizeSubmission` builds the handoff entry from `hashOnlyContent` and the
 * wire payload from `resolvedContent`, deliberately, because the handoff is
 * PERSISTED - keeping base64 out of it is what keeps it out of `localStorage`,
 * and the hash is what lets the entry root those bytes against the image GC
 * until the resend inlines them itself. A case about re-inlined BYTES reads
 * {@link imageAttrsFromEpicCreate}; this one is for asserting the hash.
 */
function handoffImageNode(): JsonContent {
  const handoffs = Object.values(
    useInitialChatHandoffStore.getState().handoffs,
  );
  if (handoffs.length !== 1) {
    throw new Error(`expected exactly one handoff, got ${handoffs.length}`);
  }
  const imageNode = findImageNode(handoffs[0].content);
  if (imageNode === null) throw new Error("expected an image node in content");
  return imageNode;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The image attrs on the document `epic.create` actually carried - the only
 * place the re-inlined bytes exist. Walked from `unknown` rather than typed,
 * because the request mock is `(method: string, payload: unknown)`; each step
 * throws with what was missing so a shape change reads as a shape change
 * rather than as `undefined`.
 */
function imageAttrsFromEpicCreate(): Readonly<Record<string, unknown>> {
  const call = landingMocks.request.mock.calls.find(
    (entry) => entry[0] === "epic.create",
  );
  if (call === undefined) throw new Error("expected an epic.create call");
  const payload = call[1];
  if (!isRecord(payload))
    throw new Error("epic.create payload is not an object");
  const chat = payload.chat;
  if (!isRecord(chat)) throw new Error("epic.create carried no chat");
  const initialMessage = chat.initialMessage;
  if (!isRecord(initialMessage)) {
    throw new Error("epic.create carried no initialMessage");
  }
  const attrs = findImageAttrs(initialMessage.content);
  if (attrs === null) {
    throw new Error("expected an image node on the epic.create content");
  }
  return attrs;
}

function findImageAttrs(
  value: unknown,
): Readonly<Record<string, unknown>> | null {
  if (!isRecord(value)) return null;
  if (value.type === "imageAttachment" && isRecord(value.attrs)) {
    return value.attrs;
  }
  const content = value.content;
  if (!Array.isArray(content)) return null;
  for (const child of content) {
    const found = findImageAttrs(child);
    if (found !== null) return found;
  }
  return null;
}

// All image nodes' attrs on a raw `epic.create` payload, for a mixed
// document carrying more than one - {@link imageAttrsFromEpicCreate} only
// finds the first.
function allImageAttrsFromEpicCreatePayload(
  payload: unknown,
): ReadonlyArray<Readonly<Record<string, unknown>>> {
  const found: Array<Readonly<Record<string, unknown>>> = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (!isRecord(value)) return;
    if (value.type === "imageAttachment" && isRecord(value.attrs)) {
      found.push(value.attrs);
      return;
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(payload);
  return found;
}

// The wire-level `attachmentsByHash` flag on the dispatched `epic.create` -
// absent reads as `false`, matching the spread-only-when-true encoding
// `finalizeSubmission` writes it with.
function attachmentsByHashFromEpicCreate(): boolean {
  const call = landingMocks.request.mock.calls.find(
    (entry) => entry[0] === "epic.create",
  );
  if (call === undefined) throw new Error("expected an epic.create call");
  const payload = call[1];
  if (!isRecord(payload))
    throw new Error("epic.create payload is not an object");
  const chat = payload.chat;
  if (!isRecord(chat)) throw new Error("epic.create carried no chat");
  const initialMessage = chat.initialMessage;
  if (!isRecord(initialMessage)) {
    throw new Error("epic.create carried no initialMessage");
  }
  return initialMessage.attachmentsByHash === true;
}

const HELLO_BYTES = new Uint8Array([104, 101, 108, 108, 111]);
const HELLO_BASE64 = "aGVsbG8=";

function setSingleWorkspace(): void {
  setWorkspace(WORKSPACE_PATH, "traycer");
}

function setWorkspace(path: string, name: string): void {
  setGlobalWorkspaceFolders({
    folders: [path],
    folderInfoByPath: {
      [path]: {
        path,
        name,
        repoIdentifier: { owner: "traycerai", repo: name },
        hostId: TEST_HOST_ID,
      },
    },
  });
}

// Typed as the real store item so a change to the split shape (a renamed
// `routeBackingSide`, say) fails these fixtures instead of letting them keep
// compiling against a layout contract that no longer exists.
function splitItem(
  id: string,
  left: { readonly kind: "draft"; readonly id: string },
  right: { readonly kind: "draft"; readonly id: string },
  focusedSide: "left" | "right",
): SplitStripItem {
  return {
    kind: "split" as const,
    id,
    left: { kind: "tab" as const, ref: left },
    right: { kind: "tab" as const, ref: right },
    focusedSide,
    routeBackingSide: focusedSide,
    leftRatio: 0.5,
  };
}

function createdEpicIdFromRequests(): string {
  const call = landingMocks.request.mock.calls.find(
    (entry) => entry[0] === "epic.create",
  );
  const epicId =
    call === undefined ? null : epicIdFromCreateEpicPayload(call[1]);
  if (epicId === null) throw new Error("no epic.create request was sent");
  return epicId;
}

function worktreeIntentFor(workspacePath: string, branchName: string) {
  return {
    entries: [
      {
        kind: "worktree" as const,
        scripts: null,
        workspacePath,
        repoIdentifier: { owner: "traycerai", repo: "traycer" },
        isPrimary: true,
        branch: {
          type: "new" as const,
          name: branchName,
          source: "main",
          carryUncommittedChanges: false,
        },
      },
    ],
  };
}

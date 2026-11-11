/**
 * The landing submit's team-owner and team-sandbox refusals, decided before any
 * frame.
 *
 * A team owner is refused, with no `epic.create` request and no navigation,
 * when the resolved host is below `epic.create@1.3` or the session holds no
 * cloud authorization; a signed-in create on a `@1.3` host carries
 * `owner: { kind: "team", teamId }`, and Personal carries `owner: null`. A
 * harness a team sandbox does not offer is refused on both the chat submit and
 * the terminal-agent path.
 *
 * The negotiated `epic.create` version is recorded in the shared
 * negotiated-manifest registry, which both the placement admission and the
 * owner refusal's `readNegotiatedMethodVersion` read, so the two agree.
 */
import { useLandingComposerActions } from "@/components/home/hooks/use-landing-composer-actions";
import { useLandingOwner } from "@/hooks/home/use-landing-owner";
import { SupersededAuthEraError } from "@/lib/auth/auth-service";
import { ATTACH_ENVIRONMENT_NEEDS_OWN_HOST_COPY } from "@/hooks/epic/use-epic-attach-environment-mutation";
import type { LandingPlacementTarget } from "@/lib/composer/landing-placement";
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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import { createComposerEditorIncarnation } from "@/lib/composer/composer-editor-incarnation";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import { resetDraftBlobTransportForTests } from "@/lib/drafts/draft-blob-transport";
import { resetCloudDraftImageRecoveryForTests } from "@/lib/drafts/cloud-draft-image-recovery";
import { authQueryKeys } from "@/lib/query-keys";
import {
  installHostConnectionRegistrySource,
  resetHostConnectionRegistryForTest,
} from "@traycer-clients/shared/host-client/host-connection-registry";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { remoteEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import type { AuthEra } from "@traycer-clients/shared/auth/request-context-provider";
import type { HostOwnershipResult } from "@traycer-clients/shared/host-client/host-ownership";
import type { HostOwnerPrincipal } from "@traycer/protocol/host/host-status";

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
  getLocalHostId: vi.fn<() => string | null>(() => "host-local-typing"),
  getActiveHost: vi.fn<() => HostDirectoryEntry>(() => ({
    hostId: "host-landing",
    label: "Local",
    kind: "local",
    websocketUrl: "ws://127.0.0.1:4917/rpc",
    version: "0.0.0-test",
    transportDialability: "dialable",
  })),
  getHostBinding: vi.fn<() => LandingAuthBinding | null>(() => null),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => landingMocks.navigate,
  useRouter: () => ({ state: { location: { pathname: "/" } } }),
}));

vi.mock("@/lib/host", () => ({
  useHostBinding: () => landingMocks.getHostBinding(),
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
const SIGN_IN_FOR_ACME = "Sign in to create a task for acme.";
const NOT_ON_TEAM_SANDBOXES = "Not available on team sandboxes.";
const LOCAL_OWNERSHIP_ERA: AuthEra = {
  identity: "user-landing",
  credentialGeneration: 1,
};

interface LandingAuthBinding {
  readonly directory: {
    list(): Promise<readonly HostDirectoryEntry[]>;
    onChange(listener: () => void): { dispose(): void };
  };
  readonly auth: {
    currentAuthEra(): AuthEra;
    readHostOwnership(
      hostId: string,
      era: AuthEra,
    ): Promise<HostOwnershipResult>;
  };
}

interface DeferredValue<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

interface PendingLocalOwnership {
  readonly directory: LandingAuthBinding["directory"];
  readonly auth: LandingAuthBinding["auth"];
  readonly reads: Array<{ readonly hostId: string; readonly era: AuthEra }>;
  resolve(owner: HostOwnerPrincipal): void;
  refresh(owner: HostOwnerPrincipal): void;
  reject(error: Error): void;
}

function deferredValue<T>(): DeferredValue<T> {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value) => resolvePromise(value),
    reject: (error) => rejectPromise(error),
  };
}

function createPendingLocalOwnership(): PendingLocalOwnership {
  const deferred = deferredValue<HostOwnershipResult>();
  const refreshed = deferredValue<HostOwnershipResult>();
  const reads: Array<{ readonly hostId: string; readonly era: AuthEra }> = [];
  return {
    directory: {
      list: () => Promise.resolve([]),
      onChange: () => ({ dispose: () => undefined }),
    },
    auth: {
      currentAuthEra: () => LOCAL_OWNERSHIP_ERA,
      readHostOwnership: (hostId, era) => {
        reads.push({ hostId, era });
        return reads.length === 1 ? deferred.promise : refreshed.promise;
      },
    },
    reads,
    resolve: (owner) => deferred.resolve(ownerResult(owner)),
    refresh: (owner) => refreshed.resolve(ownerResult(owner)),
    reject: (error) => deferred.reject(error),
  };
}

function installOwnerDirectoryEntry(entry: HostDirectoryEntry): void {
  const rows = new Map([[entry.hostId, entry]]);
  installHostConnectionRegistrySource({
    directory: {
      findById: (hostId) => rows.get(hostId) ?? null,
      onDirectoryChanged: () => ({ dispose: () => undefined }),
    },
    leases: null,
  });
}

function useActionsWithResolvedOwner() {
  return {
    owner: useLandingOwner(landingMocks.getActiveHostId()),
    actions: useLandingComposerActions(useTestPlacementTarget()),
  };
}

function ownerResult(owner: HostOwnerPrincipal): HostOwnershipResult {
  return {
    kind: "ok",
    host: {
      hostId: TEST_HOST_ID,
      owner,
      kind: "machine",
      remoteAccess: false,
    },
  };
}

function localOwnerDirectoryEntry(): HostDirectoryEntry {
  return { ...mockLocalHostEntry, hostId: TEST_HOST_ID };
}

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

/** The payload's `owner`, narrowed structurally; `"absent"` when it has none. */
function ownerFromCreatePayload(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null) return "absent";
  if (!("owner" in payload)) return "absent";
  return payload.owner;
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

describe("useLandingComposerActions team owner and team sandbox refusals", () => {
  beforeEach(() => {
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
    landingMocks.getHostBinding.mockReset();
    landingMocks.getHostBinding.mockReturnValue(null);
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
    vi.useRealTimers();
    setSystemTabModalApi(null);
    __resetTabNavigationControllerForTesting();
    draftRuntimeRegistry.resetForTesting();
    cleanup();
    resetHostConnectionRegistryForTest();
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

  it("waits for local team ownership before creating and uses the resolved owner", async () => {
    recordNegotiatedHostManifest(TEST_HOST_ID, {
      "epic.create": { major: 1, minor: 3 },
    });
    useAuthStore.setState({
      shareableTeams: [{ teamId: "t1", slug: "acme", avatarUrl: null }],
    });
    const ownership = createPendingLocalOwnership();
    landingMocks.getHostBinding.mockReturnValue({
      auth: ownership.auth,
      directory: ownership.directory,
    });
    installOwnerDirectoryEntry(localOwnerDirectoryEntry());
    const queryClient = newQueryClient();
    const { result } = renderHook(() => useActionsWithResolvedOwner(), {
      wrapper: queryClientWrapper(queryClient),
    });

    await waitFor(() => expect(ownership.reads).toHaveLength(1));
    expect(result.current.owner).toBeNull();
    const pendingUi = result.current.actions.isPending;
    vi.useFakeTimers();
    let refusal: { readonly message: string } | null = null;
    act(() => {
      refusal = result.current.actions.submit({
        draftId: null,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        owner: result.current.owner,
        teamSandboxHarnessBlocked: false,
        settled: null,
        toolbar: defaultToolbar(),
      });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    const createdBeforeOwnershipResolved = hasEpicCreateRequest();
    ownership.resolve({ kind: "team", id: "t1", name: "Acme" });
    vi.useRealTimers();
    await waitFor(() => expect(hasEpicCreateRequest()).toBe(true));

    expect(refusal).toBeNull();
    expect(createdBeforeOwnershipResolved).toBe(false);
    expect(ownerFromCreatePayload(epicCreatePayload())).toEqual({
      kind: "team",
      teamId: "t1",
    });
    expect(pendingUi).toBe(true);
    expect(ownership.reads).toEqual([
      { hostId: TEST_HOST_ID, era: LOCAL_OWNERSHIP_ERA },
    ]);
    queryClient.clear();
  });

  it("creates a local personal task with a null owner after ownership resolves", async () => {
    recordNegotiatedHostManifest(TEST_HOST_ID, {
      "epic.create": { major: 1, minor: 3 },
    });
    const ownership = createPendingLocalOwnership();
    landingMocks.getHostBinding.mockReturnValue({
      auth: ownership.auth,
      directory: ownership.directory,
    });
    installOwnerDirectoryEntry(localOwnerDirectoryEntry());
    const queryClient = newQueryClient();
    const { result } = renderHook(() => useActionsWithResolvedOwner(), {
      wrapper: queryClientWrapper(queryClient),
    });

    await waitFor(() => expect(ownership.reads).toHaveLength(1));
    const pendingUi = result.current.actions.isPending;
    vi.useFakeTimers();
    act(() => {
      result.current.actions.submit({
        draftId: null,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        owner: result.current.owner,
        teamSandboxHarnessBlocked: false,
        settled: null,
        toolbar: defaultToolbar(),
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    const createdBeforeOwnershipResolved = hasEpicCreateRequest();
    ownership.resolve({ kind: "user", id: "user-landing" });
    vi.useRealTimers();
    await waitFor(() => expect(hasEpicCreateRequest()).toBe(true));

    expect(pendingUi).toBe(true);
    expect(createdBeforeOwnershipResolved).toBe(false);
    expect(ownerFromCreatePayload(epicCreatePayload())).toBeNull();
    queryClient.clear();
  });

  it("resolves settled local personal ownership synchronously", async () => {
    recordNegotiatedHostManifest(TEST_HOST_ID, {
      "epic.create": { major: 1, minor: 3 },
    });
    const ownership = createPendingLocalOwnership();
    landingMocks.getHostBinding.mockReturnValue({
      auth: ownership.auth,
      directory: ownership.directory,
    });
    installOwnerDirectoryEntry(localOwnerDirectoryEntry());
    const queryClient = newQueryClient();
    const { result } = renderHook(() => useActionsWithResolvedOwner(), {
      wrapper: queryClientWrapper(queryClient),
    });

    await waitFor(() => expect(ownership.reads).toHaveLength(1));
    ownership.resolve({ kind: "user", id: "user-landing" });
    await waitFor(() =>
      expect(
        queryClient.getQueryState(
          authQueryKeys.hostOwnership(
            ownership.auth,
            "user-landing",
            TEST_HOST_ID,
          ),
        )?.status,
      ).toBe("success"),
    );

    const resolvedOwner = result.current.actions.resolveOwnerForCreate({
      teamId: "fallback-team",
      slug: "fallback",
    });
    expect(resolvedOwner).toBeNull();
    expect(resolvedOwner).not.toBeInstanceOf(Promise);
    expect(ownership.reads).toHaveLength(1);

    vi.useFakeTimers();
    act(() => {
      result.current.actions.submit({
        draftId: null,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        owner: result.current.owner,
        teamSandboxHarnessBlocked: false,
        settled: null,
        toolbar: defaultToolbar(),
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const createdInCurrentTurn = hasEpicCreateRequest();
    vi.useRealTimers();

    expect(createdInCurrentTurn).toBe(true);
    expect(ownerFromCreatePayload(epicCreatePayload())).toBeNull();
    expect(ownership.reads).toHaveLength(1);
    queryClient.clear();
  });

  it("uses the personal fallback synchronously when ownership is disabled and idle", () => {
    useAuthStore.getState().setSignedOut();
    const ownership = createPendingLocalOwnership();
    landingMocks.getHostBinding.mockReturnValue({
      auth: ownership.auth,
      directory: ownership.directory,
    });
    installOwnerDirectoryEntry(localOwnerDirectoryEntry());
    const queryClient = newQueryClient();
    const { result } = renderHook(() => useActionsWithResolvedOwner(), {
      wrapper: queryClientWrapper(queryClient),
    });
    const queryState = queryClient.getQueryState(
      authQueryKeys.hostOwnership(ownership.auth, null, TEST_HOST_ID),
    );

    expect(queryState).toMatchObject({
      status: "pending",
      fetchStatus: "idle",
    });
    const resolvedOwner = result.current.actions.resolveOwnerForCreate(null);
    expect(resolvedOwner).toBeNull();
    expect(resolvedOwner).not.toBeInstanceOf(Promise);
    expect(ownership.reads).toHaveLength(0);
    queryClient.clear();
  });

  it("uses the current personal owner when the local ownership query fails", async () => {
    recordNegotiatedHostManifest(TEST_HOST_ID, {
      "epic.create": { major: 1, minor: 3 },
    });
    const ownership = createPendingLocalOwnership();
    landingMocks.getHostBinding.mockReturnValue({
      auth: ownership.auth,
      directory: ownership.directory,
    });
    installOwnerDirectoryEntry(localOwnerDirectoryEntry());
    const queryClient = newQueryClient();
    const { result } = renderHook(() => useActionsWithResolvedOwner(), {
      wrapper: queryClientWrapper(queryClient),
    });

    await waitFor(() => expect(ownership.reads).toHaveLength(1));
    vi.useFakeTimers();
    act(() => {
      result.current.actions.submit({
        draftId: null,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        owner: result.current.owner,
        teamSandboxHarnessBlocked: false,
        settled: null,
        toolbar: defaultToolbar(),
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    const createdBeforeOwnershipSettled = hasEpicCreateRequest();
    ownership.reject(new Error("ownership unavailable"));
    vi.useRealTimers();
    await waitFor(() => expect(hasEpicCreateRequest()).toBe(true));

    expect(createdBeforeOwnershipSettled).toBe(false);
    expect(ownerFromCreatePayload(epicCreatePayload())).toBeNull();
    queryClient.clear();
  });

  it("does not create when the live local ownership read is superseded", async () => {
    recordNegotiatedHostManifest(TEST_HOST_ID, {
      "epic.create": { major: 1, minor: 3 },
    });
    const ownership = createPendingLocalOwnership();
    landingMocks.getHostBinding.mockReturnValue({
      auth: ownership.auth,
      directory: ownership.directory,
    });
    installOwnerDirectoryEntry(localOwnerDirectoryEntry());
    const queryClient = newQueryClient();
    const { result } = renderHook(() => useActionsWithResolvedOwner(), {
      wrapper: queryClientWrapper(queryClient),
    });

    await waitFor(() => expect(ownership.reads).toHaveLength(1));
    vi.useFakeTimers();
    act(() => {
      result.current.actions.submit({
        draftId: null,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        owner: result.current.owner,
        teamSandboxHarnessBlocked: false,
        settled: null,
        toolbar: defaultToolbar(),
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    const createdWhileOwnershipWasPending = hasEpicCreateRequest();
    ownership.reject(new SupersededAuthEraError());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    const createdAfterSupersededOwnership = hasEpicCreateRequest();
    vi.useRealTimers();

    expect(createdWhileOwnershipWasPending).toBe(false);
    expect(createdAfterSupersededOwnership).toBe(false);
    queryClient.clear();
  });

  it("does not create from a cached local ownership error for a superseded auth era", async () => {
    recordNegotiatedHostManifest(TEST_HOST_ID, {
      "epic.create": { major: 1, minor: 3 },
    });
    const ownership = createPendingLocalOwnership();
    landingMocks.getHostBinding.mockReturnValue({
      auth: ownership.auth,
      directory: ownership.directory,
    });
    installOwnerDirectoryEntry(localOwnerDirectoryEntry());
    const queryClient = newQueryClient();
    const queryKey = authQueryKeys.hostOwnership(
      ownership.auth,
      "user-landing",
      TEST_HOST_ID,
    );
    const { result } = renderHook(() => useActionsWithResolvedOwner(), {
      wrapper: queryClientWrapper(queryClient),
    });

    await waitFor(() => expect(ownership.reads).toHaveLength(1));
    ownership.reject(new SupersededAuthEraError());
    await waitFor(() =>
      expect(queryClient.getQueryState(queryKey)?.status).toBe("error"),
    );
    vi.useFakeTimers();
    act(() => {
      result.current.actions.submit({
        draftId: null,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        owner: result.current.owner,
        teamSandboxHarnessBlocked: false,
        settled: null,
        toolbar: defaultToolbar(),
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    const createdAfterCachedSupersededOwnership = hasEpicCreateRequest();
    vi.useRealTimers();

    expect(createdAfterCachedSupersededOwnership).toBe(false);
    queryClient.clear();
  });

  it("keeps the trusted remote team owner path unchanged", async () => {
    recordNegotiatedHostManifest(TEST_HOST_ID, {
      "epic.create": { major: 1, minor: 3 },
    });
    const entry: RemoteHostDirectoryEntry = {
      ...remoteEntry(TEST_HOST_ID, null),
      owner: { kind: "team", id: "t1", name: "Acme" },
    };
    installOwnerDirectoryEntry(entry);
    landingMocks.getActiveHost.mockReturnValue(entry);
    useAuthStore.setState({
      shareableTeams: [{ teamId: "t1", slug: "acme", avatarUrl: null }],
    });
    const queryClient = newQueryClient();
    const { result } = renderHook(() => useActionsWithResolvedOwner(), {
      wrapper: queryClientWrapper(queryClient),
    });

    expect(result.current.owner).toEqual(ACME_OWNER);
    const resolvedOwner = result.current.actions.resolveOwnerForCreate(
      result.current.owner,
    );
    expect(resolvedOwner).toEqual(ACME_OWNER);
    expect(resolvedOwner).not.toBeInstanceOf(Promise);
    vi.useFakeTimers();
    act(() => {
      result.current.actions.submit({
        draftId: null,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        owner: result.current.owner,
        teamSandboxHarnessBlocked: false,
        settled: null,
        toolbar: defaultToolbar(),
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    vi.useRealTimers();

    expect(hasEpicCreateRequest()).toBe(true);
    expect(ownerFromCreatePayload(epicCreatePayload())).toEqual({
      kind: "team",
      teamId: "t1",
    });
    expect(landingMocks.getHostBinding()).toBeNull();
    queryClient.clear();
  });

  it("keeps staged attachment based on the owner sent while the create is pending", async () => {
    recordNegotiatedHostManifest(TEST_HOST_ID, {
      "epic.create": { major: 1, minor: 3 },
    });
    useAuthStore.setState({
      shareableTeams: [{ teamId: "t1", slug: "acme", avatarUrl: null }],
    });
    const ownership = createPendingLocalOwnership();
    landingMocks.getHostBinding.mockReturnValue({
      auth: ownership.auth,
      directory: ownership.directory,
    });
    installOwnerDirectoryEntry(localOwnerDirectoryEntry());
    const createResponse = deferredValue<unknown>();
    landingMocks.request.mockImplementation((method: string) =>
      method === "epic.create" ? createResponse.promise : Promise.resolve({}),
    );
    const queryClient = newQueryClient();
    const { result } = renderHook(() => useActionsWithResolvedOwner(), {
      wrapper: queryClientWrapper(queryClient),
    });

    await waitFor(() => expect(ownership.reads).toHaveLength(1));
    const ownerResolution = Promise.resolve(
      result.current.actions.resolveOwnerForCreate(result.current.owner),
    );
    ownership.resolve({ kind: "team", id: "t1", name: "Acme" });
    const resolvedOwner = await ownerResolution;
    expect(resolvedOwner).toEqual(ACME_OWNER);
    let confirmed = false;
    act(() => {
      result.current.actions.startTaskOnStagedSandbox({
        draftId: null,
        owner: resolvedOwner,
        sandboxTeamId: "t1",
        text: SUBMITTED_PROMPT,
        hand: (_epicId) => ({
          isCurrent: () => true,
          confirm: () => {
            confirmed = true;
          },
          giveBack: () => null,
        }),
      });
    });
    await waitFor(() => expect(hasEpicCreateRequest()).toBe(true));
    expect(ownerFromCreatePayload(epicCreatePayload())).toEqual({
      kind: "team",
      teamId: "t1",
    });

    act(() => {
      void queryClient.invalidateQueries({
        queryKey: authQueryKeys.hostOwnership(
          ownership.auth,
          "user-landing",
          TEST_HOST_ID,
        ),
      });
    });
    await waitFor(() => expect(ownership.reads).toHaveLength(2));
    ownership.refresh({ kind: "user", id: "user-landing" });
    await waitFor(() => expect(result.current.owner).toBeNull());

    await act(async () => {
      createResponse.resolve({ roomInfo: null });
      await createResponse.promise;
    });
    await waitFor(() => expect(confirmed).toBe(true));

    expect(
      landingMocks.request.mock.calls.some(
        ([method]) => method === "epic.attachEnvironment",
      ),
    ).toBe(false);
    queryClient.clear();
  });

  it("refuses a stale placement attachment client after ownership resolves to a team", async () => {
    recordNegotiatedHostManifest(TEST_HOST_ID, {
      "epic.create": { major: 1, minor: 3 },
    });
    useAuthStore.setState({
      shareableTeams: [{ teamId: "t1", slug: "acme", avatarUrl: null }],
    });
    const ownership = createPendingLocalOwnership();
    landingMocks.getHostBinding.mockReturnValue({
      auth: ownership.auth,
      directory: ownership.directory,
    });
    installOwnerDirectoryEntry(localOwnerDirectoryEntry());
    const queryClient = newQueryClient();
    const { result } = renderHook(() => useActionsWithResolvedOwner(), {
      wrapper: queryClientWrapper(queryClient),
    });

    await waitFor(() => expect(ownership.reads).toHaveLength(1));
    const actionsWhileOwnershipFetches = result.current.actions;
    const ownerResolution = Promise.resolve(
      actionsWhileOwnershipFetches.resolveOwnerForCreate(null),
    );
    ownership.resolve({ kind: "team", id: "t1", name: "Acme" });
    const resolvedOwner = await ownerResolution;
    expect(resolvedOwner).toEqual(ACME_OWNER);

    let handed = false;
    let refusal: { readonly message: string } | null = null;
    act(() => {
      refusal = actionsWhileOwnershipFetches.startTaskOnStagedSandbox({
        draftId: null,
        owner: resolvedOwner,
        sandboxTeamId: "t2",
        text: SUBMITTED_PROMPT,
        hand: () => {
          handed = true;
          return {
            isCurrent: () => true,
            confirm: () => undefined,
            giveBack: () => null,
          };
        },
      });
    });

    expect(refusal).toEqual({
      message: ATTACH_ENVIRONMENT_NEEDS_OWN_HOST_COPY,
    });
    expect(handed).toBe(false);
    expect(hasEpicCreateRequest()).toBe(false);
    queryClient.clear();
  });

  it("refuses a team create on an epic.create@1.2 host with the update line, and sends nothing", async () => {
    recordNegotiatedHostManifest(TEST_HOST_ID, {
      "epic.create": { major: 1, minor: 2 },
    });
    const queryClient = newQueryClient();
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      { wrapper: queryClientWrapper(queryClient) },
    );

    let refusal: { readonly message: string } | null = null;
    act(() => {
      refusal = result.current.submit({
        draftId: null,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        owner: ACME_OWNER,
        teamSandboxHarnessBlocked: false,
        settled: null,
        toolbar: defaultToolbar(),
      });
    });

    expect(refusal).toEqual({ message: HOST_TOO_OLD });
    await flushPending();
    expect(hasEpicCreateRequest()).toBe(false);
    expect(landingMocks.navigate).not.toHaveBeenCalled();
    queryClient.clear();
  });

  it("refuses a team create without a cloud verdict on an epic.create@1.3 host with the sign-in line, and sends nothing", async () => {
    // Unverified is admitted by the placement (the host serves local-first
    // creates from @1.1), so the refusal below is the owner's, not the
    // cloud-verdict gate's.
    recordNegotiatedHostManifest(TEST_HOST_ID, {
      "epic.create": { major: 1, minor: 3 },
    });
    useAuthStore
      .getState()
      .setUnverifiedSession(
        { userId: "user-landing", userName: "U", email: "u@example.com" },
        { userId: "user-landing", username: "U" },
      );
    const queryClient = newQueryClient();
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      { wrapper: queryClientWrapper(queryClient) },
    );

    let refusal: { readonly message: string } | null = null;
    act(() => {
      refusal = result.current.submit({
        draftId: null,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        owner: ACME_OWNER,
        teamSandboxHarnessBlocked: false,
        settled: null,
        toolbar: defaultToolbar(),
      });
    });

    expect(refusal).toEqual({ message: SIGN_IN_FOR_ACME });
    await flushPending();
    expect(hasEpicCreateRequest()).toBe(false);
    expect(landingMocks.navigate).not.toHaveBeenCalled();
    queryClient.clear();
  });

  it("sends a signed-in team create on an epic.create@1.3 host with the team owner", async () => {
    recordNegotiatedHostManifest(TEST_HOST_ID, {
      "epic.create": { major: 1, minor: 3 },
    });
    const queryClient = newQueryClient();
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      { wrapper: queryClientWrapper(queryClient) },
    );

    let refusal: { readonly message: string } | null = {
      message: "unset",
    };
    act(() => {
      refusal = result.current.submit({
        draftId: null,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        owner: ACME_OWNER,
        teamSandboxHarnessBlocked: false,
        settled: null,
        toolbar: defaultToolbar(),
      });
    });

    expect(refusal).toBeNull();
    await waitFor(() => {
      expect(hasEpicCreateRequest()).toBe(true);
    });
    expect(ownerFromCreatePayload(epicCreatePayload())).toEqual({
      kind: "team",
      teamId: "t1",
    });
    queryClient.clear();
  });

  it("sends a Personal create with owner null", async () => {
    const queryClient = newQueryClient();
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      { wrapper: queryClientWrapper(queryClient) },
    );

    act(() => {
      result.current.submit({
        draftId: null,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        owner: null,
        teamSandboxHarnessBlocked: false,
        settled: null,
        toolbar: defaultToolbar(),
      });
    });

    await waitFor(() => {
      expect(hasEpicCreateRequest()).toBe(true);
    });
    expect(ownerFromCreatePayload(epicCreatePayload())).toBeNull();
    queryClient.clear();
  });

  it("refuses a chat submit whose harness a team sandbox does not offer, and sends nothing", async () => {
    const queryClient = newQueryClient();
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      { wrapper: queryClientWrapper(queryClient) },
    );

    let refusal: { readonly message: string } | null = null;
    act(() => {
      refusal = result.current.submit({
        draftId: null,
        editor: editorHandleForPrompt(SUBMITTED_PROMPT),
        slashCatalog: null,
        owner: null,
        teamSandboxHarnessBlocked: true,
        settled: null,
        toolbar: defaultToolbar(),
      });
    });

    expect(refusal).toEqual({ message: NOT_ON_TEAM_SANDBOXES });
    await flushPending();
    expect(hasEpicCreateRequest()).toBe(false);
    expect(landingMocks.navigate).not.toHaveBeenCalled();
    queryClient.clear();
  });

  it("refuses a terminal-agent launch whose harness a team sandbox does not offer, and sends nothing", async () => {
    const queryClient = newQueryClient();
    const { result } = renderHook(
      () => useLandingComposerActions(useTestPlacementTarget()),
      { wrapper: queryClientWrapper(queryClient) },
    );

    let refusal: { readonly message: string } | null = null;
    act(() => {
      refusal = result.current.selectTerminalAgent({
        launch: {
          harnessId: "claude",
          model: null,
          reasoningEffort: null,
          terminalAgentArgs: "",
          profileId: null,
        },
        draftId: null,
        owner: null,
        teamSandboxHarnessBlocked: true,
        settled: null,
      });
    });

    expect(refusal).toEqual({ message: NOT_ON_TEAM_SANDBOXES });
    await flushPending();
    expect(hasEpicCreateRequest()).toBe(false);
    expect(landingMocks.createTerminalAgent).not.toHaveBeenCalled();
    expect(landingMocks.navigate).not.toHaveBeenCalled();
    queryClient.clear();
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
    ultracode: false,
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
    insertFileAttachment: () => false,
    settleFileAttachment: () => false,
    insertImageAttachments: () => undefined,
    insertMentionAttachment: () => false,
    beginPathInsertion: () => null,
    rewriteImageAttachmentHashById: () => false,
    removeImageAttachmentById: () => undefined,
    insertDictatedText: () => undefined,
    dismissActiveSuggestion: () => false,
    draftGeneration: () => 0,
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

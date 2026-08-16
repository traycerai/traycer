import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { WorktreeIntent } from "@traycer/protocol/host/worktree-schemas";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { HostWorkspaceControlsHostScope } from "@/components/home/host-workspace-selector/host-workspace-controls-scope";
import type { LandingDraftWorkspaceSnapshot } from "@/stores/home/landing-draft-store";
import { emptyLandingDraftWorkspaceSnapshot } from "@/stores/home/landing-draft-store";
import type { SeedIntentOverride } from "@/lib/worktree/worktree-intent-seeding";
import type { WorktreeStagingKey } from "@/stores/worktree/worktree-intent-staging-store";

/**
 * Cross-host fork dialog: the reported bug was that picking a host called
 * `directory.selectById` (app-wide rebind) while submit hardcoded `tabHostId`.
 */

const TAB_HOST_ID = "tab-host-id";
const OTHER_HOST_ID = "other-host-id";
const UNKNOWN_HOST_ID = "unknown-host-id";
const OLD_HOST_ID = "old-host-id";
const ABSENT_HOST_ID = "absent-host-id";

interface ChatForkCreateInput {
  readonly hostId: string;
  readonly worktreeIntent: WorktreeIntent | null;
  readonly forkSource: {
    readonly boundary: "assistantMessage";
    readonly sourceChatId: string;
    readonly assistantMessageId: string;
    readonly sourceOwnerUserId: string | null;
  };
}

interface CreateVariables {
  readonly hostId: string;
  readonly forkSource: {
    readonly boundary: "assistantMessage";
    readonly sourceChatId: string;
    readonly assistantMessageId: string;
  } | null;
}

interface ChatForkMutationOptions {
  readonly onSuccess: (result: { readonly chatId: string }) => void;
}

interface CapturedWorkspaceProps {
  readonly workspaceSeed: LandingDraftWorkspaceSnapshot | null;
  readonly seedIntent: WorktreeIntent | null;
  readonly seedIntentOverride: SeedIntentOverride | null;
  readonly stagingKey: WorktreeStagingKey;
  readonly hostScope: HostWorkspaceControlsHostScope;
}

interface PublicationStateResponse {
  readonly published: boolean;
  readonly boundaryCovered: boolean | null;
  readonly publishedThroughTs: number | null;
}

const dialogMocks = vi.hoisted(() => ({
  createMutate:
    vi.fn<
      (input: ChatForkCreateInput, options: ChatForkMutationOptions) => void
    >(),
  lastCreateClient: null as object | null,
  createPending: false,
  createError: null as { readonly code: string } | null,
  createVariables: null as CreateVariables | null,
  createReset: vi.fn(() => {
    dialogMocks.createError = null;
    dialogMocks.createVariables = null;
  }),
  /**
   * Which hosts have a live capability probe this render.
   *
   * A set rather than a single boolean, because the dialog mounts one probe per
   * non-supported candidate: "is SOME probe on" cannot distinguish the row that
   * healed from the ones still refused, and would read `true` for the wrong
   * reason after an upgrade.
   */
  capabilityProbeHostIds: new Set<string>(),
  /** False models the window after a retarget, before the catalog answers. */
  modelsLoaded: true,
  publicationQuery: { data: undefined as PublicationStateResponse | undefined },
  publicationQueryEnabled: false,
  publicationQueryIsError: false,
  publicationQueryIsFetching: false,
  selectById: vi.fn<(hostId: string) => void>(),
  clientsByHostId: new Map<string, unknown>(),
  directoryHosts: [] as HostDirectoryEntry[],
  lastWorkspace: null as CapturedWorkspaceProps | null,
  cloneOwnerCalls: [] as readonly unknown[],
}));

vi.mock("@/hooks/epic/use-epic-chat-mutations", () => ({
  useEpicCreateChatForHostClient: (client: object | null) => {
    dialogMocks.lastCreateClient = client;
    return {
      mutate: (
        input: ChatForkCreateInput,
        options: ChatForkMutationOptions,
      ) => {
        dialogMocks.createVariables = {
          hostId: input.hostId,
          forkSource: {
            boundary: input.forkSource.boundary,
            sourceChatId: input.forkSource.sourceChatId,
            assistantMessageId: input.forkSource.assistantMessageId,
          },
        };
        dialogMocks.createMutate(input, options);
      },
      isPending: dialogMocks.createPending,
      error: dialogMocks.createError,
      variables: dialogMocks.createVariables,
      reset: dialogMocks.createReset,
      data: null,
      isError: false,
      isSuccess: false,
      status: "idle",
    };
  },
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) => {
    if (hostId === null) return null;
    return dialogMocks.clientsByHostId.get(hostId) ?? null;
  },
}));

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => dialogMocks.clientsByHostId.get(TAB_HOST_ID) ?? null,
    useHostBinding: () => ({
      directory: { selectById: dialogMocks.selectById },
    }),
  };
});

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: dialogMocks.directoryHosts }),
}));

vi.mock("@/hooks/chats/use-clone-source-owner", () => ({
  useCloneSourceOwnerUserId: (args: unknown) => {
    dialogMocks.cloneOwnerCalls = [...dialogMocks.cloneOwnerCalls, args];
    return null;
  },
}));

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => TAB_HOST_ID,
}));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: (args: {
    readonly method?: string;
    readonly client?: unknown;
    readonly options?: { readonly enabled?: boolean } | null;
  }) => {
    if (args.method === "host.status") {
      const enabled = args.options?.enabled ?? false;
      // Reverse the client back to its host so the set says WHICH rows are
      // being re-asked about, not merely that something is.
      for (const [hostId, client] of dialogMocks.clientsByHostId) {
        if (client !== args.client) continue;
        if (enabled) dialogMocks.capabilityProbeHostIds.add(hostId);
        else dialogMocks.capabilityProbeHostIds.delete(hostId);
      }
      return { data: undefined };
    }
    if (args.method === "providers.list") {
      return {
        data: {
          providers: [
            {
              providerId: "claude-code",
              enabled: true,
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
              nativeCapabilities: {
                supportedTabs: ["general", "env", "usage"],
                mcp: null,
                plugins: null,
                skills: null,
                modelProviders: null,
              },
              managedInstallState: null,
              versionVisibility: null,
              advisory: null,
              profiles: [
                {
                  profileId: "ambient",
                  kind: "ambient",
                  authType: "oauth",
                  label: "Terminal account",
                  auth: {
                    status: "authenticated",
                    badgeText: null,
                    label: null,
                    detail: null,
                  },
                  identity: null,
                  usageUpdatedAt: null,
                  rateLimitStatus: "unknown",
                  rateLimitLimitedScopes: null,
                  duplicateOfProfileId: null,
                  accentColor: null,
                  ambientDriftNotice: null,
                },
              ],
            },
          ],
        },
      };
    }
    if (args.method === "epic.chatPublicationState") {
      const enabled = args.options?.enabled ?? false;
      dialogMocks.publicationQueryEnabled = enabled;
      // TanStack retains cached data when the observer is disabled, the
      // refetch errors, OR a stale query is refetching. The hook, not
      // the query object, must treat those as unknown — handing
      // `undefined` here would make those gates untestable.
      return {
        data: dialogMocks.publicationQuery.data,
        isError: dialogMocks.publicationQueryIsError,
        isFetching: dialogMocks.publicationQueryIsFetching,
      };
    }
    return { data: undefined };
  },
}));

vi.mock("@/components/home/pickers/harness-model-picker", () => ({
  HarnessModelPicker: () => (
    <button type="button" aria-label="Harness picker">
      Claude Opus
    </button>
  ),
}));

vi.mock("@/components/home/pickers/agent-mode-toggle", () => ({
  AgentModeToggle: () => (
    <button type="button" aria-label="Agent mode">
      Regular
    </button>
  ),
}));

vi.mock(
  "@/components/home/host-workspace-selector/host-workspace-selector",
  () => ({
    ActiveHostWorkspaceControls: (props: CapturedWorkspaceProps) => {
      dialogMocks.lastWorkspace = props;
      const refusals =
        props.hostScope.kind === "selected"
          ? props.hostScope.refusalByHostId
          : new Map<string, string>();
      const unselectableExceptHostId =
        props.hostScope.kind === "selected"
          ? props.hostScope.unselectableExceptHostId
          : null;
      const hosts = dialogMocks.directoryHosts;
      return (
        <div data-testid="fork-workspace-controls">
          {hosts.map((entry) => {
            const refusal = refusals.get(entry.hostId) ?? null;
            const inert =
              unselectableExceptHostId !== null &&
              entry.hostId !== unselectableExceptHostId;
            const disabled = refusal !== null || inert;
            // Inert leads: a class-level silence and a per-host word
            // cannot both be true of one row.
            const showRefusal = refusal !== null && !inert;
            return (
              <button
                key={entry.hostId}
                type="button"
                data-testid={`fork-host-${entry.hostId}`}
                disabled={disabled}
                onClick={() => {
                  if (disabled) return;
                  // If the dialog regresses to `kind: "active"`, a pick must
                  // hit the directory spy — that is the reported bug.
                  if (props.hostScope.kind === "selected") {
                    props.hostScope.onSelect(entry.hostId);
                    return;
                  }
                  if (props.hostScope.kind === "active") {
                    dialogMocks.selectById(entry.hostId);
                  }
                }}
              >
                {entry.label}
                {showRefusal ? (
                  <span data-testid={`fork-host-refusal-${entry.hostId}`}>
                    {refusal}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      );
    },
  }),
);

vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQueryForClient: () => ({
    data: {
      harnesses: [
        {
          id: "claude",
          label: "Claude Code",
          available: true,
          error: null,
          modes: ["gui", "tui"],
          requiresApiKey: false,
          supportedPermissionModes: ["supervised"],
        },
      ],
    },
    isPending: false,
  }),
  useGuiHarnessModelsQueryForClient: () => ({
    // `undefined` is how the toolbar store learns the catalog is still LOADING
    // (`modelsLoaded = modelsQuery.data !== undefined`), which is the state a
    // retarget lands in before the new host's models arrive.
    data: dialogMocks.modelsLoaded
      ? {
          models: [
            {
              harnessId: "claude",
              slug: "claude-opus-4-7",
              label: "Claude Opus",
              description: null,
              contextWindow: null,
              maxOutputTokens: null,
              defaultReasoningEffort: null,
              supportedReasoningEfforts: [],
              defaultServiceTier: null,
              supportedServiceTiers: [],
              metadata: {},
            },
          ],
        }
      : undefined,
    isPending: !dialogMocks.modelsLoaded,
  }),
}));

import { ChatForkDialog, type ChatForkDialogTarget } from "../chat-fork-dialog";
import {
  pendingForkChatStagingKey,
  useWorktreeIntentStagingStore,
} from "@/stores/worktree/worktree-intent-staging-store";
import { useSeededWorkspaceSnapshotStore } from "@/stores/worktree/seeded-workspace-snapshot-store";

function buildHostClient(hostId: string): HostClient<HostRpcRegistry> {
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `req-${hostId}`,
      handlers: {},
    }),
  });
  client.bind({
    hostId,
    label: hostId,
    kind: "local",
    websocketUrl: `ws://127.0.0.1:0/${hostId}`,
    version: "0.0.0-mock",
    transportDialability: "dialable",
  });
  return client;
}

function directoryEntry(hostId: string, label: string): HostDirectoryEntry {
  return {
    hostId,
    label,
    kind: "local",
    websocketUrl: `ws://127.0.0.1:0/${hostId}`,
    version: "0.0.0-mock",
    transportDialability: "dialable",
  };
}

const TAB_HOST_CLIENT = buildHostClient(TAB_HOST_ID);
const OTHER_HOST_CLIENT = buildHostClient(OTHER_HOST_ID);
const UNKNOWN_HOST_CLIENT = buildHostClient(UNKNOWN_HOST_ID);
const OLD_HOST_CLIENT = buildHostClient(OLD_HOST_ID);
const ABSENT_HOST_CLIENT = buildHostClient(ABSENT_HOST_ID);

const SETTINGS_SEED: ChatRunSettings = {
  harnessId: "claude",
  model: "claude-opus-4-7",
  permissionMode: "supervised",
  reasoningEffort: "high",
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

const SOURCE_FOLDER = {
  path: "/repo/source",
  name: "source",
  repoIdentifier: null,
  hostId: null,
};

function forkTarget(
  overrides: Partial<ChatForkDialogTarget>,
): ChatForkDialogTarget {
  return {
    sourceChatId: "source-chat",
    sourceChatTitle: "Source chat",
    assistantMessageId: "assistant-message-1",
    interviewBlockId: null,
    parentId: null,
    settingsSeed: SETTINGS_SEED,
    workspaceSeed: {
      workspace: {
        folders: [SOURCE_FOLDER.path],
        folderInfoByPath: { [SOURCE_FOLDER.path]: SOURCE_FOLDER },
        primaryPath: SOURCE_FOLDER.path,
      },
      intent: {
        entries: [
          {
            kind: "local",
            workspacePath: SOURCE_FOLDER.path,
            repoIdentifier: null,
            isPrimary: true,
          },
        ],
      },
    },
    seedIntentOverride: null,
    carriedInterviews: "settled",
    forkMode: "plain",
    ...overrides,
  };
}

function abForkTarget(): ChatForkDialogTarget {
  return forkTarget({
    forkMode: "ab-worktree",
    seedIntentOverride: "worktree-carry",
    carriedInterviews: "pending",
  });
}

function ignoreOpenChange(open: boolean): void {
  void open;
}

function renderDialog(
  target: ChatForkDialogTarget,
  onOpenChange: (open: boolean) => void,
): RenderResult {
  return render(
    <ChatForkDialog
      open
      target={target}
      epicId="epic-test"
      tabId="tab-test"
      onOpenChange={onOpenChange}
    />,
  );
}

function dialogProps(
  target: ChatForkDialogTarget,
  onOpenChange: (open: boolean) => void,
  open: boolean,
): {
  readonly open: boolean;
  readonly target: ChatForkDialogTarget;
  readonly epicId: string;
  readonly tabId: string;
  readonly onOpenChange: (open: boolean) => void;
} {
  return {
    open,
    target,
    epicId: "epic-test",
    tabId: "tab-test",
    onOpenChange,
  };
}

function failedForkVariables(
  hostId: string,
  target: ChatForkDialogTarget,
): CreateVariables {
  return {
    hostId,
    forkSource: {
      boundary: "assistantMessage",
      sourceChatId: target.sourceChatId,
      assistantMessageId: target.assistantMessageId,
    },
  };
}

function fillTitle(): void {
  fireEvent.change(screen.getByRole("textbox", { name: "Fork agent title" }), {
    target: { value: "Sibling fork" },
  });
}

function forkButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>("button", { name: "Fork" });
}

async function submitFork(): Promise<ChatForkCreateInput> {
  fillTitle();
  fireEvent.click(forkButton());
  await waitFor(() => {
    expect(dialogMocks.createMutate).toHaveBeenCalled();
  });
  return dialogMocks.createMutate.mock.calls[0][0];
}

function selectedUnselectableExceptHostId(): string | null | undefined {
  const scope = dialogMocks.lastWorkspace?.hostScope;
  return scope?.kind === "selected"
    ? scope.unselectableExceptHostId
    : undefined;
}

function selectedRefusalWord(hostId: string): string | undefined {
  const scope = dialogMocks.lastWorkspace?.hostScope;
  return scope?.kind === "selected"
    ? scope.refusalByHostId.get(hostId)
    : undefined;
}

function advertiseSourcePublication(): void {
  recordNegotiatedHostManifest(TAB_HOST_ID, {
    "epic.createChat": { major: 1, minor: 2 },
    "epic.chatPublicationState": { major: 1, minor: 0 },
  });
}

function advertiseSourceWithoutPublication(): void {
  recordNegotiatedHostManifest(TAB_HOST_ID, {
    "epic.createChat": { major: 1, minor: 2 },
  });
}

function seedHostSlot(hostId: string, path: string): void {
  const stagingKey = pendingForkChatStagingKey(hostId, "epic-test");
  const folder = {
    path,
    name: path.split("/").pop() ?? path,
    repoIdentifier: null,
    hostId: null,
  };
  useSeededWorkspaceSnapshotStore.getState().setSnapshot(stagingKey, {
    folders: [folder.path],
    folderInfoByPath: { [folder.path]: folder },
    primaryPath: folder.path,
  });
  useWorktreeIntentStagingStore.getState().setIntent(stagingKey, {
    entries: [
      {
        kind: "local",
        workspacePath: folder.path,
        repoIdentifier: null,
        isPrimary: true,
      },
    ],
  });
}

describe("ChatForkDialog cross-host routing", () => {
  beforeEach(() => {
    dialogMocks.createMutate.mockReset();
    dialogMocks.selectById.mockReset();
    dialogMocks.lastCreateClient = null;
    dialogMocks.createPending = false;
    dialogMocks.createError = null;
    dialogMocks.createVariables = null;
    dialogMocks.createReset.mockReset();
    dialogMocks.createReset.mockImplementation(() => {
      dialogMocks.createError = null;
      dialogMocks.createVariables = null;
    });
    dialogMocks.capabilityProbeHostIds.clear();
    dialogMocks.modelsLoaded = true;
    dialogMocks.publicationQuery = { data: undefined };
    dialogMocks.publicationQueryEnabled = false;
    dialogMocks.publicationQueryIsError = false;
    dialogMocks.publicationQueryIsFetching = false;
    dialogMocks.lastWorkspace = null;
    dialogMocks.cloneOwnerCalls = [];
    dialogMocks.clientsByHostId.clear();
    dialogMocks.clientsByHostId.set(TAB_HOST_ID, TAB_HOST_CLIENT);
    dialogMocks.clientsByHostId.set(OTHER_HOST_ID, OTHER_HOST_CLIENT);
    dialogMocks.clientsByHostId.set(UNKNOWN_HOST_ID, UNKNOWN_HOST_CLIENT);
    dialogMocks.clientsByHostId.set(OLD_HOST_ID, OLD_HOST_CLIENT);
    dialogMocks.clientsByHostId.set(ABSENT_HOST_ID, ABSENT_HOST_CLIENT);
    dialogMocks.directoryHosts = [
      directoryEntry(TAB_HOST_ID, "Tab host"),
      directoryEntry(OTHER_HOST_ID, "Other host"),
      directoryEntry(UNKNOWN_HOST_ID, "Unknown host"),
      directoryEntry(OLD_HOST_ID, "Old host"),
      directoryEntry(ABSENT_HOST_ID, "Absent host"),
    ];
    recordNegotiatedHostManifest(OTHER_HOST_ID, {
      "epic.createChat": { major: 1, minor: 2 },
    });
    recordNegotiatedHostManifest(OLD_HOST_ID, {
      "epic.createChat": { major: 1, minor: 1 },
    });
    recordNegotiatedHostManifest(ABSENT_HOST_ID, {
      "epic.listChats": { major: 1, minor: 0 },
    });
    useWorktreeIntentStagingStore.getState().resetForTests();
    useSeededWorkspaceSnapshotStore.getState().resetForTests();
  });

  afterEach(() => {
    resetNegotiatedManifests();
    useWorktreeIntentStagingStore.getState().resetForTests();
    useSeededWorkspaceSnapshotStore.getState().resetForTests();
    cleanup();
  });

  it("same-host default: payload hostId is the tab host and create uses the tab client", async () => {
    renderDialog(forkTarget({}), ignoreOpenChange);

    const request = await submitFork();
    expect(request.hostId).toBe(TAB_HOST_ID);
    expect(dialogMocks.lastCreateClient).toBe(TAB_HOST_CLIENT);
    expect(dialogMocks.selectById).not.toHaveBeenCalled();
    expect(request.forkSource.sourceOwnerUserId).toBeNull();
  });

  it("picking another host never calls directory.selectById and submits on that host's client", async () => {
    renderDialog(forkTarget({}), ignoreOpenChange);

    fireEvent.click(screen.getByTestId(`fork-host-${OTHER_HOST_ID}`));

    expect(dialogMocks.selectById).not.toHaveBeenCalled();
    expect(dialogMocks.lastWorkspace?.hostScope.kind).toBe("selected");

    const request = await submitFork();
    expect(request.hostId).toBe(OTHER_HOST_ID);
    expect(dialogMocks.lastCreateClient).toBe(OTHER_HOST_CLIENT);
    expect(dialogMocks.selectById).not.toHaveBeenCalled();
  });

  it("an unknown handshake does not render needs-update and leaves the row selectable", async () => {
    renderDialog(forkTarget({}), ignoreOpenChange);

    const unknownRow = screen.getByTestId(`fork-host-${UNKNOWN_HOST_ID}`);
    expect(unknownRow instanceof HTMLButtonElement && unknownRow.disabled).toBe(
      false,
    );
    expect(
      screen.queryByTestId(`fork-host-refusal-${UNKNOWN_HOST_ID}`),
    ).toBeNull();
    expect(unknownRow.textContent).not.toContain("needs update");

    fireEvent.click(unknownRow);
    fillTitle();
    expect(forkButton().disabled).toBe(false);
    const request = await submitFork();
    expect(request.hostId).toBe(UNKNOWN_HOST_ID);
  });

  it("a 1.1 host and a negotiated-absent host are disabled with needs update", () => {
    renderDialog(forkTarget({}), ignoreOpenChange);
    fillTitle();

    const oldRow = screen.getByTestId(`fork-host-${OLD_HOST_ID}`);
    const absentRow = screen.getByTestId(`fork-host-${ABSENT_HOST_ID}`);
    expect(oldRow instanceof HTMLButtonElement && oldRow.disabled).toBe(true);
    expect(absentRow instanceof HTMLButtonElement && absentRow.disabled).toBe(
      true,
    );
    expect(
      screen.getByTestId(`fork-host-refusal-${OLD_HOST_ID}`).textContent,
    ).toContain("needs update");
    expect(
      screen.getByTestId(`fork-host-refusal-${ABSENT_HOST_ID}`).textContent,
    ).toContain("needs update");
    expect(forkButton().disabled).toBe(false);
    // hostRefused is per-row: the remote CLASS stays selectable. Folding
    // this into unselectableExceptHostId would disable every remote for one
    // old host.
    expect(selectedUnselectableExceptHostId()).toBeNull();
  });

  it("folders staged against host A never reach a submit against host B", async () => {
    seedHostSlot(TAB_HOST_ID, "/repo/on-tab");
    seedHostSlot(OTHER_HOST_ID, "/repo/on-other");
    renderDialog(forkTarget({}), ignoreOpenChange);

    const sameHost = await submitFork();
    expect(sameHost.hostId).toBe(TAB_HOST_ID);
    expect(sameHost.worktreeIntent).toEqual({
      entries: [
        {
          kind: "local",
          workspacePath: "/repo/on-tab",
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    });

    dialogMocks.createMutate.mockReset();
    fireEvent.click(screen.getByTestId(`fork-host-${OTHER_HOST_ID}`));
    const crossHost = await submitFork();
    expect(crossHost.hostId).toBe(OTHER_HOST_ID);
    expect(crossHost.worktreeIntent).toEqual({
      entries: [
        {
          kind: "local",
          workspacePath: "/repo/on-other",
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    });
  });

  it("closing the dialog clears every host slot it staged into", () => {
    renderDialog(forkTarget({}), ignoreOpenChange);
    seedHostSlot(TAB_HOST_ID, "/repo/on-tab");
    fireEvent.click(screen.getByTestId(`fork-host-${OTHER_HOST_ID}`));
    seedHostSlot(OTHER_HOST_ID, "/repo/on-other");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(useWorktreeIntentStagingStore.getState().intentByKey).toEqual({});
    expect(useSeededWorkspaceSnapshotStore.getState().snapshotByKey).toEqual(
      {},
    );
  });

  it("cross-host resets the workspace to an empty seed, drops A/B override, and does not apply the staged-preselection gate", async () => {
    renderDialog(abForkTarget(), ignoreOpenChange);

    expect(dialogMocks.lastWorkspace?.workspaceSeed).toEqual(
      expect.objectContaining({
        folders: [SOURCE_FOLDER.path],
      }),
    );
    expect(dialogMocks.lastWorkspace?.seedIntentOverride).toBe(
      "worktree-carry",
    );
    expect(dialogMocks.lastWorkspace?.workspaceSeed).not.toBeNull();
    fillTitle();
    // Same-host A/B waits for a staged pre-selection. Empty title is already
    // filled so this disable is the gate, not a missing name.
    expect(forkButton().disabled).toBe(true);

    fireEvent.click(screen.getByTestId(`fork-host-${OTHER_HOST_ID}`));

    expect(dialogMocks.lastWorkspace?.workspaceSeed).toEqual(
      emptyLandingDraftWorkspaceSnapshot(),
    );
    expect(dialogMocks.lastWorkspace?.workspaceSeed).not.toBeNull();
    expect(dialogMocks.lastWorkspace?.seedIntent).toBeNull();
    expect(dialogMocks.lastWorkspace?.seedIntentOverride).toBeNull();
    expect(
      screen.getByTestId("chat-fork-carry-changes-disabled").textContent,
    ).toContain(
      "Uncommitted changes stay on the source machine, so this fork starts from the workspace you pick here.",
    );
    expect(forkButton().disabled).toBe(false);

    const request = await submitFork();
    expect(request.hostId).toBe(OTHER_HOST_ID);
  });

  it("B → C → B restores B's retained folders, not a fresh empty seed", async () => {
    seedHostSlot(OTHER_HOST_ID, "/repo/on-b");
    renderDialog(forkTarget({}), ignoreOpenChange);

    fireEvent.click(screen.getByTestId(`fork-host-${OTHER_HOST_ID}`));
    expect(dialogMocks.lastWorkspace?.workspaceSeed?.folders).toEqual([
      "/repo/on-b",
    ]);

    fireEvent.click(screen.getByTestId(`fork-host-${UNKNOWN_HOST_ID}`));
    expect(dialogMocks.lastWorkspace?.workspaceSeed).toEqual(
      emptyLandingDraftWorkspaceSnapshot(),
    );

    fireEvent.click(screen.getByTestId(`fork-host-${OTHER_HOST_ID}`));
    // Ablation: a manufactured-per-visit empty seed would pass "some seed
    // exists" and fail this — B's folder must still be the seed.
    expect(dialogMocks.lastWorkspace?.workspaceSeed?.folders).toEqual([
      "/repo/on-b",
    ]);

    const request = await submitFork();
    expect(request.hostId).toBe(OTHER_HOST_ID);
    expect(request.worktreeIntent).toEqual({
      entries: [
        {
          kind: "local",
          workspacePath: "/repo/on-b",
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    });
  });

  it("A → B → A restores the source host's retained folders, not the chat seed", async () => {
    // A folder the source chat never had. Re-deriving from
    // `target.workspaceSeed` on the way back would restore `/repo/source`
    // and this would fail.
    seedHostSlot(TAB_HOST_ID, "/repo/added-on-a");
    renderDialog(forkTarget({}), ignoreOpenChange);

    expect(dialogMocks.lastWorkspace?.workspaceSeed?.folders).toEqual([
      "/repo/added-on-a",
    ]);

    fireEvent.click(screen.getByTestId(`fork-host-${OTHER_HOST_ID}`));
    fireEvent.click(screen.getByTestId(`fork-host-${TAB_HOST_ID}`));

    expect(dialogMocks.lastWorkspace?.workspaceSeed?.folders).toEqual([
      "/repo/added-on-a",
    ]);
    expect(dialogMocks.lastWorkspace?.workspaceSeed?.folders).not.toEqual([
      SOURCE_FOLDER.path,
    ]);

    const request = await submitFork();
    expect(request.hostId).toBe(TAB_HOST_ID);
    expect(request.worktreeIntent).toEqual({
      entries: [
        {
          kind: "local",
          workspacePath: "/repo/added-on-a",
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    });
  });

  it("a loading catalog blocks a CROSS-HOST fork but not a same-host one", () => {
    // The retarget window: the toolbar store still carries the source host's
    // slug while the newly-selected host's models are in flight. Submitting
    // there sends a model the target may not provide.
    dialogMocks.modelsLoaded = false;
    renderDialog(forkTarget({}), ignoreOpenChange);
    fillTitle();

    // Same-host is unaffected - the slug came from THIS host's memory, and the
    // memory write gate is catalog confirmation itself, so it was confirmed when
    // it was recorded. Requiring confirmation again here would disable a fork
    // whenever the models query merely detaches, with no way back.
    expect(forkButton().disabled).toBe(false);

    const scope = dialogMocks.lastWorkspace?.hostScope;
    expect(scope?.kind).toBe("selected");
    if (scope?.kind === "selected") {
      act(() => {
        scope.onSelect(OTHER_HOST_ID);
      });
    }

    expect(forkButton().disabled).toBe(true);
  });

  it("a 1.1 refusal flips to selectable after the host is recorded at 1.2, with no interaction", () => {
    renderDialog(forkTarget({}), ignoreOpenChange);
    fillTitle();

    // Live from the moment the dialog opens, against a row nobody selected.
    //
    // This is the whole fix: a refused row is `aria-disabled`, so it can NEVER
    // become `selectedHostId` - a probe gated on the selected host's refusal
    // could only ever re-ask about the source host, and the target wearing the
    // "needs update" word would keep it forever, because the reads that would
    // re-handshake are the ones its own refusal turned off. The previous
    // spelling of this test had to reach past the UI and call `onSelect`
    // directly to see the probe at all, which was the defect stated as a
    // workaround.
    expect(dialogMocks.capabilityProbeHostIds.has(OLD_HOST_ID)).toBe(true);
    // The 1.2 host is not re-asked about - only the ones with something to
    // learn - so this is a bounded refresh rather than a read per row.
    expect(dialogMocks.capabilityProbeHostIds.has(OTHER_HOST_ID)).toBe(false);

    const oldRow = screen.getByTestId(`fork-host-${OLD_HOST_ID}`);
    expect(oldRow instanceof HTMLButtonElement && oldRow.disabled).toBe(true);
    expect(
      screen.getByTestId(`fork-host-refusal-${OLD_HOST_ID}`).textContent,
    ).toContain("needs update");

    // Cleared so the next render's probes repopulate it, and the assertions
    // below describe what is live AFTER the upgrade rather than ever having
    // been live. Unmounting cannot retract an entry on its own: a probe that
    // stops rendering simply stops calling the mocked hook.
    dialogMocks.capabilityProbeHostIds.clear();
    act(() => {
      recordNegotiatedHostManifest(OLD_HOST_ID, {
        "epic.createChat": { major: 1, minor: 2 },
      });
    });

    const upgraded = screen.getByTestId(`fork-host-${OLD_HOST_ID}`);
    expect(upgraded instanceof HTMLButtonElement && upgraded.disabled).toBe(
      false,
    );
    expect(screen.queryByTestId(`fork-host-refusal-${OLD_HOST_ID}`)).toBeNull();
    expect(forkButton().disabled).toBe(false);
    // The healed row stops being re-asked about; the still-refused one does not.
    // A single "is any probe live" flag could not tell these apart, and would
    // read as `true` here for the wrong reason.
    expect(dialogMocks.capabilityProbeHostIds.has(OLD_HOST_ID)).toBe(false);
    expect(dialogMocks.capabilityProbeHostIds.has(ABSENT_HOST_ID)).toBe(true);
  });

  it("keeps the dialog open on E_FORK_BOUNDARY_NOT_PUBLISHED and scopes the notice to that host", () => {
    const target = forkTarget({});
    const onOpenChange = vi.fn();
    const view = renderDialog(target, onOpenChange);
    dialogMocks.createError = { code: "E_FORK_BOUNDARY_NOT_PUBLISHED" };
    dialogMocks.createVariables = failedForkVariables(OTHER_HOST_ID, target);
    view.rerender(
      <ChatForkDialog {...dialogProps(target, onOpenChange, true)} />,
    );

    // Default selection is the tab host. The refusal was earned against the
    // other host, so the notice must not appear here — a same-host fork is
    // served from the local store and no publication is involved.
    expect(screen.queryByTestId("chat-fork-boundary-not-published")).toBeNull();

    fireEvent.click(screen.getByTestId(`fork-host-${OTHER_HOST_ID}`));
    const notice = screen.getByTestId("chat-fork-boundary-not-published");
    expect(notice.textContent).toContain(
      "Still syncing this turn to the cloud — retry shortly.",
    );
    expect(
      screen.queryByRole("textbox", { name: "Fork agent title" }),
    ).not.toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId(`fork-host-${TAB_HOST_ID}`));
    expect(screen.queryByTestId("chat-fork-boundary-not-published")).toBeNull();

    fireEvent.click(screen.getByTestId(`fork-host-${OTHER_HOST_ID}`));
    expect(
      screen.queryByTestId("chat-fork-boundary-not-published"),
    ).not.toBeNull();
  });

  it("does not show the boundary notice for any other error code", () => {
    const target = forkTarget({});
    const view = renderDialog(target, ignoreOpenChange);
    dialogMocks.createError = { code: "RPC_ERROR" };
    dialogMocks.createVariables = failedForkVariables(OTHER_HOST_ID, target);
    view.rerender(
      <ChatForkDialog {...dialogProps(target, ignoreOpenChange, true)} />,
    );
    fireEvent.click(screen.getByTestId(`fork-host-${OTHER_HOST_ID}`));
    expect(screen.queryByTestId("chat-fork-boundary-not-published")).toBeNull();
  });

  it("drops M1's boundary notice when the dialog reopens on M2 at the same host", () => {
    const first = forkTarget({ assistantMessageId: "assistant-m1" });
    const second = forkTarget({ assistantMessageId: "assistant-m2" });
    const view = renderDialog(first, ignoreOpenChange);
    dialogMocks.createError = { code: "E_FORK_BOUNDARY_NOT_PUBLISHED" };
    dialogMocks.createVariables = failedForkVariables(OTHER_HOST_ID, first);
    view.rerender(
      <ChatForkDialog {...dialogProps(first, ignoreOpenChange, true)} />,
    );
    fireEvent.click(screen.getByTestId(`fork-host-${OTHER_HOST_ID}`));
    expect(
      screen.queryByTestId("chat-fork-boundary-not-published"),
    ).not.toBeNull();

    view.rerender(
      <ChatForkDialog {...dialogProps(first, ignoreOpenChange, false)} />,
    );
    expect(dialogMocks.createReset).toHaveBeenCalled();

    view.rerender(
      <ChatForkDialog {...dialogProps(second, ignoreOpenChange, true)} />,
    );
    fireEvent.click(screen.getByTestId(`fork-host-${OTHER_HOST_ID}`));
    expect(screen.queryByTestId("chat-fork-boundary-not-published")).toBeNull();
  });

  it("hides M1's notice on M2 from the boundary clause even when reset does not clear", () => {
    // Ablation: reset is a no-op. If the notice is gone, only the
    // sourceChatId/assistantMessageId match can be responsible.
    dialogMocks.createReset.mockImplementation(() => undefined);

    const first = forkTarget({ assistantMessageId: "assistant-m1" });
    const second = forkTarget({ assistantMessageId: "assistant-m2" });
    const view = renderDialog(first, ignoreOpenChange);
    dialogMocks.createError = { code: "E_FORK_BOUNDARY_NOT_PUBLISHED" };
    dialogMocks.createVariables = failedForkVariables(OTHER_HOST_ID, first);
    view.rerender(
      <ChatForkDialog {...dialogProps(first, ignoreOpenChange, true)} />,
    );
    fireEvent.click(screen.getByTestId(`fork-host-${OTHER_HOST_ID}`));
    expect(
      screen.queryByTestId("chat-fork-boundary-not-published"),
    ).not.toBeNull();

    view.rerender(
      <ChatForkDialog {...dialogProps(first, ignoreOpenChange, false)} />,
    );
    view.rerender(
      <ChatForkDialog {...dialogProps(second, ignoreOpenChange, true)} />,
    );
    fireEvent.click(screen.getByTestId(`fork-host-${OTHER_HOST_ID}`));

    expect(dialogMocks.createError).toEqual({
      code: "E_FORK_BOUNDARY_NOT_PUBLISHED",
    });
    expect(dialogMocks.createVariables).toEqual(
      failedForkVariables(OTHER_HOST_ID, first),
    );
    expect(screen.queryByTestId("chat-fork-boundary-not-published")).toBeNull();
  });

  it("clears a same-target reopen because reset dropped the previous evidence", () => {
    const first = forkTarget({ assistantMessageId: "assistant-m1" });
    const view = renderDialog(first, ignoreOpenChange);
    dialogMocks.createError = { code: "E_FORK_BOUNDARY_NOT_PUBLISHED" };
    dialogMocks.createVariables = failedForkVariables(OTHER_HOST_ID, first);
    view.rerender(
      <ChatForkDialog {...dialogProps(first, ignoreOpenChange, true)} />,
    );
    fireEvent.click(screen.getByTestId(`fork-host-${OTHER_HOST_ID}`));
    expect(
      screen.queryByTestId("chat-fork-boundary-not-published"),
    ).not.toBeNull();

    view.rerender(
      <ChatForkDialog {...dialogProps(first, ignoreOpenChange, false)} />,
    );
    expect(dialogMocks.createReset).toHaveBeenCalled();
    expect(dialogMocks.createError).toBeNull();
    expect(dialogMocks.createVariables).toBeNull();

    view.rerender(
      <ChatForkDialog {...dialogProps(first, ignoreOpenChange, true)} />,
    );
    fireEvent.click(screen.getByTestId(`fork-host-${OTHER_HOST_ID}`));
    expect(screen.queryByTestId("chat-fork-boundary-not-published")).toBeNull();
  });

  it("unpublished chat: one dialog notice, silent remote rows, class inert, inert click is a no-op", () => {
    advertiseSourcePublication();
    dialogMocks.publicationQuery = {
      data: {
        published: false,
        boundaryCovered: null,
        publishedThroughTs: null,
      },
    };
    renderDialog(forkTarget({}), ignoreOpenChange);
    fillTitle();

    const notices = screen.getAllByTestId("chat-fork-publication-notice");
    expect(notices).toHaveLength(1);
    expect(notices[0].textContent).toContain(
      "This chat hasn't been backed up yet, so another machine can't read its history.",
    );

    // Ablation: the class-level inertness is NOT a per-row refusal. If the
    // notice were stamped onto each host, this would fail.
    expect(selectedRefusalWord(OTHER_HOST_ID)).toBeUndefined();
    expect(selectedRefusalWord(UNKNOWN_HOST_ID)).toBeUndefined();
    expect(
      screen.queryByTestId(`fork-host-refusal-${OTHER_HOST_ID}`),
    ).toBeNull();
    expect(
      screen.queryByTestId(`fork-host-refusal-${UNKNOWN_HOST_ID}`),
    ).toBeNull();
    expect(selectedUnselectableExceptHostId()).toBe(TAB_HOST_ID);

    const otherRow = screen.getByTestId(`fork-host-${OTHER_HOST_ID}`);
    const unknownRow = screen.getByTestId(`fork-host-${UNKNOWN_HOST_ID}`);
    const tabRow = screen.getByTestId(`fork-host-${TAB_HOST_ID}`);
    expect(otherRow instanceof HTMLButtonElement && otherRow.disabled).toBe(
      true,
    );
    expect(unknownRow instanceof HTMLButtonElement && unknownRow.disabled).toBe(
      true,
    );
    expect(tabRow instanceof HTMLButtonElement && tabRow.disabled).toBe(false);
    // Selection is still the tab host. A local fork is served from the store
    // tier, so Fork stays enabled — blocking it would be a cloud fact
    // refusing a local submit.
    expect(forkButton().disabled).toBe(false);

    // An inert remote cannot become the target. fireEvent still delivers
    // the click; the mock must refuse it the way a real row would.
    fireEvent.click(otherRow);
    const scope = dialogMocks.lastWorkspace?.hostScope;
    expect(scope?.kind === "selected" ? scope.hostId : null).toBe(TAB_HOST_ID);
    expect(dialogMocks.createMutate).not.toHaveBeenCalled();
  });

  it("boundarySyncing: notice speaks, rows stay selectable, submit is blocked", () => {
    // Clicking OTHER_HOST_ID makes this a CROSS-HOST fork, and
    // `chatForkTargetVerdict` only reaches the `boundaryUncovered` arm (→
    // `boundarySyncing`) when `isCrossHost` is true — a same-host fork
    // short-circuits to `allowed` before this check ever runs (see the
    // sibling first-paint test below, which stays same-host). `boundarySyncing`
    // is no longer exempt from `verdictAllowsSubmit`: the host's coverage
    // check is presence-only, so an uncovered boundary can be ACCEPTED and
    // seed a truncated turn, and submit must block on it like every other
    // refusal now.
    advertiseSourcePublication();
    dialogMocks.publicationQuery = {
      data: {
        published: true,
        boundaryCovered: false,
        publishedThroughTs: 1_700_000_000_000,
      },
    };
    renderDialog(forkTarget({}), ignoreOpenChange);

    fireEvent.click(screen.getByTestId(`fork-host-${OTHER_HOST_ID}`));
    fillTitle();

    const notice = screen.getByTestId("chat-fork-publication-notice");
    expect(notice.textContent).toContain(
      "Still syncing this turn to the cloud — forking to another machine unlocks as soon as it lands.",
    );
    expect(selectedUnselectableExceptHostId()).toBeNull();
    expect(selectedRefusalWord(OTHER_HOST_ID)).toBeUndefined();

    // The distinction this state carries is over the ROW, not the button:
    // the row stays selectable because nothing is wrong with the host and
    // the wait is seconds long, so killing the row would throw away the
    // configuration the user is about to be allowed to submit.
    const otherRow = screen.getByTestId(`fork-host-${OTHER_HOST_ID}`);
    expect(otherRow instanceof HTMLButtonElement && otherRow.disabled).toBe(
      false,
    );
    expect(forkButton().disabled).toBe(true);

    fireEvent.click(forkButton());
    expect(dialogMocks.createMutate).not.toHaveBeenCalled();
  });

  it("boundarySyncing sentence is on first paint with no host selected", () => {
    // Sibling of the unpublished first-paint case. The class resolver
    // (`chatForkRemoteClassState`) returns `syncing` with no `isCrossHost`
    // input, so the sentence must not wait for a highlight.
    //
    // No host is selected here, so the highlighted target is the tab's own
    // host and this is a SAME-HOST fork. `chatForkTargetVerdict` short-
    // circuits `!isCrossHost` to `{ kind: "allowed" }` before it ever looks
    // at `publication` (chat-fork-target.ts:403), so the submit gate never
    // sees `boundarySyncing` here and the button stays enabled — unlike the
    // sibling test above, which selects OTHER_HOST_ID, makes the fork
    // cross-host, and gets blocked. The two are not contradicting each
    // other: this pair is what pins the same-host exemption.
    advertiseSourcePublication();
    dialogMocks.publicationQuery = {
      data: {
        published: true,
        boundaryCovered: false,
        publishedThroughTs: 1_700_000_000_000,
      },
    };
    renderDialog(forkTarget({}), ignoreOpenChange);
    fillTitle();

    const notice = screen.getByTestId("chat-fork-publication-notice");
    expect(notice.textContent).toContain(
      "Still syncing this turn to the cloud — forking to another machine unlocks as soon as it lands.",
    );
    expect(selectedUnselectableExceptHostId()).toBeNull();
    const otherRow = screen.getByTestId(`fork-host-${OTHER_HOST_ID}`);
    expect(otherRow instanceof HTMLButtonElement && otherRow.disabled).toBe(
      false,
    );
    expect(forkButton().disabled).toBe(false);
  });

  it("a source host that does not advertise the method issues no request and stays post-A4", async () => {
    // Ablation: the mock is primed with unpublished. If a request were
    // issued, remotes would go inert and this submit would fail. Passing
    // therefore credits the capability gate, not "data happened to be unknown".
    advertiseSourceWithoutPublication();
    dialogMocks.publicationQuery = {
      data: {
        published: false,
        boundaryCovered: null,
        publishedThroughTs: null,
      },
    };
    renderDialog(forkTarget({}), ignoreOpenChange);

    fireEvent.click(screen.getByTestId(`fork-host-${OTHER_HOST_ID}`));
    fillTitle();

    expect(dialogMocks.publicationQueryEnabled).toBe(false);
    expect(screen.queryByTestId("chat-fork-publication-notice")).toBeNull();
    expect(selectedUnselectableExceptHostId()).toBeNull();

    const otherRow = screen.getByTestId(`fork-host-${OTHER_HOST_ID}`);
    expect(otherRow instanceof HTMLButtonElement && otherRow.disabled).toBe(
      false,
    );
    expect(forkButton().disabled).toBe(false);

    const request = await submitFork();
    expect(request.hostId).toBe(OTHER_HOST_ID);
  });

  it("unpublished is known on first paint with no remote host selected", () => {
    // Ablation: the old gate keyed `enabled` on `isCrossHost`, so this
    // moment — default selection is the tab host — would have
    // `publicationQueryEnabled === false` and no notice. Passing here
    // credits `hasRemoteHostOption`, not a later click.
    advertiseSourcePublication();
    dialogMocks.publicationQuery = {
      data: {
        published: false,
        boundaryCovered: null,
        publishedThroughTs: null,
      },
    };
    renderDialog(forkTarget({}), ignoreOpenChange);

    expect(dialogMocks.publicationQueryEnabled).toBe(true);
    const notices = screen.getAllByTestId("chat-fork-publication-notice");
    expect(notices).toHaveLength(1);
    expect(notices[0].textContent).toContain(
      "This chat hasn't been backed up yet, so another machine can't read its history.",
    );
    expect(selectedUnselectableExceptHostId()).toBe(TAB_HOST_ID);
    expect(selectedRefusalWord(OTHER_HOST_ID)).toBeUndefined();
    expect(
      screen.queryByTestId(`fork-host-refusal-${OTHER_HOST_ID}`),
    ).toBeNull();
    const otherRow = screen.getByTestId(`fork-host-${OTHER_HOST_ID}`);
    expect(otherRow instanceof HTMLButtonElement && otherRow.disabled).toBe(
      true,
    );
    const scope = dialogMocks.lastWorkspace?.hostScope;
    expect(scope?.kind === "selected" ? scope.hostId : null).toBe(TAB_HOST_ID);

    // F2: a 1.1 / negotiated-absent row is still in the directory. Inert
    // leads, so those rows must not also carry "needs update".
    const oldRow = screen.getByTestId(`fork-host-${OLD_HOST_ID}`);
    const absentRow = screen.getByTestId(`fork-host-${ABSENT_HOST_ID}`);
    expect(oldRow instanceof HTMLButtonElement && oldRow.disabled).toBe(true);
    expect(absentRow instanceof HTMLButtonElement && absentRow.disabled).toBe(
      true,
    );
    expect(screen.queryByTestId(`fork-host-refusal-${OLD_HOST_ID}`)).toBeNull();
    expect(
      screen.queryByTestId(`fork-host-refusal-${ABSENT_HOST_ID}`),
    ).toBeNull();
  });

  it("a single-host account does not ask publication and does not inert anything", () => {
    // Ablation: primed unpublished. If `enabled` were only
    // `activeWorkspaceTarget !== null`, the query would fire and this
    // would still look quiet only because the same-host verdict
    // short-circuits — `publicationQueryEnabled === false` is the
    // half that pins the RPC staying off.
    advertiseSourcePublication();
    dialogMocks.publicationQuery = {
      data: {
        published: false,
        boundaryCovered: null,
        publishedThroughTs: null,
      },
    };
    dialogMocks.directoryHosts = [directoryEntry(TAB_HOST_ID, "Tab host")];
    renderDialog(forkTarget({}), ignoreOpenChange);

    expect(dialogMocks.publicationQueryEnabled).toBe(false);
    expect(screen.queryByTestId("chat-fork-publication-notice")).toBeNull();
    expect(selectedUnselectableExceptHostId()).toBeNull();
    const tabRow = screen.getByTestId(`fork-host-${TAB_HOST_ID}`);
    expect(tabRow instanceof HTMLButtonElement && tabRow.disabled).toBe(false);
  });

  it("a cached unpublished answer is unknown once the query is disabled or errors", () => {
    advertiseSourcePublication();
    dialogMocks.publicationQuery = {
      data: {
        published: false,
        boundaryCovered: null,
        publishedThroughTs: null,
      },
    };
    const target = forkTarget({});
    const view = renderDialog(target, ignoreOpenChange);
    expect(screen.getByTestId("chat-fork-publication-notice")).not.toBeNull();
    expect(selectedUnselectableExceptHostId()).toBe(TAB_HOST_ID);

    dialogMocks.publicationQueryIsError = true;
    view.rerender(
      <ChatForkDialog {...dialogProps(target, ignoreOpenChange, true)} />,
    );

    expect(dialogMocks.publicationQuery.data?.published).toBe(false);
    expect(screen.queryByTestId("chat-fork-publication-notice")).toBeNull();
    expect(selectedUnselectableExceptHostId()).toBeNull();
    const otherRow = screen.getByTestId(`fork-host-${OTHER_HOST_ID}`);
    expect(otherRow instanceof HTMLButtonElement && otherRow.disabled).toBe(
      false,
    );
  });

  it("selecting a remote then learning unpublished disables Fork", () => {
    advertiseSourcePublication();
    const target = forkTarget({});
    const view = renderDialog(target, ignoreOpenChange);

    fireEvent.click(screen.getByTestId(`fork-host-${OTHER_HOST_ID}`));
    fillTitle();
    expect(forkButton().disabled).toBe(false);

    dialogMocks.publicationQuery = {
      data: {
        published: false,
        boundaryCovered: null,
        publishedThroughTs: null,
      },
    };
    view.rerender(
      <ChatForkDialog {...dialogProps(target, ignoreOpenChange, true)} />,
    );

    expect(forkButton().disabled).toBe(true);
    const scope = dialogMocks.lastWorkspace?.hostScope;
    expect(scope?.kind === "selected" ? scope.hostId : null).toBe(
      OTHER_HOST_ID,
    );
  });

  it("a cached unpublished answer is unknown while the query is fetching", () => {
    advertiseSourcePublication();
    dialogMocks.publicationQuery = {
      data: {
        published: false,
        boundaryCovered: null,
        publishedThroughTs: null,
      },
    };
    dialogMocks.publicationQueryIsFetching = true;
    renderDialog(forkTarget({}), ignoreOpenChange);

    expect(dialogMocks.publicationQueryEnabled).toBe(true);
    expect(dialogMocks.publicationQuery.data?.published).toBe(false);
    expect(screen.queryByTestId("chat-fork-publication-notice")).toBeNull();
    expect(selectedUnselectableExceptHostId()).toBeNull();
    const otherRow = screen.getByTestId(`fork-host-${OTHER_HOST_ID}`);
    expect(otherRow instanceof HTMLButtonElement && otherRow.disabled).toBe(
      false,
    );
  });
});

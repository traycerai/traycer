import {
  mountTestSelectionAuthority,
  type SelectionAuthorityFixture,
} from "@/lib/host/test-support/selection-authority-fixture";
import type { ModelOption } from "@/components/home/data/landing-options";
import { isValidElement, useRef, useState, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
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
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { SandboxCreateRequest } from "@traycer/protocol/host/sandbox-control";
import type { SandboxCreateFetchResult } from "@traycer-clients/shared/host-client/sandbox-control";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import type { EnvironmentCloud } from "@traycer-clients/shared/environment/environment-cloud";
import type { ActivationOutcome } from "@/components/settings/host-scope/use-host-scope";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import type { SandboxCatalogue } from "@traycer/protocol/host/sandbox-control";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { useAuthStore } from "@/stores/auth/auth-store";

import type { ComposerBodyProps } from "@/components/home/composer/composer-body";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import type { TerminalAgentLaunch } from "@/components/home/hooks/use-landing-composer-actions";
import { createComposerEditorIncarnation } from "@/lib/composer/composer-editor-incarnation";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import { emptyLandingDraftWorkspaceSnapshot } from "@/stores/home/landing-draft-store";
import type { WorkspaceFolderInfo } from "@/stores/workspace/workspace-folders-store";
import { persistKey, STORE_KEYS } from "@/lib/persist";
import {
  newConversationModalStagingKey,
  useWorktreeIntentStagingStore,
  worktreeStagingKeyString,
} from "@/stores/worktree/worktree-intent-staging-store";
import type { WorktreeIntent } from "@traycer/protocol/host/worktree-schemas";
import {
  newConversationSurfaceKey,
  notifyEffectiveHostChanged,
  useSurfaceHostSelectionStore,
} from "@/stores/host/surface-host-selection-store";
import { SurfacePresentationBoundary } from "@/components/layout/surface-presentation-boundary";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import { createAppQueryClient } from "@/lib/query-client";
import {
  teamSubscription,
  userSubscription,
  userWith,
} from "@/lib/sandboxes/__tests__/auth-user-fixture";
import { readinessCatalogue } from "@/lib/sandboxes/__tests__/sandbox-catalogue-fixture";
import { sandboxHostEntry } from "@/lib/sandboxes/__tests__/sandbox-host-directory-fixture";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import {
  NewConversationModalBody,
  NewConversationModalHost,
} from "../new-conversation-modal";
import { NewConversationTransientContext } from "../new-conversation-transient-context";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";
import { useAddHostDialogStore } from "@/stores/settings/add-host-dialog-store";
import { appendTerminalQuoteToNewConversationDraft } from "@/components/chat/quote/append-terminal-quote-to-draft";
import { readPoolComputerUnavailable } from "@/hooks/host/use-pool-computer-unavailable";

/**
 * The in-Epic new-conversation modal shares the landing composer's
 * placement SEMANTICS (one chip, one frozen submit client, one refusal),
 * resolved for its EPIC (`useEpicConversationPlacement`: per-Epic pin - the
 * Epic's last created chat's host - ?? the session's host ?? effective).
 *
 * These target the CALLER, not `resolveLandingPlacement` (already unit-tested):
 * the class of bug here is a caller that never asks, which no test of the
 * resolver can catch. The ordering assertions are the load-bearing ones —
 * `cleanupAfterSubmit` clears the draft, the staged workspace and the modal
 * SYNCHRONOUSLY, long before an async create could report failure, so a
 * refusal that arrives after it has run has already destroyed the user's work.
 */

const DIRTY_CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "dirty" }] }],
};

const NEW_CHAT_DRAFT_STORAGE_KEY = persistKey(STORE_KEYS.newConversationDraft);

const STAGING_KEY = newConversationModalStagingKey("host-a", "epic-1", null);
const STAGING_KEY_ID = worktreeStagingKeyString(STAGING_KEY);

/** A per-machine choice: exactly the state G4 must not carry across hosts. */
const STAGED_INTENT: WorktreeIntent = {
  entries: [
    {
      kind: "local",
      workspacePath: "/repo",
      repoIdentifier: null,
      isPrimary: true,
    },
  ],
};

function stagedIntent(): WorktreeIntent | undefined {
  return useWorktreeIntentStagingStore.getState().intentByKey[STAGING_KEY_ID];
}

// The G4 toast, mocked so these tests assert the modal's decision to fire it
// (and with what label) rather than sonner's internals. The staging store
// itself stays REAL below (unlike the landing composer's wiring suite) - the
// modal's `readStagedWorktreeIntent`/`clearForAllHosts` calls are exercised
// against it directly.
const toastMocks = vi.hoisted(() => ({
  toastRepointedStagingReset: vi.fn<(hostLabel: string) => void>(),
}));
// Sandbox staging has its own suites (`composer/__tests__`): here the picker
// stages nothing and the send is never intercepted.
vi.mock("@/components/settings/host-scope/use-host-options", async () => {
  const { hostOptionsFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const options = hostOptionsFixture({ hosts: [] });
  return { useHostOptions: () => options };
});
vi.mock(
  "@/components/composer/use-sandbox-staging",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/composer/use-sandbox-staging")
    >()),
    useInTaskSandboxStagingSurface: () => null,
    useSandboxStagingTask: () => ({
      hosts: null,
      groups: [],
      collaborators: null,
    }),
    useSandboxStaging: () => null,
  }),
);
vi.mock("@/components/composer/use-staged-sandbox-send", () => ({
  useStagedSandboxSend: () => ({ intercept: () => false, line: null }),
  useStagedSandboxHandoff: () => undefined,
}));

vi.mock("@/lib/composer/repointed-staging-toast", () => ({
  toastRepointedStagingReset: toastMocks.toastRepointedStagingReset,
}));

interface PlacementTargetShape {
  readonly resolvedHostId: string | null;
  readonly client: { readonly getActiveHostId: () => string | null } | null;
  readonly hostLabel: string;
  readonly isPinned: boolean;
  readonly namedHostDead: boolean;
}

/**
 * Annotated rather than asserted: the holder must be WIDE enough for a test to
 * present a null client or a different host, which an inferred literal type
 * would refuse.
 */
function placementHolder(): { current: PlacementTargetShape } {
  return {
    current: {
      resolvedHostId: "host-a",
      client: { getActiveHostId: () => "host-a" },
      hostLabel: "Studio Mac",
      isPinned: false,
      namedHostDead: false,
    },
  };
}

const testState = vi.hoisted(() => ({
  createChat: vi.fn<
    (request: {
      readonly hostId: string;
      readonly initialMessage: unknown;
    }) => Promise<{
      readonly initialTurnStarted: boolean;
    }>
  >(() => Promise.resolve({ initialTurnStarted: false })),
  createChatClientHostIds: [] as Array<string | null>,
  createTerminalAgent: vi.fn(() => Promise.resolve(null)),
  onSubmitted: vi.fn(),
  bodySubmit: null as (() => void) | null,
  bodyStartTerminal: null as
    | ((launch: TerminalAgentLaunch, assembledFor: string | null) => void)
    | null,
  bodySnapshots: [] as Array<{
    readonly composerMode: ComposerBodyProps["composerMode"];
    readonly initialContent: ComposerBodyProps["initialContent"];
  }>,
  installEditor: null as (() => void) | null,
  /** Drives what the modal's placement resolves to, per test. */
  placement: placementHolder(),
  pinIsPinned: { current: false },
  /**
   * Whether `effective` answered the placement (no override, no pin in force,
   * no session-host default in force) - the ONLY state a derivation move
   * re-points (G4). Independent of `pinIsPinned` on purpose: a modal resting
   * on the Epic's host is unpinned AND not following.
   */
  followsEffective: { current: true },
  /** The Epic's placement memory write - what a create RECORDS. */
  recordPlacement: vi.fn<(hostId: string | null) => void>(),
  /** What `useEpicConversationPlacement` was asked to resolve. */
  placementInputs: [] as Array<{
    readonly epicId: string;
    readonly overrideHostId: string | null;
    readonly sessionHostId: string | null;
  }>,
  realPlacementResults: [] as Array<{
    readonly resolvedHostId: string | null;
    readonly namedHostDead: boolean;
    readonly hasClient: boolean;
  }>,
  overrideHostId: null as string | null,
  taskSessionHostId: "host-session",
  /**
   * The workspace-controls element the body was handed. The
   * ComposerBody mock renders only the banner, so the picker's `hostScope`
   * is read off the element's props rather than through a render.
   */
  workspaceControlsElements: [] as unknown[],
  /** The pin the latest-conversation seed was read for. */
  latestSeedPins: [] as unknown[],
  /** The `pathsReachTarget` the modal handed `useComposerHashPaste`. */
  pastePathsReachTarget: null as boolean | null,
  poolActionsEnabled: false,
  poolEntry: null as HostDirectoryEntry | null,
  poolDirectoryListeners: new Set<() => void>(),
  poolEvents: [] as string[],
  poolUser: null as AuthenticatedUser | null,
  poolCatalogue: null as SandboxCatalogue | null,
  poolCreateSandbox:
    vi.fn<(input: SandboxCreateRequest) => Promise<SandboxCreateFetchResult>>(),
  poolAttach:
    vi.fn<
      (input: {
        readonly epicId: string;
        readonly teamId: string;
        readonly operation: EnvironmentCloud;
      }) => Promise<{ readonly environmentId: string }>
    >(),
  poolActivate:
    vi.fn<
      (
        option: HostScopeOption,
        report: (show: () => void) => void,
        current: () => boolean,
      ) => Promise<ActivationOutcome>
    >(),
  poolOpenTransport: vi.fn<
    (hostId: string) => {
      readonly close: () => void;
      readonly closeWithReason: (reason: string) => void;
    }
  >(),
  useRealEpicPlacement: false,
}));

/** This renderer's own host id, which the modal compares its placement host with. */
const localHost = vi.hoisted(() => ({ id: null as string | null }));

vi.mock("@/components/home/composer/composer-body", async () => {
  const React = await import("react");
  return {
    ComposerBody: (props: ComposerBodyProps) => {
      testState.bodySubmit = props.onSubmit;
      testState.bodyStartTerminal = props.onStartTerminal;
      testState.bodySnapshots.push({
        composerMode: props.composerMode,
        initialContent: props.initialContent,
      });
      testState.workspaceControlsElements.push(props.workspaceControls);
      testState.installEditor = () => {
        props.editorRef.current = editorHandle();
      };
      return React.createElement(
        "div",
        null,
        props.topBanner,
        testState.poolActionsEnabled
          ? React.createElement(
              "button",
              { type: "button", onClick: props.onSubmit },
              "Send",
            )
          : null,
      );
    },
  };
});

function editorHandle(): ComposerPromptEditorHandle {
  const editorIncarnation = createComposerEditorIncarnation();
  return {
    isReady: () => true,
    getEditorIncarnation: () => editorIncarnation,
    hasFocus: () => false,
    focus: () => undefined,
    focusAtEnd: () => undefined,
    getJSON: () => DIRTY_CONTENT,
    isEmpty: () => false,
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
    draftGeneration: () => 0,
    dismissActiveSuggestion: () => false,
  };
}

// Existing cases control the placement input for refusal branches. The added
// pool integration cases delegate to the real Epic hook and authority fixture.
vi.mock("@/hooks/host/use-composer-placement", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/host/use-composer-placement")
    >();
  return {
    ...actual,
    useEpicConversationPlacement: (
      input: Parameters<typeof actual.useEpicConversationPlacement>[0],
    ) => {
      if (testState.useRealEpicPlacement) {
        const placement = actual.useEpicConversationPlacement(input);
        testState.realPlacementResults.push({
          resolvedHostId: placement.target.resolvedHostId,
          namedHostDead: placement.target.namedHostDead,
          hasClient: placement.target.client !== null,
        });
        return placement;
      }
      testState.placementInputs.push(input);
      const target =
        input.overrideHostId === null
          ? testState.placement.current
          : {
              ...testState.placement.current,
              resolvedHostId: input.overrideHostId,
              client: { getActiveHostId: () => input.overrideHostId },
              hostLabel: "Row computer",
            };
      return {
        pin: {
          selection: null,
          honoredSelection: null,
          setSelection: testState.recordPlacement,
          resolvedHostId: target.resolvedHostId,
          isPinned: testState.pinIsPinned.current,
          latchOnFirstUse: () => undefined,
        },
        target,
        submitTarget: target,
        hostLabelFor: () => target.hostLabel,
        followsEffective: testState.followsEffective.current,
      };
    },
  };
});

vi.mock(
  "@/components/composer/pool-composer-actions",
  async (importOriginal) => {
    const React = await import("react");
    const actual =
      await importOriginal<
        typeof import("@/components/composer/pool-composer-actions")
      >();
    return {
      ...actual,
      PoolComposerActions: (
        props: Parameters<typeof actual.PoolComposerActions>[0],
      ) =>
        testState.poolActionsEnabled
          ? React.createElement(actual.PoolComposerActions, props)
          : React.createElement(
              "button",
              { type: "button" },
              "Connect a computer",
            ),
    };
  },
);

// The Epic session's host, the modal's DEFAULT placement tier - handed to the
// (mocked) placement above, so this suite pins that the modal asks for the
// session's host and not the app-wide one.
// The mirror line reads the task's hosts and the host registry, which this
// suite's `@/lib/host` mock does not carry; it has its own suite
// (`composer-mirror-line.test.tsx`), so here it shows nothing.
const NO_MIRROR_LINE = vi.hoisted(() =>
  Object.freeze({ notice: null, markSeen: (): void => undefined }),
);
vi.mock("@/hooks/composer/use-composer-mirror-line", () => ({
  useComposerMirrorLine: () => NO_MIRROR_LINE,
}));

vi.mock("@/hooks/epic/use-epic-session-host-id", () => ({
  useEpicSessionHostId: () => testState.taskSessionHostId,
}));

vi.mock("@/hooks/epic/use-epic-chat-mutations", () => ({
  useEpicCreateChatForHostClient: (
    client: { readonly getActiveHostId: () => string | null } | null,
  ) => ({
    isPending: false,
    // `mutateAsync`, matching the modal: it closes itself on submit, so its
    // completion handling rides a promise chain rather than the per-call
    // callbacks TanStack drops with the observer.
    mutateAsync: (request: {
      readonly hostId: string;
      readonly initialMessage: unknown;
    }) => {
      testState.createChatClientHostIds.push(client?.getActiveHostId() ?? null);
      return testState.createChat(request);
    },
  }),
}));

vi.mock("@/hooks/agent/use-create-tui-agent", () => ({
  useCreateTuiAgentForClient: () => ({
    isPending: false,
    create: testState.createTerminalAgent,
  }),
}));

// The agent gates read the placement host's own lists; nothing here stages a
// sandbox or sits on one, so none of them holds or refuses a send.
vi.mock("@/hooks/sandboxes/use-sandbox-agent-gate", () => ({
  useSandboxAgentGate: () => ({ blocked: false, hint: null, notice: null }),
}));
vi.mock("@/hooks/sandboxes/use-staged-send-sign-in-check", () => ({
  useStagedSendSignInCheck: () => ({
    check: () => null,
    beforeSend: () => Promise.resolve(null),
  }),
}));

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersListForClient: () => ({
    status: "pending",
    data: undefined,
    isStale: true,
    fetchStatus: "idle",
  }),
}));

vi.mock("@/components/home/hooks/use-composer-toolbar-store", async () => {
  const { createStore } = await import("zustand/vanilla");
  type ToolbarAccount = {
    readonly harnessId: string;
    readonly profileId: string;
  };
  type ToolbarSelection = {
    readonly harnessId: string;
    readonly modelSlug: string;
    readonly profileId: string | null;
  };
  type ToolbarMockState = {
    readonly accountChosen: boolean;
    readonly defaultAccount: ToolbarAccount | null;
    readonly setAccountChosen: (chosen: boolean) => void;
    readonly setDefaultAccount: (account: ToolbarAccount | null) => void;
    readonly ultracode: boolean;
    readonly selection: ToolbarSelection;
    readonly values: {
      readonly selection: ToolbarSelection;
      readonly ultracode?: boolean;
      readonly permission?: string;
      readonly reasoning?: string;
      readonly serviceTier?: string;
    };
    readonly selectedModel: ModelOption | null;
    readonly permission: string;
    readonly reasoning: string;
    readonly serviceTier: string;
    readonly agentMode: string;
    readonly catalog: {
      readonly hostId?: string | null;
      readonly harnesses: ReadonlyArray<string> | undefined;
      readonly modelsLoaded?: boolean;
      readonly modelsHarnessId?: string;
      readonly modelsProfileId?: string | null;
      readonly models?: ReadonlyArray<never>;
      readonly modelsFailed?: boolean;
    };
  };
  const emptyDefaultAccount: ToolbarAccount | null = null;
  const store = createStore<ToolbarMockState>((set, get) => ({
    accountChosen: false,
    defaultAccount: emptyDefaultAccount,
    setAccountChosen: (chosen: boolean) => {
      const state = get();
      const rawSelection = state.values.selection;
      const defaultAccount = state.defaultAccount;
      const defaultApplies =
        !chosen &&
        defaultAccount !== null &&
        rawSelection.profileId === null &&
        rawSelection.harnessId === defaultAccount.harnessId &&
        state.selection.harnessId === defaultAccount.harnessId;
      let presentedSelection = state.selection;
      if (defaultApplies) {
        presentedSelection = {
          ...state.selection,
          profileId: defaultAccount.profileId,
        };
      } else if (
        defaultAccount !== null &&
        state.selection.profileId === defaultAccount.profileId
      ) {
        presentedSelection = {
          ...state.selection,
          profileId: rawSelection.profileId,
        };
      }
      set({
        accountChosen: chosen,
        selection: presentedSelection,
      });
    },
    setDefaultAccount: (
      account: {
        readonly harnessId: string;
        readonly profileId: string;
      } | null,
    ) => {
      const state = get();
      const rawSelection = state.values.selection;
      const defaultApplies =
        !state.accountChosen &&
        account !== null &&
        rawSelection.profileId === null &&
        rawSelection.harnessId === account.harnessId &&
        state.selection.harnessId === account.harnessId;
      let presentedSelection = state.selection;
      if (defaultApplies) {
        presentedSelection = {
          ...state.selection,
          profileId: account.profileId,
        };
      } else if (
        state.defaultAccount !== null &&
        state.selection.profileId === state.defaultAccount.profileId
      ) {
        presentedSelection = {
          ...state.selection,
          profileId: rawSelection.profileId,
        };
      }
      set({
        defaultAccount: account,
        selection: presentedSelection,
      });
    },
    ultracode: false,
    selection: { harnessId: "claude", modelSlug: "sonnet", profileId: null },
    values: {
      selection: { harnessId: "claude", modelSlug: "sonnet", profileId: null },
    },
    selectedModel: null,
    permission: "supervised",
    reasoning: "medium",
    serviceTier: "",
    agentMode: "regular",
    catalog: { harnesses: [] },
  }));
  return { useComposerToolbarStore: () => store };
});

vi.mock("@/lib/epic-selectors", () => ({
  useEpicPermissionRole: () => "owner",
  useEpicConnectionStatus: () => "open",
  useEpicNodeOwnerKind: () => "chat",
  useEpicNodeWorkspaceFolders: () => [],
  useEpicTitle: () => "Epic",
}));

const stubHostClient = {
  getActiveHostId: () => useSelectionAuthorityStore.getState().effectiveHostId,
  getRequestContext: () => null,
  getRequestContextUserId: () => null,
  createRequesterForHostId: (hostId: string | null) => ({
    getActiveHostId: () => hostId,
    getRequestContext: () => null,
    getRequestContextUserId: () => null,
  }),
};
interface PoolTestHostBinding {
  readonly auth: {
    readonly sandboxControlUnavailableReason: () => null;
    readonly environmentCloud: () => {
      readonly onOriginSignIn: () => boolean;
    };
    readonly createSandbox: typeof testState.poolCreateSandbox;
  };
  readonly directory: {
    readonly knownHostIds: () => ReadonlyArray<string>;
    readonly refresh: () => Promise<void>;
    readonly findById: (hostId: string) => HostDirectoryEntry | null;
    readonly onChange: (listener: () => void) => {
      readonly dispose: () => void;
    };
  };
  readonly hostClient: typeof stubHostClient;
}
function createPoolHostBinding(): PoolTestHostBinding {
  const auth = {
    sandboxControlUnavailableReason: () => null,
    environmentCloud: () => ({ onOriginSignIn: () => true }),
    createSandbox: testState.poolCreateSandbox,
  };
  const directory = {
    knownHostIds: () => [],
    refresh: () => Promise.resolve(),
    findById: (hostId: string) =>
      testState.poolEntry?.hostId === hostId ? testState.poolEntry : null,
    onChange: (listener: () => void) => {
      testState.poolDirectoryListeners.add(listener);
      return {
        dispose: () => testState.poolDirectoryListeners.delete(listener),
      };
    },
  };
  return { auth, directory, hostClient: stubHostClient };
}
let poolHostBinding: PoolTestHostBinding | null = null;
function getPoolHostBinding(): PoolTestHostBinding {
  if (poolHostBinding === null) poolHostBinding = createPoolHostBinding();
  return poolHostBinding;
}
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => stubHostClient,
    useHostBinding: () =>
      testState.poolActionsEnabled
        ? getPoolHostBinding()
        : actual.useHostBinding(),
  };
});
vi.mock("@/lib/host/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host/runtime")>();
  return {
    ...actual,
    useHostClient: () => stubHostClient,
    useHostBinding: () =>
      testState.poolActionsEnabled
        ? getPoolHostBinding()
        : actual.useHostBinding(),
  };
});

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: [] }),
}));
vi.mock("@/hooks/auth/use-auth-user-query", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/auth/use-auth-user-query")>();
  return {
    ...actual,
    useAuthUser: (...args: Parameters<typeof actual.useAuthUser>) =>
      testState.poolActionsEnabled
        ? { data: testState.poolUser }
        : actual.useAuthUser(...args),
  };
});
vi.mock(
  "@/hooks/sandboxes/use-sandbox-catalogue-query",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/sandboxes/use-sandbox-catalogue-query")
      >();
    return {
      ...actual,
      useSandboxCatalogue: (
        ...args: Parameters<typeof actual.useSandboxCatalogue>
      ) =>
        testState.poolActionsEnabled
          ? { data: testState.poolCatalogue, isError: false }
          : actual.useSandboxCatalogue(...args),
    };
  },
);
vi.mock("@/hooks/sandboxes/use-sandbox-defaults", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/sandboxes/use-sandbox-defaults")
    >();
  return {
    ...actual,
    useSandboxDefaultsLookup: (
      ...args: Parameters<typeof actual.useSandboxDefaultsLookup>
    ) =>
      testState.poolActionsEnabled
        ? () => null
        : actual.useSandboxDefaultsLookup(...args),
  };
});
vi.mock(
  "@/hooks/sandboxes/use-team-bundle-balances",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/sandboxes/use-team-bundle-balances")
      >();
    return {
      ...actual,
      useTeamBundleBalances: (
        ...args: Parameters<typeof actual.useTeamBundleBalances>
      ) =>
        testState.poolActionsEnabled
          ? () => 0
          : actual.useTeamBundleBalances(...args),
    };
  },
);
vi.mock(
  "@/hooks/epic/use-epic-attach-environment-mutation",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/epic/use-epic-attach-environment-mutation")
      >();
    return {
      ...actual,
      useEpicAttachEnvironment: (
        ...args: Parameters<typeof actual.useEpicAttachEnvironment>
      ) =>
        testState.poolActionsEnabled
          ? { mutateAsync: testState.poolAttach }
          : actual.useEpicAttachEnvironment(...args),
    };
  },
);
vi.mock(
  "@/components/settings/host-scope/use-host-scope",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/settings/host-scope/use-host-scope")
      >();
    return {
      ...actual,
      useMakeActiveHost: (
        ...args: Parameters<typeof actual.useMakeActiveHost>
      ) =>
        testState.poolActionsEnabled
          ? { makeActiveWithWakeNotice: testState.poolActivate }
          : actual.useMakeActiveHost(...args),
    };
  },
);
vi.mock("@/lib/host/use-durable-stream-transport", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/host/use-durable-stream-transport")
    >();
  return {
    ...actual,
    useDurableStreamTransportFactory: (
      ...args: Parameters<typeof actual.useDurableStreamTransportFactory>
    ) =>
      testState.poolActionsEnabled
        ? testState.poolOpenTransport
        : actual.useDurableStreamTransportFactory(...args),
  };
});
vi.mock("@/stores/tabs/use-system-tab-modal", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/stores/tabs/use-system-tab-modal")>();
  return {
    ...actual,
    useSystemTabModalActions: (
      ...args: Parameters<typeof actual.useSystemTabModalActions>
    ) =>
      testState.poolActionsEnabled
        ? { openSettings: vi.fn() }
        : actual.useSystemTabModalActions(...args),
  };
});
vi.mock("@/hooks/worktree/use-latest-conversation-workspace-seed", () => ({
  useLatestConversationWorkspaceSeed: (_epicId: unknown, pin: unknown) => {
    testState.latestSeedPins.push(pin);
    return null;
  },
  latestCreatedConversationOwner: () => null,
}));
vi.mock("@/hooks/worktree/use-owner-workspace-inheritance-seed", () => ({
  useOwnerWorkspaceInheritanceSeed: () => ({ seed: null }),
}));
vi.mock("@/hooks/use-epic-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/use-epic-store")>();
  return {
    ...actual,
    useEpicStore: () => ({
      chats: { byId: {}, allIds: [] },
      tuiAgents: { byId: {}, allIds: [] },
    }),
  };
});
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({
    fileDrops: {
      resolveDroppedFilePaths: () => Promise.resolve([]),
      copyDroppedFilePaths: (paths: readonly string[]) =>
        Promise.resolve(paths),
    },
  }),
}));
vi.mock("@/hooks/host/use-reactive-local-host-id", () => ({
  useReactiveLocalHostId: () => localHost.id,
}));
vi.mock("@/hooks/composer/use-composer-paste", async () => {
  const actual = await vi.importActual<
    typeof import("@/hooks/composer/use-composer-paste")
  >("@/hooks/composer/use-composer-paste");
  const stubPasteResult = () => ({
    onPaste: vi.fn(),
    onDrop: vi.fn(),
    onDragOver: vi.fn(),
    onDragEnter: vi.fn(),
    onDragLeave: vi.fn(),
    attachImageFiles: vi.fn(),
    runPendingImageJob: vi.fn(),
    isDraggingFiles: false,
    dragOverlayVariant: null,
    isIngestingImages: false,
    isResolvingFilePaths: false,
  });
  return {
    ...actual,
    // The modal's paste hook, stubbed so no real ingest runs underneath.
    useComposerHashPaste: (
      _editorRef: unknown,
      options: { readonly pathsReachTarget: boolean },
    ) => {
      testState.pastePathsReachTarget = options.pathsReachTarget;
      return stubPasteResult();
    },
  };
});
vi.mock("@/hooks/workspace/use-resolved-workspace-folders-query", () => ({
  useResolvedWorkspaceFolders: () => ({ folders: [], isLoading: false }),
}));
vi.mock("@/lib/composer/workspace-composer-availability", () => ({
  deriveFolderlessAllowedWorkspaceAvailability: () => ({ disabledHint: null }),
  workspaceComposerCanStart: () => true,
}));
vi.mock("@/components/chat/composer/picker/use-composer-picker-items", () => ({
  useComposerPickerItems: () => undefined,
}));
vi.mock("@/hooks/providers/use-provider-pack-gate", () => ({
  useProviderPackGateForClient: () => ({
    blocked: false,
    hint: null,
    preparing: null,
  }),
}));
vi.mock("@/hooks/composer/use-composer-dictation", () => ({
  useComposerDictation: () => ({
    dictationControl: null,
    dictationPreparing: null,
  }),
}));
vi.mock("@/hooks/composer/use-workspace-mention-roots", () => ({
  mentionRootsFromWorktreeIntent: () => [],
  useWorkspaceMentionRoots: () => [],
}));
vi.mock(
  "@/components/home/host-workspace-selector/host-workspace-selector",
  () => ({ ActiveHostWorkspaceControls: () => null }),
);
vi.mock("@/lib/attachments/use-attachment-blob-src", () => ({
  useEpicImageFetcher: () => vi.fn(),
  useEpicAttachmentBytesPresence: () => null,
}));
vi.mock("@/stores/epics/canvas/store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/stores/epics/canvas/store")>();
  return {
    ...actual,
    useEpicCanvasStore: {
      ...actual.useEpicCanvasStore,
      getState: () => ({
        ...actual.useEpicCanvasStore.getState(),
        openTabOrder: ["tab-1"],
        tabsById: { "tab-1": { epicId: "epic-1" } },
        markChatTitlePending: vi.fn(),
        clearChatTitlePending: vi.fn(),
      }),
    },
  };
});
vi.mock("@/stores/epics/initial-chat-handoff-store", () => ({
  useInitialChatHandoffStore: {
    getState: () => ({
      register: vi.fn(),
      markInitialTurnStarted: vi.fn(),
      markFailedByAction: vi.fn(),
    }),
  },
}));

function Harness() {
  const [transient] = useState(() => ({
    pickerStore: createComposerPickerStore(),
  }));
  const dismissPickerRef = useRef<(() => boolean) | null>(null);
  return (
    <SurfacePresentationBoundary visible focused>
      <Dialog open>
        <DialogContent>
          <NewConversationTransientContext.Provider value={transient}>
            <NewConversationModalBody
              epicId="epic-1"
              tabId="tab-1"
              placement={null}
              parentId={null}
              hostId={testState.overrideHostId}
              dismissPickerRef={dismissPickerRef}
              onSubmitted={testState.onSubmitted}
            />
          </NewConversationTransientContext.Provider>
        </DialogContent>
      </Dialog>
    </SurfacePresentationBoundary>
  );
}

function ModalHostHarness() {
  return (
    <SurfacePresentationBoundary visible focused>
      <NewConversationModalHost epicId="epic-1" tabId="tab-1" active />
    </SurfacePresentationBoundary>
  );
}

/**
 * The `hostScope` prop of the `<ActiveHostWorkspaceControls>` element the
 * body was handed. `null` when the element is not that component (the arm
 * then fails on the shape assertion rather than on a thrown read).
 */
function workspaceControlsHostScope(element: unknown): unknown {
  if (!isValidElement<{ readonly hostScope: unknown }>(element)) return null;
  return element.props.hostScope;
}

function workspaceControlsSeed(element: unknown): unknown {
  if (!isValidElement<{ readonly workspaceSeed: unknown }>(element))
    return null;
  return element.props.workspaceSeed;
}

/**
 * `NewConversationModalBody` reads a `QueryClient` (the deferred create's
 * binding-seed release closure), and in the app it always renders under the
 * app-wide provider. One client per render so nothing leaks between cases.
 */
function QueryWrapper({ children }: { readonly children: ReactNode }) {
  const [client] = useState(() => createAppQueryClient());
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function renderModal(): RenderResult {
  const view = render(<Harness />, { wrapper: QueryWrapper });
  act(() => {
    testState.installEditor?.();
  });
  return view;
}

function renderModalHost(request: {
  readonly hostId: string | null;
  readonly parentId?: string | null;
  readonly requiresNamedHost?: boolean;
}): RenderResult {
  const view = render(<ModalHostHarness />, { wrapper: QueryWrapper });
  act(() => {
    useNewConversationModalOpenStore.getState().open({
      epicId: "epic-1",
      tabId: "tab-1",
      placement: null,
      parentId: request.parentId ?? null,
      hostId: request.hostId,
      ...(request.requiresNamedHost === undefined
        ? {}
        : { requiresNamedHost: request.requiresNamedHost }),
    });
  });
  return view;
}

function prepareRealPoolPlacement(options: {
  readonly hosts: ReadonlyArray<{
    readonly hostId: string;
    readonly kind: "remote" | "sandbox";
    readonly teamOwned: boolean;
  }>;
  readonly sessionHostId: string;
  readonly hasTeam: boolean;
  readonly pool?: "ready" | "offline";
  readonly readyComputers?: ReadonlyArray<string>;
  readonly deadComputers?: ReadonlyArray<string>;
  readonly savedPick?: string | null;
}): SelectionAuthorityFixture {
  testState.useRealEpicPlacement = true;
  testState.poolActionsEnabled = true;
  testState.poolUser = userWith(
    userSubscription({
      totalPlanCredits: 100,
      consumedFromPlan: 0,
      bonusCredits: 0,
      consumedFromBonus: 0,
      bundleRemaining: 100,
    }),
    options.hasTeam ? [teamSubscription(100)] : [],
  );
  testState.poolCatalogue = readinessCatalogue({
    warm: 0,
    coldCreateMeasuredMs: 60_000,
  });
  testState.poolAttach.mockResolvedValue({ environmentId: "team-environment" });
  testState.poolOpenTransport.mockReturnValue({
    close: vi.fn(),
    closeWithReason: vi.fn(),
  });
  testState.taskSessionHostId = options.sessionHostId;
  useAuthStore.setState({
    profile: {
      userId: "fake-user",
      userName: "Test User",
      email: "test@example.invalid",
    },
  });
  const authority = mountTestSelectionAuthority({
    hosts: options.hosts,
    pool: options.pool ?? "ready",
    readyComputers: options.readyComputers,
    savedPick: options.savedPick,
  });
  if (options.pool !== "offline") authority.openPool();
  for (const hostId of options.deadComputers ?? []) {
    authority.goCold(hostId);
  }
  return authority;
}

function reopenModalRequest(request: {
  readonly hostId: string | null;
  readonly parentId: string | null;
}): void {
  act(() => {
    useNewConversationModalOpenStore.getState().close();
    useNewConversationModalOpenStore.getState().open({
      epicId: "epic-1",
      tabId: "tab-1",
      placement: null,
      hostId: request.hostId,
      parentId: request.parentId,
    });
  });
}

function acceptedSandbox(
  hostId: string,
  sandboxId: string,
  environmentId: string | null,
): SandboxCreateFetchResult {
  return {
    kind: "ok",
    accepted: {
      sandboxId,
      hostId,
      sandbox: sandboxSummaryFixture({
        id: sandboxId,
        hostId,
        state: "creating",
        wakeBudgetMs: 60_000,
        environmentId,
      }),
    },
  };
}

async function serveSandbox(
  authority: SelectionAuthorityFixture,
  hostId: string,
): Promise<void> {
  await act(async () => {
    authority.publishFleet(
      [
        ...authority.fleetComputers(),
        { hostId, kind: "sandbox", teamOwned: false },
      ],
      null,
    );
    authority.connectComputer(hostId);
    authority.succeedDial(hostId);
    await authority.activate(hostId);
  });
}

function noticeText(): string {
  return screen.getByTestId("composer-host-notice").textContent;
}

function draftSurvived(): boolean {
  const patch =
    useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"];
  return patch?.content !== undefined && patch.content !== null;
}

beforeEach(() => {
  poolHostBinding = null;
  testState.createChatClientHostIds.length = 0;
  useNewConversationModalOpenStore.getState().close();
  useNewConversationModalStore.getState().resetForTests();
  useNewConversationModalStore.getState().setContent("epic-1", DIRTY_CONTENT);
  useNewConversationModalStore.getState().setComposerMode("epic-1", "chat");
  useWorktreeIntentStagingStore.getState().clear(STAGING_KEY);
  testState.placement.current = {
    resolvedHostId: "host-a",
    client: { getActiveHostId: () => "host-a" },
    hostLabel: "Studio Mac",
    isPinned: false,
    namedHostDead: false,
  };
  testState.pinIsPinned.current = false;
  testState.followsEffective.current = true;
  testState.workspaceControlsElements = [];
  testState.bodySnapshots = [];
  testState.latestSeedPins = [];
  testState.pastePathsReachTarget = null;
  localHost.id = null;
  testState.recordPlacement.mockClear();
  testState.poolActionsEnabled = false;
  testState.poolEntry = null;
  testState.poolDirectoryListeners.clear();
  testState.poolEvents.length = 0;
  testState.poolUser = null;
  testState.poolCatalogue = null;
  testState.poolCreateSandbox.mockReset();
  testState.poolAttach.mockReset();
  testState.poolActivate.mockReset();
  testState.poolOpenTransport.mockReset();
  testState.placementInputs.length = 0;
  testState.realPlacementResults.length = 0;
  testState.overrideHostId = null;
  testState.taskSessionHostId = "host-session";
  testState.useRealEpicPlacement = false;
  useSurfaceHostSelectionStore
    .getState()
    .setSelection(newConversationSurfaceKey("epic-1"), null);
  useAuthStore.setState({ profile: null, contextMetadata: null });
});

afterEach(() => {
  cleanup();
  testState.createChatClientHostIds.length = 0;
  useSelectionAuthorityStore.getState().reset();
  useSurfaceHostSelectionStore
    .getState()
    .setSelection(newConversationSurfaceKey("epic-1"), null);
  testState.createChat.mockClear();
  testState.createChat.mockResolvedValue({ initialTurnStarted: false });
  testState.createTerminalAgent.mockClear();
  testState.onSubmitted.mockClear();
  testState.bodySubmit = null;
  testState.bodyStartTerminal = null;
  testState.installEditor = null;
  testState.poolActionsEnabled = false;
  testState.poolEntry = null;
  testState.poolDirectoryListeners.clear();
  useAuthStore.setState({ profile: null, contextMetadata: null });
  useNewConversationModalStore.getState().resetForTests();
  useNewConversationModalOpenStore.getState().close();
  useAddHostDialogStore.getState().closeDialog();
  toastMocks.toastRepointedStagingReset.mockReset();
});

describe("new-conversation modal shares the composer's placement semantics", () => {
  it("sends from the real Team chooser to the ready pinned computer", async () => {
    testState.poolActionsEnabled = true;
    testState.poolUser = userWith(
      userSubscription({
        totalPlanCredits: 100,
        consumedFromPlan: 0,
        bonusCredits: 0,
        consumedFromBonus: 0,
        bundleRemaining: 100,
      }),
      [teamSubscription(100)],
    );
    testState.poolCatalogue = readinessCatalogue({
      warm: 0,
      coldCreateMeasuredMs: 60_000,
    });
    testState.poolAttach.mockImplementation(() => {
      testState.poolEvents.push("attach");
      return Promise.resolve({ environmentId: "team-env" });
    });
    testState.poolCreateSandbox.mockImplementation((input) => {
      testState.poolEvents.push("create");
      expect(input.environmentId).toBe("team-env");
      return Promise.resolve({
        kind: "ok",
        accepted: {
          sandboxId: "sandbox-team",
          hostId: "team-host",
          sandbox: sandboxSummaryFixture({
            id: "sandbox-team",
            hostId: "team-host",
            state: "creating",
            wakeBudgetMs: 60_000,
            environmentId: "team-env",
          }),
        },
      });
    });
    testState.poolOpenTransport.mockReturnValue({
      close: vi.fn(),
      closeWithReason: vi.fn(),
    });
    testState.recordPlacement.mockImplementation((hostId) => {
      testState.placement.current = {
        resolvedHostId: hostId,
        client: { getActiveHostId: () => hostId },
        hostLabel: "Acme sandbox",
        isPinned: true,
        namedHostDead: false,
      };
    });
    useAuthStore.setState({
      profile: {
        userId: "fake-user",
        userName: "Test User",
        email: "test@example.invalid",
      },
    });
    const authority = mountTestSelectionAuthority({ hosts: [] });

    testState.taskSessionHostId = POOL_HOST_ID;
    const view = renderModal();
    expect(testState.placementInputs.at(-1)?.sessionHostId).toBe(POOL_HOST_ID);
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Host: none selected" }),
      { button: 0 },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /New acme sandbox/i }),
    );

    await waitFor(() =>
      expect(testState.poolEvents).toEqual(["attach", "create"]),
    );
    expect(testState.poolCreateSandbox).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ environmentId: "team-env" }),
    );
    expect(testState.poolActivate).not.toHaveBeenCalled();

    act(() => {
      testState.poolEntry = sandboxHostEntry("team-host", {
        id: "team-1",
        name: "Acme",
      });
      for (const listener of testState.poolDirectoryListeners) listener();
    });
    await waitFor(() =>
      expect(testState.poolOpenTransport).toHaveBeenCalledExactlyOnceWith(
        "team-host",
      ),
    );
    act(() => {
      authority.publishFleet(
        [{ hostId: "team-host", kind: "sandbox", teamOwned: true }],
        null,
      );
      authority.connectComputer("team-host");
    });
    await waitFor(() =>
      expect(testState.recordPlacement).toHaveBeenCalledExactlyOnceWith(
        "team-host",
      ),
    );
    expect(testState.placement.current.resolvedHostId).toBe("team-host");
    expect(testState.poolActivate).not.toHaveBeenCalled();

    view.rerender(<Harness />);
    await screen.findByRole("button", { name: "Send" });
    act(() => testState.installEditor?.());
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(testState.createChat).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ hostId: "team-host" }),
      ),
    );
    expect(testState.createChatClientHostIds).toEqual(["team-host"]);
    const sentMessage = testState.createChat.mock.calls[0]?.[0].initialMessage;
    expect(sentMessage).toEqual(
      expect.objectContaining({ content: DIRTY_CONTENT }),
    );
  });

  it("uses real Epic placement for Team Start and sends through the ready sandbox requester", async () => {
    const namedHostId = "computer-row";
    const teamHostId = "team-sandbox";
    const surfaceKey = newConversationSurfaceKey("epic-1");
    const authority = prepareRealPoolPlacement({
      hosts: [{ hostId: namedHostId, kind: "remote", teamOwned: false }],
      sessionHostId: POOL_HOST_ID,
      hasTeam: true,
      deadComputers: [namedHostId],
    });
    expect(authority.snapshot().servingPeer).toEqual({ kind: "pool" });
    expect(readPoolComputerUnavailable(namedHostId)).toBe(true);
    testState.poolAttach.mockImplementation(() => {
      testState.poolEvents.push("attach");
      return Promise.resolve({ environmentId: "team-environment" });
    });
    testState.poolCreateSandbox.mockImplementation((input) => {
      testState.poolEvents.push("create");
      expect(input.environmentId).toBe("team-environment");
      return Promise.resolve(
        acceptedSandbox(teamHostId, "sandbox-team", "team-environment"),
      );
    });

    const view = renderModalHost({ hostId: namedHostId });
    expect(useNewConversationModalOpenStore.getState().request).toMatchObject({
      parentId: null,
      hostId: namedHostId,
    });
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Host: none selected" }),
      { button: 0 },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /New acme sandbox/i }),
    );

    await waitFor(() =>
      expect(testState.poolEvents).toEqual(["attach", "create"]),
    );
    expect(useNewConversationModalOpenStore.getState().request).toMatchObject({
      parentId: null,
      hostId: null,
    });
    expect(testState.poolCreateSandbox).toHaveBeenCalledTimes(1);
    expect(testState.poolActivate).not.toHaveBeenCalled();

    act(() => {
      testState.poolEntry = sandboxHostEntry(teamHostId, {
        id: "team-1",
        name: "Acme",
      });
      for (const listener of testState.poolDirectoryListeners) listener();
    });
    await waitFor(() =>
      expect(testState.poolOpenTransport).toHaveBeenCalledExactlyOnceWith(
        teamHostId,
      ),
    );
    act(() => {
      authority.publishFleet(
        [
          ...authority.fleetComputers(),
          { hostId: teamHostId, kind: "sandbox", teamOwned: true },
        ],
        null,
      );
      authority.connectComputer(teamHostId);
      authority.succeedDial(teamHostId);
    });
    await waitFor(() =>
      expect(
        authority
          .snapshot()
          .leases.some(
            (lease) => lease.hostId === teamHostId && lease.status === "ready",
          ),
      ).toBe(true),
    );
    await screen.findByRole("button", { name: "Send" });
    await waitFor(() =>
      expect(
        useSurfaceHostSelectionStore.getState().selections[surfaceKey],
      ).toBe(teamHostId),
    );
    expect(
      screen.queryByRole("button", { name: "Start a sandbox" }),
    ).toBeNull();
    expect(testState.poolActivate).not.toHaveBeenCalled();

    act(() => testState.installEditor?.());
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(testState.createChat).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ hostId: teamHostId }),
      ),
    );
    expect(testState.createChatClientHostIds).toEqual([teamHostId]);
    expect(testState.createChat.mock.calls[0]?.[0].initialMessage).toEqual(
      expect.objectContaining({ content: DIRTY_CONTENT }),
    );
    expect(useSurfaceHostSelectionStore.getState().selections[surfaceKey]).toBe(
      teamHostId,
    );
    view.unmount();
  });

  it("shows the ordinary Epic default while a personal start remains pending", async () => {
    const defaultHostId = "computer-row";
    const sandboxHostId = "personal-sandbox";
    const surfaceKey = newConversationSurfaceKey("epic-1");
    const authority = prepareRealPoolPlacement({
      hosts: [{ hostId: defaultHostId, kind: "remote", teamOwned: false }],
      sessionHostId: defaultHostId,
      hasTeam: false,
      deadComputers: [defaultHostId],
    });
    const activation = Promise.withResolvers<ActivationOutcome>();
    testState.poolCreateSandbox.mockImplementation(() => {
      testState.poolEntry = sandboxHostEntry(sandboxHostId, null);
      return Promise.resolve(
        acceptedSandbox(sandboxHostId, "sandbox-personal", null),
      );
    });
    testState.poolActivate.mockImplementation(() => activation.promise);

    const view = renderModalHost({ hostId: defaultHostId });
    fireEvent.click(screen.getByRole("button", { name: "Start a sandbox" }));
    expect(useNewConversationModalOpenStore.getState().request).toMatchObject({
      parentId: null,
      hostId: null,
    });
    await waitFor(() =>
      expect(testState.poolCreateSandbox).toHaveBeenCalledTimes(1),
    );
    await waitFor(() =>
      expect(testState.poolActivate).toHaveBeenCalledTimes(1),
    );
    expect(testState.poolCreateSandbox).toHaveBeenCalledTimes(1);

    await act(async () => {
      authority.connectComputer(defaultHostId);
      authority.succeedDial(defaultHostId);
      await authority.activate(defaultHostId);
    });
    await screen.findByRole("button", { name: "Send" });
    act(() => testState.installEditor?.());
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(testState.createChat).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ hostId: defaultHostId }),
      ),
    );
    expect(testState.createChatClientHostIds).toEqual([defaultHostId]);
    expect(testState.poolCreateSandbox).toHaveBeenCalledTimes(1);
    expect(useSurfaceHostSelectionStore.getState().selections[surfaceKey]).toBe(
      defaultHostId,
    );

    await serveSandbox(authority, sandboxHostId);
    await act(async () => {
      activation.resolve("saved");
      await Promise.resolve();
    });
    expect(testState.poolCreateSandbox).toHaveBeenCalledTimes(1);
    expect(useSurfaceHostSelectionStore.getState().selections[surfaceKey]).toBe(
      defaultHostId,
    );
    view.unmount();
  });

  it.each(["ready-before-reopen", "reopen-before-ready"] as const)(
    "keeps the real Epic pin empty for Personal completion order %s",
    async (order) => {
      const namedHostId = "computer-row";
      const sandboxHostId = "personal-sandbox";
      const surfaceKey = newConversationSurfaceKey("epic-1");
      const authority = prepareRealPoolPlacement({
        hosts: [{ hostId: namedHostId, kind: "remote", teamOwned: false }],
        sessionHostId: POOL_HOST_ID,
        hasTeam: false,
        deadComputers: [namedHostId],
      });
      const activation = Promise.withResolvers<ActivationOutcome>();
      testState.poolCreateSandbox.mockImplementation(() => {
        testState.poolEntry = sandboxHostEntry(sandboxHostId, null);
        return Promise.resolve(
          acceptedSandbox(sandboxHostId, "sandbox-personal", null),
        );
      });
      testState.poolActivate.mockImplementation(() => activation.promise);

      const view = renderModalHost({ hostId: namedHostId });
      fireEvent.click(screen.getByRole("button", { name: "Start a sandbox" }));
      await waitFor(() =>
        expect(testState.poolActivate).toHaveBeenCalledTimes(1),
      );
      if (order === "reopen-before-ready") {
        reopenModalRequest({ hostId: null, parentId: "parent-chat" });
      }

      await serveSandbox(authority, sandboxHostId);
      await act(async () => {
        activation.resolve("saved");
        await Promise.resolve();
      });
      await screen.findByRole("button", { name: "Send" });
      if (order === "ready-before-reopen") {
        reopenModalRequest({ hostId: null, parentId: "parent-chat" });
      }
      expect(useNewConversationModalOpenStore.getState().request).toMatchObject(
        {
          parentId: "parent-chat",
          hostId: null,
        },
      );
      expect(
        useSurfaceHostSelectionStore.getState().selections[surfaceKey],
      ).toBeUndefined();

      expect(testState.poolCreateSandbox).toHaveBeenCalledTimes(1);
      view.unmount();
    },
  );

  it("rehydrates Terminal mode and workspace into a fresh store through the pool controls, then returns to Chat with the same text", async () => {
    const folder: WorkspaceFolderInfo = {
      path: "/repo",
      name: "repo",
      repoIdentifier: null,
      hostId: "host-a",
    };
    useNewConversationModalStore.getState().setContent("epic-1", DIRTY_CONTENT);
    useNewConversationModalStore
      .getState()
      .setComposerMode("epic-1", "terminal");
    useNewConversationModalStore
      .getState()
      .addResolvedFolders("epic-1", emptyLandingDraftWorkspaceSnapshot(), [
        folder,
      ]);
    const persistedBytes = window.localStorage.getItem(
      NEW_CHAT_DRAFT_STORAGE_KEY,
    );
    if (persistedBytes === null)
      throw new Error("new-chat draft was not persisted");

    const authority = mountTestSelectionAuthority({
      hosts: [{ hostId: "host-a", kind: "remote", teamOwned: false }],
      savedPick: "host-a",
      readyComputers: ["host-a"],
    });
    authority.goCold("host-a");

    testState.taskSessionHostId = POOL_HOST_ID;
    const view = renderModal();
    expect(testState.placementInputs.at(-1)?.sessionHostId).toBe(POOL_HOST_ID);
    expect(
      screen.getByRole("button", { name: "Connect a computer" }),
    ).toBeTruthy();
    expect(testState.bodySnapshots).toEqual([]);

    useNewConversationModalStore.setState({ draftPatchesByEpicId: {} });
    window.localStorage.setItem(NEW_CHAT_DRAFT_STORAGE_KEY, persistedBytes);
    vi.resetModules();
    const freshNewChatStoreModule =
      await import("@/stores/epics/new-conversation-modal-store");
    expect(freshNewChatStoreModule.useNewConversationModalStore).not.toBe(
      useNewConversationModalStore,
    );
    const freshRestored =
      freshNewChatStoreModule.useNewConversationModalStore.getState()
        .draftPatchesByEpicId["epic-1"];
    if (freshRestored === undefined)
      throw new Error("new-chat draft did not reload into a fresh store");
    expect(freshRestored.content).toEqual(DIRTY_CONTENT);
    expect(freshRestored.composerMode).toBe("terminal");
    expect(freshRestored.workspace?.folders).toEqual(["/repo"]);
    expect(
      screen.getByRole("button", { name: "Connect a computer" }),
    ).toBeTruthy();

    await act(async () => {
      await useNewConversationModalStore.persist.rehydrate();
    });
    expect(
      screen.getByRole("button", { name: "Connect a computer" }),
    ).toBeTruthy();

    const restored =
      useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"];
    if (restored === undefined)
      throw new Error("new-chat draft did not reload");
    expect(restored.content).toEqual(DIRTY_CONTENT);
    expect(restored.composerMode).toBe("terminal");
    expect(restored.workspace?.folders).toEqual(["/repo"]);

    act(() => {
      authority.connectComputer("host-a");
      authority.finishReturnDamping();
    });
    act(() => view.rerender(<Harness />));

    expect(
      screen.queryByRole("button", { name: "Connect a computer" }),
    ).toBeNull();
    expect(testState.bodySnapshots.at(-1)).toEqual({
      composerMode: "terminal",
      initialContent: DIRTY_CONTENT,
    });
    expect(
      workspaceControlsSeed(testState.workspaceControlsElements.at(-1)),
    ).toEqual(restored.workspace);

    act(() =>
      useNewConversationModalStore.getState().setComposerMode("epic-1", "chat"),
    );

    expect(testState.bodySnapshots.at(-1)).toEqual({
      composerMode: "chat",
      initialContent: DIRTY_CONTENT,
    });
    expect(
      workspaceControlsSeed(testState.workspaceControlsElements.at(-1)),
    ).toEqual(restored.workspace);
  });

  it("restores the named modal box when its computer becomes ready before a press", async () => {
    const namedHostId = "computer-row";
    const authority = prepareRealPoolPlacement({
      hosts: [{ hostId: namedHostId, kind: "remote", teamOwned: false }],
      sessionHostId: POOL_HOST_ID,
      hasTeam: false,
      deadComputers: [namedHostId],
    });

    const view = renderModalHost({ hostId: namedHostId });
    expect(readPoolComputerUnavailable(namedHostId)).toBe(true);
    act(() => {
      authority.connectComputer(namedHostId);
      authority.succeedDial(namedHostId);
    });
    await waitFor(() =>
      expect(readPoolComputerUnavailable(namedHostId)).toBe(false),
    );
    expect(testState.realPlacementResults.at(-1)).toEqual({
      resolvedHostId: namedHostId,
      namedHostDead: false,
      hasClient: true,
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send" })).toBeTruthy(),
    );
    expect(
      screen.queryByRole("button", { name: "Start a sandbox" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Connect a computer" }),
    ).toBeNull();
    expect(useNewConversationModalOpenStore.getState().request).toMatchObject({
      hostId: namedHostId,
      parentId: null,
    });
    expect(
      useSurfaceHostSelectionStore.getState().selections[
        newConversationSurfaceKey("epic-1")
      ],
    ).toBeUndefined();
    expect(testState.bodySnapshots.at(-1)?.initialContent).toEqual(
      DIRTY_CONTENT,
    );
    expect(testState.createChat).not.toHaveBeenCalled();
    view.unmount();
  });

  it("releases a cold named modal synchronously and restores its quoted draft without pinning the surface", async () => {
    const namedHostId = "computer-row";
    const sandboxHostId = "personal-sandbox";
    testState.poolActionsEnabled = true;
    testState.poolUser = userWith(
      userSubscription({
        totalPlanCredits: 100,
        consumedFromPlan: 0,
        bonusCredits: 0,
        consumedFromBonus: 0,
        bundleRemaining: 100,
      }),
      [],
    );
    testState.poolCatalogue = readinessCatalogue({
      warm: 0,
      coldCreateMeasuredMs: 60_000,
    });
    testState.taskSessionHostId = POOL_HOST_ID;
    testState.placement.current = {
      resolvedHostId: POOL_HOST_ID,
      client: { getActiveHostId: () => POOL_HOST_ID },
      hostLabel: "Traycer cloud",
      isPinned: false,
      namedHostDead: false,
    };
    useAuthStore.setState({
      profile: {
        userId: "fake-user",
        userName: "Test User",
        email: "test@example.invalid",
      },
    });
    const authority = mountTestSelectionAuthority({
      hosts: [{ hostId: namedHostId, kind: "remote", teamOwned: false }],
      pool: "ready",
    });
    authority.openPool();
    testState.poolCreateSandbox.mockImplementation(() => {
      testState.poolEntry = sandboxHostEntry(sandboxHostId, null);
      return Promise.resolve({
        kind: "ok",
        accepted: {
          sandboxId: "sandbox-personal",
          hostId: sandboxHostId,
          sandbox: sandboxSummaryFixture({
            id: "sandbox-personal",
            hostId: sandboxHostId,
            state: "creating",
            wakeBudgetMs: 60_000,
            environmentId: null,
          }),
        },
      });
    });
    testState.poolActivate.mockImplementation(async (option) => {
      await act(async () => {
        authority.publishFleet(
          [
            ...authority.fleetComputers(),
            { hostId: sandboxHostId, kind: "sandbox", teamOwned: false },
          ],
          null,
        );
        authority.connectComputer(sandboxHostId);
        await authority.activate(option.hostId);
      });
      return "saved";
    });
    const folder: WorkspaceFolderInfo = {
      path: "/parent-project",
      name: "parent-project",
      repoIdentifier: null,
      hostId: namedHostId,
    };
    useNewConversationModalStore
      .getState()
      .addResolvedFolders("epic-1", emptyLandingDraftWorkspaceSnapshot(), [
        folder,
      ]);
    appendTerminalQuoteToNewConversationDraft({
      epicId: "epic-1",
      terminalId: "terminal-1",
      terminalTitle: "Test shell",
      terminalCwd: "/repo",
      text: "quoted output\nwith indentation",
    });
    const quotedContent =
      useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"]
        ?.content;
    if (quotedContent === undefined || quotedContent === null) {
      throw new Error("terminal quote was not added to the modal draft");
    }
    const restoredPatch =
      useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"];
    if (restoredPatch === undefined || restoredPatch.workspace === null) {
      throw new Error("new-chat folder was not kept in the modal draft");
    }

    const view = renderModalHost({ hostId: namedHostId });
    expect(
      screen.getByRole("button", { name: "Start a sandbox" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Connect a computer" }),
    ).toBeTruthy();
    expect(testState.bodySnapshots).toHaveLength(0);
    expect(useNewConversationModalOpenStore.getState().request).toEqual({
      epicId: "epic-1",
      tabId: "tab-1",
      placement: null,
      parentId: null,
      hostId: namedHostId,
    });

    fireEvent.click(screen.getByRole("button", { name: "Start a sandbox" }));
    expect(useNewConversationModalOpenStore.getState().request).toEqual({
      epicId: "epic-1",
      tabId: "tab-1",
      placement: null,
      parentId: null,
      hostId: null,
    });
    expect(testState.poolCreateSandbox).toHaveBeenCalledTimes(1);
    expect(testState.poolCreateSandbox.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ createdByHostId: null, createdByTaskId: null }),
    );
    await waitFor(() =>
      expect(testState.poolActivate).toHaveBeenCalledTimes(1),
    );
    expect(testState.poolActivate.mock.calls[0]?.[0].hostId).toBe(
      sandboxHostId,
    );
    expect(testState.recordPlacement).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send" })).toBeTruthy(),
    );
    expect(
      screen.queryByRole("button", { name: "Start a sandbox" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Connect a computer" }),
    ).toBeNull();
    expect(testState.bodySnapshots.at(-1)).toEqual({
      composerMode: "chat",
      initialContent: quotedContent,
    });
    expect(restoredPatch.workspace.folders).toEqual([folder.path]);
    expect(
      workspaceControlsSeed(testState.workspaceControlsElements.at(-1)),
    ).toEqual(restoredPatch.workspace);
    expect(testState.createChat).not.toHaveBeenCalled();
    view.unmount();
  });

  it("releases a named modal before opening the usual computer chooser", () => {
    const namedHostId = "computer-row";
    prepareRealPoolPlacement({
      hosts: [{ hostId: namedHostId, kind: "remote", teamOwned: false }],
      sessionHostId: POOL_HOST_ID,
      hasTeam: false,
      deadComputers: [namedHostId],
    });

    renderModalHost({ hostId: namedHostId });
    expect(readPoolComputerUnavailable(namedHostId)).toBe(true);
    expect(testState.realPlacementResults.at(-1)).toEqual({
      resolvedHostId: namedHostId,
      namedHostDead: true,
      hasClient: true,
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect a computer" }));

    expect(useNewConversationModalOpenStore.getState().request).toEqual({
      epicId: "epic-1",
      tabId: "tab-1",
      placement: null,
      parentId: null,
      hostId: null,
    });
    expect(useAddHostDialogStore.getState()).toMatchObject({ open: true });
    expect(testState.poolCreateSandbox).not.toHaveBeenCalled();
    expect(draftSurvived()).toBe(true);
    expect(testState.realPlacementResults.at(-1)).toEqual({
      resolvedHostId: null,
      namedHostDead: false,
      hasClient: true,
    });
    expect(
      useSurfaceHostSelectionStore.getState().selections[
        newConversationSurfaceKey("epic-1")
      ],
    ).toBeUndefined();
  });

  it("keeps a modal request that requires its named computer on the existing fixed-host refusal", async () => {
    const namedHostId = "computer-row";
    prepareRealPoolPlacement({
      hosts: [{ hostId: namedHostId, kind: "remote", teamOwned: false }],
      sessionHostId: POOL_HOST_ID,
      hasTeam: false,
      deadComputers: [namedHostId],
    });
    act(() =>
      useNewConversationModalStore
        .getState()
        .setComposerMode("epic-1", "terminal"),
    );

    renderModalHost({ hostId: namedHostId, requiresNamedHost: true });
    expect(useNewConversationModalOpenStore.getState().request).toMatchObject({
      parentId: null,
      hostId: namedHostId,
    });
    expect(testState.bodySnapshots.at(-1)?.composerMode).toBe("terminal");
    expect(readPoolComputerUnavailable(namedHostId)).toBe(true);
    expect(testState.realPlacementResults.at(-1)).toEqual({
      resolvedHostId: namedHostId,
      namedHostDead: true,
      hasClient: true,
    });
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Start a sandbox" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Connect a computer" }),
    ).toBeNull();
    act(() => {
      testState.bodyStartTerminal?.(
        {
          harnessId: "claude",
          model: null,
          reasoningEffort: null,
          terminalAgentArgs: null,
          profileId: null,
        },
        namedHostId,
      );
    });

    await waitFor(() =>
      expect(noticeText()).toBe(
        "The selected device is offline. Start this from another device, or try again once it's back.",
      ),
    );
    expect(testState.createChat).not.toHaveBeenCalled();
    expect(testState.createTerminalAgent).not.toHaveBeenCalled();
    expect(useNewConversationModalOpenStore.getState().request).toMatchObject({
      hostId: namedHostId,
      requiresNamedHost: true,
    });
  });

  it("keeps the fixed-host composer and its offline refusal when a computer serves the app", async () => {
    const namedHostId = "computer-row";
    const servingHostId = "serving-computer";
    const authority = prepareRealPoolPlacement({
      hosts: [
        { hostId: namedHostId, kind: "remote", teamOwned: false },
        { hostId: servingHostId, kind: "remote", teamOwned: false },
      ],
      sessionHostId: servingHostId,
      hasTeam: false,
      pool: "offline",
      savedPick: servingHostId,
      readyComputers: [servingHostId],
      deadComputers: [namedHostId],
    });
    expect(authority.snapshot().servingPeer).toEqual({
      kind: "computer",
      hostId: servingHostId,
    });
    expect(readPoolComputerUnavailable(namedHostId)).toBe(false);

    const view = renderModalHost({ hostId: namedHostId });
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Start a sandbox" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Connect a computer" }),
    ).toBeNull();
    expect(testState.realPlacementResults.at(-1)).toEqual({
      resolvedHostId: namedHostId,
      namedHostDead: true,
      hasClient: true,
    });
    act(() => testState.installEditor?.());
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(noticeText()).toBe(
        "The selected device is offline. Start this from another device, or try again once it's back.",
      ),
    );
    expect(testState.createChat).not.toHaveBeenCalled();
    expect(useNewConversationModalOpenStore.getState().request?.hostId).toBe(
      namedHostId,
    );
    view.unmount();
  });

  it.each(["connecting", "pool-session"] as const)(
    "restores the ordinary message box and the same draft from %s",
    (placement) => {
      const authority = mountTestSelectionAuthority({
        hosts: [{ hostId: "host-a", kind: "remote", teamOwned: false }],
        savedPick: "host-a",
        readyComputers: placement === "connecting" ? [] : ["host-a"],
        pool: "offline",
      });
      const readyTarget = testState.placement.current;
      const view = renderModal();
      const message =
        useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"];
      expect(
        screen.queryByRole("button", { name: "Connect a computer" }),
      ).toBeNull();
      expect(message?.content).toEqual(DIRTY_CONTENT);

      if (placement === "pool-session") {
        testState.taskSessionHostId = POOL_HOST_ID;
        testState.placement.current = {
          ...readyTarget,
          resolvedHostId: POOL_HOST_ID,
        };
      }
      act(() => {
        authority.openPool();
        if (placement === "pool-session") authority.goCold("host-a");
      });
      view.rerender(<Harness />);
      if (placement === "pool-session") {
        expect(testState.placementInputs.at(-1)?.sessionHostId).toBe(
          POOL_HOST_ID,
        );
      }
      expect(
        screen.getByRole("button", { name: "Connect a computer" }),
      ).toBeTruthy();
      expect(
        useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"],
      ).toBe(message);

      testState.placement.current = readyTarget;
      act(() => {
        authority.connectComputer("host-a");
        authority.finishReturnDamping();
      });
      view.rerender(<Harness />);
      expect(
        screen.queryByRole("button", { name: "Connect a computer" }),
      ).toBeNull();
      expect(
        useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"],
      ).toEqual(message);
    },
  );

  it("creates on the resolved host when the placement is usable", () => {
    renderModal();
    act(() => {
      testState.bodySubmit?.();
    });

    expect(testState.createChat).toHaveBeenCalledTimes(1);
    expect(testState.createChat).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: "host-a" }),
    );
  });

  // A pin never sets `namedHostDead`: by the time `useComposerPlacement`
  // resolves, a pinned host that died has already auto-followed to the
  // effective host - `resolvedHostId` names the LIVE host, and the create
  // must land there instead of being refused.
  it("creates on the effective host once a pinned host has auto-followed through death", () => {
    testState.pinIsPinned.current = true;
    testState.placement.current = {
      resolvedHostId: "host-effective",
      client: { getActiveHostId: () => "host-effective" },
      hostLabel: "Home Mac",
      isPinned: true,
      namedHostDead: false,
    };
    renderModal();
    act(() => {
      testState.bodySubmit?.();
    });

    expect(testState.createChat).toHaveBeenCalledTimes(1);
    expect(testState.createChat).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: "host-effective" }),
    );
  });

  // The ordering finding: a refusal that lands after `cleanupAfterSubmit` has
  // already run has destroyed the draft, the staged workspace and the modal.
  it("leaves the draft, the staged intent and the modal intact on refusal", () => {
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(STAGING_KEY, STAGED_INTENT);
    testState.placement.current = {
      resolvedHostId: "host-b",
      client: null,
      hostLabel: "Build Box",
      isPinned: false,
      namedHostDead: false,
    };
    renderModal();
    act(() => {
      testState.bodySubmit?.();
    });

    expect(testState.createChat).not.toHaveBeenCalled();
    expect(draftSurvived()).toBe(true);
    expect(stagedIntent()).toBeDefined();
    expect(testState.onSubmitted).not.toHaveBeenCalled();
  });

  it("refuses when the client no longer addresses the rendered host", () => {
    testState.placement.current = {
      resolvedHostId: "host-b",
      // The chip renders host-b; this client would send to host-a.
      client: { getActiveHostId: () => "host-a" },
      hostLabel: "Build Box",
      isPinned: false,
      namedHostDead: false,
    };
    renderModal();
    act(() => {
      testState.bodySubmit?.();
    });

    expect(testState.createChat).not.toHaveBeenCalled();
    expect(noticeText()).toContain("Build Box");
  });

  // A placement refusal names the placement it refused, so
  // ANY change of the RESOLVED host retires it - a derivation move or the
  // picker writing a new pin. A surviving alert would keep naming a placement
  // this modal has already left.
  it("clears a refused notice when the resolved host changes", () => {
    testState.placement.current = {
      resolvedHostId: "host-b",
      // The chip renders host-b; this client would send to host-a - refused.
      client: { getActiveHostId: () => "host-a" },
      hostLabel: "Build Box",
      isPinned: false,
      namedHostDead: false,
    };
    const view = renderModal();
    act(() => {
      testState.bodySubmit?.();
    });

    expect(noticeText()).toContain("Build Box");

    // The resolved host moves - to a placement that would itself be usable,
    // which is the point: the notice must clear on the move alone, not on
    // whether the new placement also refuses.
    testState.placement.current = {
      resolvedHostId: "host-c",
      client: { getActiveHostId: () => "host-c" },
      hostLabel: "Home Mac",
      isPinned: false,
      namedHostDead: false,
    };
    act(() => {
      view.rerender(<Harness />);
    });

    expect(screen.queryByTestId("composer-host-notice")).toBeNull();
  });

  it("P2 FIX - and keeps it retired across a round trip back to the refused host", () => {
    // The per-Epic pin is as sticky as the landing composer's, so B -> C -> B
    // happens on its own. Retiring the refusal on the FIRST move is what makes
    // the return quiet; comparing it against the host it was raised for would
    // bring the alert back with no submit behind it.
    const resolveTo = (hostId: string, hostLabel: string): void => {
      testState.placement.current = {
        resolvedHostId: hostId,
        client: { getActiveHostId: () => hostId },
        hostLabel,
        isPinned: true,
        namedHostDead: false,
      };
    };
    testState.placement.current = {
      resolvedHostId: "host-b",
      client: { getActiveHostId: () => "host-a" },
      hostLabel: "Build Box",
      isPinned: true,
      namedHostDead: false,
    };
    const view = renderModal();
    act(() => {
      testState.bodySubmit?.();
    });
    expect(noticeText()).toContain("Build Box");

    resolveTo("host-c", "Home Mac");
    act(() => {
      view.rerender(<Harness />);
    });
    expect(screen.queryByTestId("composer-host-notice")).toBeNull();

    resolveTo("host-b", "Build Box");
    act(() => {
      view.rerender(<Harness />);
    });
    expect(screen.queryByTestId("composer-host-notice")).toBeNull();
  });

  it("refuses the TERMINAL path on the same verdict, creating nothing", () => {
    useNewConversationModalStore
      .getState()
      .setComposerMode("epic-1", "terminal");
    testState.placement.current = {
      resolvedHostId: "host-b",
      client: null,
      hostLabel: "Build Box",
      isPinned: false,
      namedHostDead: false,
    };
    renderModal();
    act(() => {
      testState.bodyStartTerminal?.(
        {
          harnessId: "claude",
          model: null,
          reasoningEffort: null,
          terminalAgentArgs: null,
          profileId: null,
        },
        "host-b",
      );
    });

    expect(testState.createTerminalAgent).not.toHaveBeenCalled();
    expect(draftSurvived()).toBe(true);
    expect(testState.onSubmitted).not.toHaveBeenCalled();
  });

  it("G4: a FOLLOWING modal clears its staged intent and toasts when something was staged", () => {
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(STAGING_KEY, STAGED_INTENT);
    renderModal();

    act(() => {
      notifyEffectiveHostChanged("host-a", "host-b");
    });

    expect(stagedIntent()).toBeUndefined();
    expect(toastMocks.toastRepointedStagingReset).toHaveBeenCalledTimes(1);
    expect(toastMocks.toastRepointedStagingReset).toHaveBeenCalledWith(
      testState.placement.current.hostLabel,
    );
    // The inline notice slot is `refused`-only now; a re-point is a toast.
    expect(screen.queryByTestId("composer-host-notice")).toBeNull();
  });

  it("G4: a FOLLOWING modal clears anyway but does not toast when nothing was staged", () => {
    const clearForAllHostsSpy = vi.spyOn(
      useWorktreeIntentStagingStore.getState(),
      "clearForAllHosts",
    );
    renderModal();

    act(() => {
      notifyEffectiveHostChanged("host-a", "host-b");
    });

    expect(clearForAllHostsSpy).toHaveBeenCalledWith(STAGING_KEY);
    expect(stagedIntent()).toBeUndefined();
    expect(toastMocks.toastRepointedStagingReset).not.toHaveBeenCalled();
    expect(screen.queryByTestId("composer-host-notice")).toBeNull();

    clearForAllHostsSpy.mockRestore();
  });

  it("G4: a PINNED modal keeps its staged intent and does not toast (D6)", () => {
    testState.pinIsPinned.current = true;
    testState.followsEffective.current = false;
    testState.placement.current = {
      ...testState.placement.current,
      isPinned: true,
    };
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(STAGING_KEY, STAGED_INTENT);
    renderModal();

    act(() => {
      notifyEffectiveHostChanged("host-a", "host-b");
    });

    expect(stagedIntent()).toBeDefined();
    expect(toastMocks.toastRepointedStagingReset).not.toHaveBeenCalled();
  });

  it("G4: a modal resting on the EPIC's host (default tier, unpinned) keeps its staged intent", () => {
    // The third state the per-Epic placement introduced: no pin, but the
    // session's host answered rather than `effective`. A gate keyed on
    // `isPinned` alone would clear this modal's staged intent and announce a
    // move that did not happen to it.
    testState.pinIsPinned.current = false;
    testState.followsEffective.current = false;
    testState.placement.current = {
      resolvedHostId: "host-session",
      client: { getActiveHostId: () => "host-session" },
      hostLabel: "Studio Mac",
      isPinned: false,
      namedHostDead: false,
    };
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(STAGING_KEY, STAGED_INTENT);
    renderModal();

    act(() => {
      notifyEffectiveHostChanged("host-a", "host-b");
    });

    expect(stagedIntent()).toBeDefined();
    expect(toastMocks.toastRepointedStagingReset).not.toHaveBeenCalled();
    // And no move narrated: there is no notice at all.
    expect(screen.queryByTestId("composer-host-notice")).toBeNull();
  });

  it("asks the per-EPIC placement for THIS epic with the session's host as its default", () => {
    // The modal used to resolve the landing composer's
    // window-keyed pin ?? effective, so a new agent in an Epic served from B
    // landed on wherever the window's landing chip pointed. The placement now
    // resolves per Epic with the session's host as the default tier; this
    // pins the modal hands it exactly that - not the app-wide host, and not
    // nothing.
    renderModal();
    expect(testState.placementInputs.length).toBeGreaterThan(0);
    for (const input of testState.placementInputs) {
      expect(input).toEqual({
        epicId: "epic-1",
        overrideHostId: null,
        sessionHostId: "host-session",
      });
    }
  });

  it("keeps the workspace picker selectable on the RESOLVED host and seeds from it", () => {
    // The request is unnamed (`hostId: null`) and the
    // placement resolves it to host-a through the Epic's tiers. The picker
    // and the seed used to key on the raw request field, so they browsed and
    // seeded from the app-wide host while the create went to host-a. An
    // unnamed request must still expose the Epic-local placement callback so
    // the user can switch hosts before submitting.
    testState.placement.current = {
      resolvedHostId: "host-session",
      client: { getActiveHostId: () => "host-session" },
      hostLabel: "Studio Mac",
      isPinned: false,
      namedHostDead: false,
    };
    testState.followsEffective.current = false;
    renderModal();

    const scopes = testState.workspaceControlsElements.map(
      workspaceControlsHostScope,
    );
    expect(scopes.length).toBeGreaterThan(0);
    for (const scope of scopes) {
      expect(scope).toMatchObject({
        kind: "selected",
        hostId: "host-session",
        onSelect: testState.recordPlacement,
        unselectableExceptHostId: null,
        onlyHostIds: null,
      });
    }
    expect(testState.latestSeedPins.length).toBeGreaterThan(0);
    for (const pin of testState.latestSeedPins) {
      expect(pin).toMatchObject({ hostId: "host-session" });
    }
  });

  it("records the host it created on as the Epic's placement memory, on submit", () => {
    // "Last created chat's host": the create WRITES the per-Epic pin with the
    // host it resolved, at submit (beside the settings memory), so the next
    // new agent in this Epic opens on it - the model picker's memory shape.
    renderModal();
    act(() => {
      testState.bodySubmit?.();
    });
    expect(testState.createChat).toHaveBeenCalledTimes(1);
    expect(testState.recordPlacement).toHaveBeenCalledWith("host-a");
  });

  // `clearForAllHosts` reaches every host's copy of the
  // slot, so the "was anything staged" check that decides whether to toast
  // must reach just as far. The narrower `readStagedWorktreeIntent` (scoped to
  // the RESOLVED bucket) reported "nothing staged" here even though the clear
  // below deleted the host-b copy - silently dropping the toast.
  it("G4: toasts when the staged intent lives under a DIFFERENT host bucket than the resolved one", () => {
    const otherHostKey = newConversationModalStagingKey(
      "host-b",
      "epic-1",
      null,
    );
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(otherHostKey, STAGED_INTENT);
    renderModal();

    act(() => {
      notifyEffectiveHostChanged("host-a", "host-b");
    });

    expect(toastMocks.toastRepointedStagingReset).toHaveBeenCalledTimes(1);
    expect(toastMocks.toastRepointedStagingReset).toHaveBeenCalledWith(
      testState.placement.current.hostLabel,
    );
    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(otherHostKey)
      ],
    ).toBeUndefined();
  });

  it("does NOT record a placement on a refused submit - nothing was created", () => {
    testState.placement.current = {
      ...testState.placement.current,
      client: { getActiveHostId: () => "host-moved" },
    };
    renderModal();
    act(() => {
      testState.bodySubmit?.();
    });
    expect(testState.createChat).not.toHaveBeenCalled();
    expect(testState.recordPlacement).not.toHaveBeenCalled();
  });
});

// A typed path means something only where the placement host's files are the
// ones the path names. The paste hook decides from this one flag; what it does
// with each answer is pinned in `use-composer-file-attach`.
describe("new-conversation modal: do typed paths reach the placement host", () => {
  it.each([
    { local: "host-a", reaches: true, machine: "this machine" },
    { local: "host-elsewhere", reaches: false, machine: "another machine" },
    { local: null, reaches: false, machine: "no local host known" },
  ])(
    "hands its paste $reaches when the placement host is host-a and this renderer is on $machine",
    ({ local, reaches }) => {
      localHost.id = local;

      renderModal();

      expect(testState.pastePathsReachTarget).toBe(reaches);
    },
  );

  it("hands its paste false when the placement has no host, even where this renderer knows none either", () => {
    localHost.id = null;
    testState.placement.current = {
      resolvedHostId: null,
      client: null,
      hostLabel: "No host",
      isPinned: false,
      namedHostDead: false,
    };

    renderModal();

    expect(testState.pastePathsReachTarget).toBe(false);
  });
});

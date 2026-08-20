import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComposerBodyProps } from "@/components/home/composer/composer-body";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import { createComposerEditorIncarnation } from "@/lib/composer/composer-editor-incarnation";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { LandingPlacementTarget } from "@/lib/composer/landing-placement";
import { notifyEffectiveHostChanged } from "@/stores/host/surface-host-selection-store";
import type { WorktreeIntent } from "@traycer/protocol/host/worktree-schemas";
import type { WorktreeStagingKey } from "@/stores/worktree/worktree-intent-staging-store";
import { LandingComposer } from "@/components/home/composer/landing-composer";

/**
 * F4, wiring half: the landing composer must hand its actions the FROZEN
 * submit target, not the mutable read one.
 *
 * `useComposerPlacement` freezing the client is worthless if the composer
 * passes the other target - and that swap is a one-word edit with no type
 * error, because both fields are `LandingPlacementTarget`. Nothing else in the
 * suite notices it: every single-RPC path behaves identically, and only a
 * derivation move between two awaits of the terminal chain tells them apart.
 * So the wiring itself is what gets pinned here.
 */

const DIRTY_CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
};

const READ_TARGET: LandingPlacementTarget = {
  resolvedHostId: "host-a",
  client: null,
  hostLabel: "read-client-target",
  isPinned: false,
  namedHostDead: false,
};

const SUBMIT_TARGET: LandingPlacementTarget = {
  resolvedHostId: "host-a",
  client: null,
  hostLabel: "frozen-submit-target",
  isPinned: false,
  namedHostDead: false,
};

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

const testState = vi.hoisted(() => ({
  bodySubmit: null as (() => void) | null,
  installEditor: null as (() => void) | null,
  snapshot: null as (() => void) | null,
  ingesting: false,
  createPending: false,
  pasteDisabled: false,
  resolvingPaths: false,
  runPendingImageJob: null as
    ((job: (signal: AbortSignal) => Promise<void>) => void) | null,
  /** The target `useLandingComposerActions` was actually constructed with. */
  actionsTarget: null as { readonly hostLabel: string } | null,
  // G4 fixture: `ComposerPlacement.followsEffective` as `useComposerPlacement`
  // would compute it. Set per test - `true` for a following composer
  // (including a DEPOSED pin, which still reads `isPinned: true`), `false`
  // for a genuinely pinned one.
  composerFollowsEffective: true,
  // `pin.isPinned` varies INDEPENDENTLY of `followsEffective` - a deposed pin
  // is the case where both are `true` at once (the pin survives death;
  // `honoredSelection` going null is what makes it follow). Fixed `true` by
  // default so the deposed-pin arm below is the realistic shape, not a case
  // `isPinned` would never actually take.
  composerIsPinned: true,
}));

// `.clear`/`.migrateKeyForAllHosts` are the only members the G4 effect and
// the create path touch (`.getState()` only, never the reactive hook), so a
// bare `getState()` stub is a complete fixture for this module.
// `readStagedWorktreeIntent` is a plain named export (not read off
// `.getState()`), so it is mocked as its own top-level export here - the
// component imports it directly to decide whether the G4 move actually reset
// anything before it toasts.
const stagingStoreMocks = vi.hoisted(() => ({
  clear: vi.fn(),
  migrateKeyForAllHosts: vi.fn(),
  readStagedWorktreeIntent: vi.fn<
    (key: WorktreeStagingKey) => WorktreeIntent | null
  >(() => null),
}));
vi.mock("@/stores/worktree/worktree-intent-staging-store", () => ({
  useWorktreeIntentStagingStore: {
    getState: () => ({
      clear: stagingStoreMocks.clear,
      migrateKeyForAllHosts: stagingStoreMocks.migrateKeyForAllHosts,
    }),
  },
  readStagedWorktreeIntent: stagingStoreMocks.readStagedWorktreeIntent,
}));

// The G4 toast, mocked so these tests assert the composer's decision to fire
// it (and with what label) rather than sonner's internals.
const toastMocks = vi.hoisted(() => ({
  toastRepointedStagingReset: vi.fn<(hostLabel: string) => void>(),
}));
vi.mock("@/lib/composer/repointed-staging-toast", () => ({
  toastRepointedStagingReset: toastMocks.toastRepointedStagingReset,
}));

vi.mock("@/components/home/composer/composer-body", async () => {
  const React = await import("react");
  return {
    ComposerBody: (props: ComposerBodyProps) => {
      testState.bodySubmit = props.onSubmit;
      testState.installEditor = () => {
        props.editorRef.current = editorHandle();
      };
      // Renders `topBanner` for real (unlike every other prop here) so the
      // G4 tests below can assert on `ComposerHostNotice`'s actual DOM output
      // instead of reaching into component-internal state.
      return React.createElement("div", null, props.topBanner);
    },
  };
});

vi.mock("@/hooks/host/use-composer-placement", () => ({
  useComposerPlacement: () => ({
    pin: {
      selection: null,
      setSelection: () => undefined,
      resolvedHostId: "host-a",
      isPinned: testState.composerIsPinned,
      latchOnFirstUse: () => undefined,
    },
    target: READ_TARGET,
    submitTarget: SUBMIT_TARGET,
    hostLabelFor: () => "Studio Mac",
    followsEffective: testState.composerFollowsEffective,
  }),
}));

vi.mock("@/components/home/hooks/use-landing-composer-actions", () => ({
  useLandingComposerActions: (target: { readonly hostLabel: string }) => {
    testState.actionsTarget = target;
    return { submit: () => null, selectTerminalAgent: () => null };
  },
}));

vi.mock("@/stores/settings/settings-store", () => {
  const state = { composerMode: "chat", setComposerMode: vi.fn() };
  return {
    useSettingsStore: (selector: (value: typeof state) => unknown) =>
      selector(state),
  };
});

vi.mock("@/stores/home/landing-draft-store", () => {
  const state = {
    drafts: [],
    setDraftComposerMode: vi.fn(),
    setDraftSettings: vi.fn(),
    createDraft: vi.fn(() => "draft-for-test"),
    // handleSnapshot's unbound-create branch now calls createDraftWithId
    // (reusing a pre-minted pendingCreateId when present) rather than
    // createDraft directly.
    createDraftWithId: vi.fn(() => "draft-for-test"),
    setDraftContent: vi.fn(),
  };
  const useLandingDraftStore = Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    { getState: () => state },
  );
  return {
    useLandingDraftStore,
  };
});

vi.mock("@/stores/composer/composer-run-settings-store", () => {
  const state = {
    globalLastRunSettings: null,
    setGlobalRunSettings: vi.fn(),
  };
  const selectGlobalLastRunSettings = () => null;
  const useComposerRunSettingsStore = Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    { getState: () => state },
  );
  return {
    useComposerRunSettingsStore,
    selectGlobalLastRunSettings,
  };
});

vi.mock("@/components/home/hooks/use-composer-toolbar-store", async () => {
  const { createStore } = await import("zustand/vanilla");
  const toolbarStore = createStore(() => ({
    selection: {
      harnessId: "claude",
      modelSlug: "claude-sonnet",
      profileId: null,
    },
    permission: "supervised",
    reasoning: "medium",
    serviceTier: "",
    agentMode: "regular",
  }));
  return { useComposerToolbarStore: () => toolbarStore };
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

vi.mock("@/hooks/composer/use-landing-composer-paste", async (importActual) => {
  const actual =
    await importActual<
      typeof import("@/hooks/composer/use-landing-composer-paste")
    >();
  return {
    ...actual,
    useLandingComposerPaste: (params: { readonly disabled: boolean }) => {
      testState.pasteDisabled = params.disabled;
      // Mirror runPendingImageJob → isIngestingImages so submit gating covers
      // the in-place paste path (not the deleted attach-at-anchor path).
      const runPendingImageJob = (
        job: (signal: AbortSignal) => Promise<void>,
      ) => {
        testState.ingesting = true;
        const controller = new AbortController();
        void job(controller.signal).finally(() => {
          testState.ingesting = false;
        });
      };
      testState.runPendingImageJob = runPendingImageJob;
      return {
        onPaste: vi.fn(),
        onDrop: vi.fn(),
        onDragOver: vi.fn(),
        onDragEnter: vi.fn(),
        onDragLeave: vi.fn(),
        attachImageFiles: vi.fn(),
        runPendingImageJob,
        isDraggingFiles: false,
        dragOverlayVariant: null,
        isIngestingImages: testState.ingesting,
        isResolvingFilePaths: testState.resolvingPaths,
      };
    },
  };
});

vi.mock("@/hooks/workspace/use-resolved-workspace-folders-query", () => ({
  useResolvedWorkspaceFolders: () => ({ folders: [], isLoading: false }),
}));

vi.mock("@/lib/composer/workspace-composer-availability", () => ({
  deriveFolderlessAllowedWorkspaceAvailability: () => ({
    disabledHint: null,
  }),
  workspaceComposerCanStart: () => true,
}));

vi.mock("@/components/home/composer/surface-activity-hooks", () => ({
  useSurfaceActivity: () => true,
}));
vi.mock("@/components/chat/composer/picker/use-composer-picker-items", () => ({
  useComposerPickerItems: () => undefined,
}));
vi.mock("@/hooks/composer/use-workspace-mention-roots", () => ({
  useLandingComposerMentionRoots: () => [],
}));
vi.mock("@/hooks/providers/use-provider-pack-gate", () => ({
  // Same treatment as `use-composer-dictation` above: a host-backed readiness
  // hook stubbed to its "nothing to report" answer so these gate tests stay
  // about the gate they name. `blocked: false` is also the hook's real
  // fail-open answer before `providers.list` resolves.
  useProviderPackGate: () => ({ blocked: false, hint: null, preparing: null }),
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
vi.mock("@/hooks/composer/use-landing-image-fetcher", () => ({
  useLandingImageFetcher: () => vi.fn(),
}));
vi.mock("@/hooks/epic/use-epic-create-mutation", () => ({
  useEpicCreateForClient: () => ({ isPending: testState.createPending }),
}));
vi.mock("@/hooks/agent/use-create-tui-agent", () => ({
  useCreateTuiAgentForClient: () => ({ isPending: false }),
}));

vi.mock("@/lib/host", () => ({
  useHostBinding: () => null,
  useHostClient: () => null,
  // The SPINE, a separate export since redesign P2.1.
  useHostRuntimeClient: () => null,
}));
vi.mock(
  "@/components/chat/composer/use-profile-rate-limit-switch-prompt",
  () => ({
    useProfileRateLimitSwitchPrompt: () => ({
      kind: "hidden",
      dismiss: vi.fn(),
    }),
  }),
);
vi.mock("@/hooks/providers/use-refresh-providers-list-on-turn", () => ({
  useRefreshProvidersListOnTurn: () => undefined,
}));

afterEach(() => {
  cleanup();
  testState.actionsTarget = null;
  testState.bodySubmit = null;
  testState.installEditor = null;
  testState.composerFollowsEffective = true;
  testState.composerIsPinned = true;
  stagingStoreMocks.clear.mockReset();
  stagingStoreMocks.migrateKeyForAllHosts.mockReset();
  stagingStoreMocks.readStagedWorktreeIntent.mockReset();
  stagingStoreMocks.readStagedWorktreeIntent.mockReturnValue(null);
  toastMocks.toastRepointedStagingReset.mockReset();
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
    insertImageAttachments: () => undefined,
    insertMentionAttachment: () => false,
    beginPathInsertion: () => null,
    rewriteImageAttachmentHashById: () => false,
    removeImageAttachmentById: () => undefined,
    insertDictatedText: () => undefined,
    dismissActiveSuggestion: () => false,
  };
}

describe("landing composer placement wiring", () => {
  it("constructs its actions with the FROZEN submit target", () => {
    render(
      <LandingComposer
        draftId={null}
        pendingCreateId="pending-1"
        initialSettings={null}
        workspaceControls={() => null}
      />,
    );

    // Identity, not shape: the two targets differ only in their client, so an
    // equality check on fields would pass for either one.
    expect(testState.actionsTarget).toBe(SUBMIT_TARGET);
    expect(testState.actionsTarget).not.toBe(READ_TARGET);
  });
});

describe("landing composer G4 re-point", () => {
  it("clears staged intent and toasts for a DEPOSED pin (isPinned true, honoredSelection null) when intent was staged", () => {
    // A deposed pin still reads `pin.isPinned: true` (the pin itself is never
    // cleared by death - only `honoredSelection` goes null), but the
    // composer's resolved host has fallen back to `effective`, so it IS
    // following and a derivation move DOES re-point it. Gating G4 on
    // `isPinned` instead of `followsEffective` would wrongly suppress this.
    testState.composerFollowsEffective = true;
    stagingStoreMocks.readStagedWorktreeIntent.mockReturnValue(STAGED_INTENT);
    render(
      <LandingComposer
        draftId={null}
        pendingCreateId="pending-1"
        initialSettings={null}
        workspaceControls={() => null}
      />,
    );

    act(() => {
      notifyEffectiveHostChanged("host-a", "host-b");
    });

    expect(stagingStoreMocks.clear).toHaveBeenCalledWith({
      surface: "landing",
      hostId: "host-a",
      draftId: null,
    });
    expect(toastMocks.toastRepointedStagingReset).toHaveBeenCalledTimes(1);
    expect(toastMocks.toastRepointedStagingReset).toHaveBeenCalledWith(
      "Studio Mac",
    );
    // The inline notice slot is `refused`-only now; a re-point is a toast.
    expect(screen.queryByTestId("composer-host-notice")).toBeNull();
  });

  it("clears staged intent but does not toast for a DEPOSED pin when nothing was staged", () => {
    testState.composerFollowsEffective = true;
    stagingStoreMocks.readStagedWorktreeIntent.mockReturnValue(null);
    render(
      <LandingComposer
        draftId={null}
        pendingCreateId="pending-1"
        initialSettings={null}
        workspaceControls={() => null}
      />,
    );

    act(() => {
      notifyEffectiveHostChanged("host-a", "host-b");
    });

    expect(stagingStoreMocks.clear).toHaveBeenCalledWith({
      surface: "landing",
      hostId: "host-a",
      draftId: null,
    });
    expect(toastMocks.toastRepointedStagingReset).not.toHaveBeenCalled();
    expect(screen.queryByTestId("composer-host-notice")).toBeNull();
  });

  it("does not clear staged intent or toast for a composer resting on its own pin", () => {
    testState.composerFollowsEffective = false;
    render(
      <LandingComposer
        draftId={null}
        pendingCreateId="pending-1"
        initialSettings={null}
        workspaceControls={() => null}
      />,
    );

    act(() => {
      notifyEffectiveHostChanged("host-a", "host-b");
    });

    expect(screen.queryByTestId("composer-host-notice")).toBeNull();
    expect(stagingStoreMocks.clear).not.toHaveBeenCalled();
    expect(toastMocks.toastRepointedStagingReset).not.toHaveBeenCalled();
  });
});

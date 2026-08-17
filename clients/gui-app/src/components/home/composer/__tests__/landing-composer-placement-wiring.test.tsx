import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComposerBodyProps } from "@/components/home/composer/composer-body";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import { createComposerEditorIncarnation } from "@/lib/composer/composer-editor-incarnation";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { LandingPlacementTarget } from "@/lib/composer/landing-placement";
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
}));

vi.mock("@/components/home/composer/composer-body", async () => {
  const React = await import("react");
  return {
    ComposerBody: (props: ComposerBodyProps) => {
      testState.bodySubmit = props.onSubmit;
      testState.installEditor = () => {
        props.editorRef.current = editorHandle();
      };
      return React.createElement("div", null);
    },
  };
});

vi.mock("@/hooks/host/use-composer-placement", () => ({
  useComposerPlacement: () => ({
    pin: {
      selection: null,
      setSelection: () => undefined,
      resolvedHostId: "host-a",
      isPinned: false,
      latchOnFirstUse: () => undefined,
    },
    target: READ_TARGET,
    submitTarget: SUBMIT_TARGET,
    hostLabelFor: () => "Studio Mac",
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

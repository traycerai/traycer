import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import type { JsonContent } from "@traycer/protocol/common/registry";

import type { ComposerBodyProps } from "@/components/home/composer/composer-body";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import { createComposerEditorIncarnation } from "@/lib/composer/composer-editor-incarnation";
import { LandingComposer } from "../landing-composer";

const DIRTY_CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "dirty" }] }],
};

const testState = vi.hoisted(() => ({
  submit: vi.fn(),
  bodySubmit: null as (() => void) | null,
  installEditor: null as (() => void) | null,
  snapshot: null as (() => void) | null,
  ingesting: false,
  createPending: false,
  pasteDisabled: false,
  resolvingPaths: false,
  /** Captures the real-ish pending job runner used by in-place landing paste. */
  runPendingImageJob: null as
    ((job: (signal: AbortSignal) => Promise<void>) => void) | null,
}));

vi.mock("@/components/home/composer/composer-body", async () => {
  const React = await import("react");
  return {
    ComposerBody: (props: ComposerBodyProps) => {
      testState.bodySubmit = props.onSubmit;
      testState.installEditor = () => {
        props.editorRef.current = editorHandle();
      };
      testState.snapshot = () => {
        props.onDocumentChange(DIRTY_CONTENT, { from: 1, to: 1 });
      };
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(
          "button",
          {
            type: "button",
            disabled: props.isSubmitting,
            onClick: props.onSubmit,
          },
          "Submit landing",
        ),
        props.workspaceControls,
      );
    },
  };
});

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
    globalLastRunSettingsByHostId: {},
    legacyGlobalLastRunSettings: null,
    setGlobalRunSettings: vi.fn(),
    // The imperative draft-mint path (`ensureSubmissionDraft`) seeds from
    // this; null preserves the suite's "no remembered last-run" premise.
    getGlobalRunSettings: () => null,
  };
  const useComposerRunSettingsStore = Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    { getState: () => state },
  );
  return {
    useComposerRunSettingsStore,
    selectGlobalLastRunSettings: () => null,
  };
});

vi.mock("@/components/home/hooks/use-composer-toolbar-store", () => {
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

vi.mock("@/components/home/hooks/use-landing-composer-actions", () => ({
  useLandingComposerActions: () => ({
    submit: testState.submit,
    selectTerminalAgent: vi.fn(),
    // `isSubmitting` now reads `actions.isPending` (the real hook's
    // `createEpic.isPending || terminalAgentCreate.isPending`) rather than a
    // permanently-false placeholder - mirror `testState.createPending` here
    // too, the same flag the neighboring `useEpicCreateForClient` mock below
    // already drives, so this gate suite's "a create is in flight" setup
    // still reaches the composer now that it goes through this seam.
    isPending: testState.createPending,
  }),
}));

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

vi.mock("@/components/chat/composer/use-profile-eligibility-gate", () => ({
  useProfileEligibilityGate: () => ({
    disabled: false,
    profileLabel: null,
    enablePending: false,
    enableProfile: vi.fn(),
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
// `useEpicCreateForClient`/`useCreateTuiAgentForClient` mocks used to live
// here, driven by `testState.createPending`. Before the isSubmitting change,
// `landing-composer.tsx` called `useEpicCreateForClient` itself and these
// mocks were reachable - that is what made "locks editor input... during a
// submission" pass for a reason production could never produce: the
// composer's own `isPending` observer was permanently false, so the mock was
// supplying the very behaviour the real code was incapable of. Now that
// `isSubmitting` reads `actions.isPending` through the (fully-stubbed)
// `useLandingComposerActions` mock above instead, nothing in the mounted
// tree reaches these two hooks - confirmed by removing them and finding the
// suite stays green. Left removed rather than kept as a second, unreachable
// copy of the same intent.
// P1.2: the composer resolves its placement (pin ?? effective) through this
// one hook. These suites are about paste/gating/banner behaviour, not
// selection derivation, so it is stubbed at that single boundary - the same
// treatment the other host-backed hooks above get.
vi.mock("@/hooks/host/use-composer-placement", () => ({
  useComposerPlacement: () => ({
    pin: {
      selection: null,
      setSelection: () => undefined,
      resolvedHostId: "host-test",
      isPinned: false,
      latchOnFirstUse: () => undefined,
    },
    target: {
      resolvedHostId: "host-test",
      client: null,
      hostLabel: "Local",
      isPinned: false,
      namedHostDead: false,
    },
    hostLabelFor: () => "Local",
  }),
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
  testState.submit.mockClear();
  testState.bodySubmit = null;
  testState.installEditor = null;
  testState.snapshot = null;
  testState.ingesting = false;
  testState.createPending = false;
  testState.pasteDisabled = false;
  testState.resolvingPaths = false;
  testState.runPendingImageJob = null;
});

describe("LandingComposer direct submit gate", () => {
  it("locks editor input, paste ingestion, and workspace controls during a submission", () => {
    testState.createPending = true;
    render(
      <LandingComposer
        draftId={null}
        pendingCreateId={null}
        initialSettings={null}
        workspaceControls={(disabled) => (
          <button type="button" disabled={disabled}>
            Change workspace
          </button>
        )}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Submit landing" }),
    ).toHaveProperty("disabled", true);
    expect(testState.pasteDisabled).toBe(true);
    expect(
      screen.getByRole("button", { name: "Change workspace" }),
    ).toHaveProperty("disabled", true);
  });

  it("blocks the actual landing submit path while image ingestion is pending", () => {
    testState.ingesting = true;
    const view = render(
      <LandingComposer
        draftId={null}
        pendingCreateId={null}
        initialSettings={null}
        workspaceControls={() => null}
      />,
    );
    const installEditor = testState.installEditor;
    if (installEditor === null) throw new Error("expected ComposerBody seam");
    installEditor();
    const snapshot = testState.snapshot;
    if (snapshot === null) throw new Error("expected snapshot seam");
    snapshot();

    fireEvent.click(screen.getByRole("button", { name: "Submit landing" }));
    expect(testState.submit).not.toHaveBeenCalled();

    testState.ingesting = false;
    view.rerender(
      <LandingComposer
        draftId={null}
        pendingCreateId={null}
        initialSettings={null}
        workspaceControls={() => null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Submit landing" }));
    expect(testState.submit).toHaveBeenCalledTimes(1);
  });

  it("submits the draft handleSnapshot minted, not null, while props.draftId is still catching up", () => {
    // The real race: the first submittable edit mints an unbound draft inside
    // this component, but `props.draftId` only flips on the parent's next
    // render - so a type-then-Enter submits with the prop still `null`. If that
    // `null` reaches the action, `ensureSubmissionDraft` mints a SECOND draft
    // and the one already holding the user's content is stranded. Nothing
    // re-render carries a new `draftId`, so the prop is still `null` at submit
    // time exactly as it is in the app.
    const view = render(
      <LandingComposer
        draftId={null}
        pendingCreateId={null}
        initialSettings={null}
        workspaceControls={() => null}
      />,
    );
    const installEditor = testState.installEditor;
    if (installEditor === null) throw new Error("expected ComposerBody seam");
    installEditor();
    const snapshot = testState.snapshot;
    if (snapshot === null) throw new Error("expected snapshot seam");
    snapshot();
    // Re-render so the composer observes the content it just snapshotted and
    // opens the submit gate - still with `draftId={null}`, which is the point.
    view.rerender(
      <LandingComposer
        draftId={null}
        pendingCreateId={null}
        initialSettings={null}
        workspaceControls={() => null}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Submit landing" }));

    expect(testState.submit).toHaveBeenCalledTimes(1);
    expect(testState.submit.mock.calls[0][0]).toMatchObject({
      draftId: "draft-for-test",
    });
  });

  // Item 8: a live runPendingImageJob (landing in-place paste) holds submit closed
  // until the job settles, then clears.
  it("blocks submit while a runPendingImageJob is in flight and opens after it settles", async () => {
    const gate: { release: (() => void) | null } = { release: null };
    const view = render(
      <LandingComposer
        draftId={null}
        pendingCreateId={null}
        initialSettings={null}
        workspaceControls={() => null}
      />,
    );
    const installEditor = testState.installEditor;
    if (installEditor === null) throw new Error("expected ComposerBody seam");
    installEditor();
    const snapshot = testState.snapshot;
    if (snapshot === null) throw new Error("expected snapshot seam");
    snapshot();
    const runPending = testState.runPendingImageJob;
    if (runPending === null)
      throw new Error("expected runPendingImageJob seam");

    runPending(async () => {
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
    });
    // LandingComposer reads isIngestingImages on render; force a re-render.
    view.rerender(
      <LandingComposer
        draftId={null}
        pendingCreateId={null}
        initialSettings={null}
        workspaceControls={() => null}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Submit landing" }));
    expect(testState.submit).not.toHaveBeenCalled();

    const release = gate.release;
    if (release === null) throw new Error("expected pending job gate");
    release();
    // Allow the job finally to clear ingesting, then re-render.
    await Promise.resolve();
    await Promise.resolve();
    view.rerender(
      <LandingComposer
        draftId={null}
        pendingCreateId={null}
        initialSettings={null}
        workspaceControls={() => null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Submit landing" }));
    expect(testState.submit).toHaveBeenCalledTimes(1);
  });

  // Finding 3: pure path-resolution must also hold submit open.
  it("blocks the actual landing submit path while file-path resolution is pending", () => {
    testState.resolvingPaths = true;
    const view = render(
      <LandingComposer
        draftId={null}
        pendingCreateId={null}
        initialSettings={null}
        workspaceControls={() => null}
      />,
    );
    const installEditor = testState.installEditor;
    if (installEditor === null) throw new Error("expected ComposerBody seam");
    installEditor();
    const snapshot = testState.snapshot;
    if (snapshot === null) throw new Error("expected snapshot seam");
    snapshot();

    fireEvent.click(screen.getByRole("button", { name: "Submit landing" }));
    expect(testState.submit).not.toHaveBeenCalled();

    testState.resolvingPaths = false;
    view.rerender(
      <LandingComposer
        draftId={null}
        pendingCreateId={null}
        initialSettings={null}
        workspaceControls={() => null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Submit landing" }));
    expect(testState.submit).toHaveBeenCalledTimes(1);
  });
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

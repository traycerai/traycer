import "../../../../../__tests__/test-browser-apis";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import type { JsonContent } from "@traycer/protocol/common/registry";

import type { ComposerBodyProps } from "@/components/home/composer/composer-body";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import { LandingComposer } from "../landing-composer";

const DIRTY_CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "dirty" }] }],
};

const testState = vi.hoisted(() => ({
  submit: vi.fn(),
  bodySubmit: null as (() => void) | null,
  installEditor: null as (() => void) | null,
  ingesting: false,
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
      return React.createElement(
        "button",
        { type: "button", onClick: props.onSubmit },
        "Submit landing",
      );
    },
  };
});

vi.mock("@/stores/composer/landing-composer-store", () => {
  const dirtyContent = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "dirty" }] },
    ],
  };
  const state = {
    currentContent: dirtyContent,
    setSnapshot: vi.fn(),
    openDraft: () => dirtyContent,
  };
  const useLandingComposerStore = Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    { getState: () => state },
  );
  return {
    useLandingComposerStore,
    flushPendingLandingDraftContent: vi.fn(),
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
  };
  return {
    useLandingDraftStore: (selector: (value: typeof state) => unknown) =>
      selector(state),
  };
});

vi.mock("@/stores/composer/composer-run-settings-store", () => {
  const state = {
    globalLastRunSettings: null,
    setGlobalRunSettings: vi.fn(),
  };
  return {
    useComposerRunSettingsStore: (selector: (value: typeof state) => unknown) =>
      selector(state),
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
    useLandingComposerPaste: () => {
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
  useEpicCreate: () => ({ isPending: false }),
}));
vi.mock("@/hooks/agent/use-create-tui-agent", () => ({
  useCreateTuiAgent: () => ({ isPending: false }),
}));
vi.mock("@/lib/host", () => ({
  useHostBinding: () => null,
  useHostClient: () => null,
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
vi.mock(
  "@/hooks/providers/use-refresh-providers-list-on-turn-default-host",
  () => ({
    useRefreshProvidersListOnTurnDefaultHost: () => undefined,
  }),
);

afterEach(() => {
  cleanup();
  testState.submit.mockClear();
  testState.bodySubmit = null;
  testState.installEditor = null;
  testState.ingesting = false;
  testState.resolvingPaths = false;
  testState.runPendingImageJob = null;
});

describe("LandingComposer direct submit gate", () => {
  it("blocks the actual landing submit path while image ingestion is pending", () => {
    testState.ingesting = true;
    const view = render(
      <LandingComposer
        draftId={null}
        initialSettings={null}
        workspaceControls={null}
      />,
    );
    const installEditor = testState.installEditor;
    if (installEditor === null) throw new Error("expected ComposerBody seam");
    installEditor();

    fireEvent.click(screen.getByRole("button", { name: "Submit landing" }));
    expect(testState.submit).not.toHaveBeenCalled();

    testState.ingesting = false;
    view.rerender(
      <LandingComposer
        draftId={null}
        initialSettings={null}
        workspaceControls={null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Submit landing" }));
    expect(testState.submit).toHaveBeenCalledTimes(1);
  });

  // Item 8: a live runPendingImageJob (landing in-place paste) holds submit closed
  // until the job settles, then clears.
  it("blocks submit while a runPendingImageJob is in flight and opens after it settles", async () => {
    const gate: { release: (() => void) | null } = { release: null };
    const view = render(
      <LandingComposer
        draftId={null}
        initialSettings={null}
        workspaceControls={null}
      />,
    );
    const installEditor = testState.installEditor;
    if (installEditor === null) throw new Error("expected ComposerBody seam");
    installEditor();
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
        initialSettings={null}
        workspaceControls={null}
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
        initialSettings={null}
        workspaceControls={null}
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
        initialSettings={null}
        workspaceControls={null}
      />,
    );
    const installEditor = testState.installEditor;
    if (installEditor === null) throw new Error("expected ComposerBody seam");
    installEditor();

    fireEvent.click(screen.getByRole("button", { name: "Submit landing" }));
    expect(testState.submit).not.toHaveBeenCalled();

    testState.resolvingPaths = false;
    view.rerender(
      <LandingComposer
        draftId={null}
        initialSettings={null}
        workspaceControls={null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Submit landing" }));
    expect(testState.submit).toHaveBeenCalledTimes(1);
  });
});

function editorHandle(): ComposerPromptEditorHandle {
  return {
    isReady: () => true,
    focus: () => undefined,
    focusAtEnd: () => undefined,
    getJSON: () => DIRTY_CONTENT,
    isEmpty: () => false,
    clear: () => undefined,
    setContent: () => undefined,
    insertImageAttachments: () => undefined,
    beginPathInsertion: () => null,
    rewriteImageAttachmentHashById: () => false,
    removeImageAttachmentById: () => undefined,
    insertDictatedText: () => undefined,
    dismissActiveSuggestion: () => false,
  };
}

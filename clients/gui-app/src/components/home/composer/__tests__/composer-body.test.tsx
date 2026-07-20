import "../../../../../__tests__/test-browser-apis";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ClipboardEventHandler, DragEventHandler, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import { ComposerBody } from "@/components/home/composer/composer-body";
import type { ComposerMode } from "@/components/home/data/landing-options";
import type { UseComposerPasteResult } from "@/hooks/composer/use-composer-paste";
import type { FileTransferDragOverlayVariant } from "@/lib/files/file-transfer-paths";
import { createComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";

vi.mock("@/components/chat/composer/composer-prompt-editor", () => ({
  ComposerPromptEditor: (props: {
    readonly onPaste: ClipboardEventHandler<HTMLElement>;
    readonly onDragOver: DragEventHandler<HTMLElement>;
    readonly onDrop: DragEventHandler<HTMLElement>;
  }) => (
    <textarea
      aria-label="Prompt editor"
      onPaste={props.onPaste}
      onDragOver={props.onDragOver}
      onDrop={props.onDrop}
    />
  ),
}));

vi.mock("@/components/home/composer/composer-shell", () => ({
  ComposerShell: (props: {
    readonly onDragOver: DragEventHandler<HTMLElement>;
    readonly onDrop: DragEventHandler<HTMLElement>;
    readonly onDragEnter: DragEventHandler<HTMLElement>;
    readonly onDragLeave: DragEventHandler<HTMLElement>;
    readonly dragOverlayVariant: FileTransferDragOverlayVariant | null;
    readonly editor: ReactNode;
  }) => (
    <div
      role="region"
      aria-label="Composer shell"
      data-testid="composer-card"
      data-overlay={props.dragOverlayVariant ?? "none"}
      onDragOver={props.onDragOver}
      onDrop={props.onDrop}
      onDragEnter={props.onDragEnter}
      onDragLeave={props.onDragLeave}
    >
      {props.editor}
    </div>
  ),
}));

vi.mock("@/components/home/composer/composer-workspace-mode-row", () => ({
  ComposerWorkspaceRow: () => null,
}));

vi.mock("@/components/home/composer/terminal-launch-panel", () => ({
  TerminalLaunchPanel: () => null,
}));

vi.mock("@/components/home/toolbar/composer-toolbar", () => ({
  ComposerToolbar: () => null,
}));

afterEach(cleanup);

function makePaste(): UseComposerPasteResult {
  return {
    onPaste: vi.fn(),
    onDrop: vi.fn(),
    onDragOver: vi.fn(),
    onDragEnter: vi.fn(),
    onDragLeave: vi.fn(),
    attachImageFiles: vi.fn(),
    isDraggingFiles: true,
    dragOverlayVariant: "paths",
    isIngestingImages: false,
    isResolvingFilePaths: false,
  };
}

function renderComposerBody(
  composerMode: ComposerMode,
  paste: UseComposerPasteResult,
  header: ReactNode,
  topBanner: ReactNode,
) {
  const toolbarStore = createComposerToolbarStore({
    seedKey: "test",
    values: {
      permission: "supervised",
      selection: { harnessId: "claude", modelSlug: "", profileId: null },
      reasoning: "",
      serviceTier: "",
      agentMode: "regular",
    },
    onSettingsChange: null,
    tuiOnly: composerMode === "terminal",
  });

  return render(
    <ComposerBody
      pickerStore={createComposerPickerStore()}
      editorRef={{ current: null }}
      toolbarStore={toolbarStore}
      composerMode={composerMode}
      chatEditorIsActive={composerMode === "chat"}
      editorClassName=""
      initialContent={{ type: "doc", content: [] }}
      initialSelection={null}
      canSubmit
      isSubmitting={false}
      attachmentPending={false}
      workspaceDisabledHint={null}
      header={header}
      topBanner={topBanner}
      attachmentsStrip={null}
      workspaceControls={null}
      dictationControl={null}
      dictationPreparing={null}
      paste={paste}
      hasPastedImageBytes={null}
      onSubmit={vi.fn()}
      onStartTerminal={vi.fn()}
      onSnapshot={vi.fn()}
    />,
  );
}

describe("ComposerBody file-transfer routing", () => {
  it("does not dispatch file transfers to the hidden chat editor in terminal mode", () => {
    const paste = makePaste();
    renderComposerBody("terminal", paste, null, null);

    const shell = screen.getByRole("region", { name: "Composer shell" });
    fireEvent.dragEnter(shell);
    fireEvent.dragOver(shell);
    fireEvent.dragLeave(shell);
    fireEvent.drop(shell);
    fireEvent.paste(
      screen.getByRole("textbox", { name: "Prompt editor", hidden: true }),
    );

    expect(paste.onDragEnter).not.toHaveBeenCalled();
    expect(paste.onDragOver).not.toHaveBeenCalled();
    expect(paste.onDragLeave).not.toHaveBeenCalled();
    expect(paste.onDrop).not.toHaveBeenCalled();
    expect(paste.onPaste).not.toHaveBeenCalled();
    expect(shell.getAttribute("data-overlay")).toBe("none");
  });

  it("keeps file-transfer handling active in chat mode", () => {
    const paste = makePaste();
    renderComposerBody("chat", paste, null, null);

    const shell = screen.getByRole("region", { name: "Composer shell" });
    fireEvent.dragEnter(shell);
    fireEvent.dragOver(shell);
    fireEvent.dragLeave(shell);
    fireEvent.drop(shell);
    fireEvent.paste(screen.getByRole("textbox", { name: "Prompt editor" }));

    expect(paste.onDragEnter).toHaveBeenCalledOnce();
    expect(paste.onDragOver).toHaveBeenCalledOnce();
    expect(paste.onDragLeave).toHaveBeenCalledOnce();
    expect(paste.onDrop).toHaveBeenCalledOnce();
    expect(paste.onPaste).toHaveBeenCalledOnce();
    expect(shell.getAttribute("data-overlay")).toBe("paths");
  });
});

describe("ComposerBody topBanner placement", () => {
  it("renders nothing extra when topBanner is null", () => {
    renderComposerBody(
      "chat",
      makePaste(),
      <div data-testid="mode-switch-header">header</div>,
      null,
    );

    expect(screen.queryByTestId("rate-limit-banner")).toBeNull();
    expect(screen.getByTestId("mode-switch-header")).toBeTruthy();
    expect(screen.getByTestId("composer-card")).toBeTruthy();
  });

  it("renders the mode-switch header, then topBanner, then the composer card, in that DOM order", () => {
    const { container } = renderComposerBody(
      "chat",
      makePaste(),
      <div data-testid="mode-switch-header">header</div>,
      <div data-testid="rate-limit-banner">banner</div>,
    );
    const header = screen.getByTestId("mode-switch-header");
    const banner = screen.getByTestId("rate-limit-banner");
    const card = screen.getByTestId("composer-card");

    expect(
      header.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      banner.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    const order = Array.from(
      container.querySelectorAll(
        '[data-testid="mode-switch-header"], [data-testid="rate-limit-banner"], [data-testid="composer-card"]',
      ),
    ).map((element) => element.getAttribute("data-testid"));
    expect(order).toEqual([
      "mode-switch-header",
      "rate-limit-banner",
      "composer-card",
    ]);
  });
});

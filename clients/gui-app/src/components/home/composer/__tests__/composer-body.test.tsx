import "../../../../../__tests__/test-browser-apis";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { UseComposerPasteResult } from "@/hooks/composer/use-composer-paste";
import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import { createComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import { ComposerBody } from "../composer-body";

vi.mock("@/components/home/composer/composer-shell", async () => {
  const React = await import("react");
  return {
    ComposerShell: () =>
      React.createElement("div", { "data-testid": "composer-card" }),
  };
});

const EMPTY_CONTENT: JsonContent = { type: "doc", content: [] };

const paste: UseComposerPasteResult = {
  onPaste: () => undefined,
  onDrop: () => undefined,
  onDragOver: () => undefined,
  onDragEnter: () => undefined,
  onDragLeave: () => undefined,
  attachImageFiles: () => undefined,
  isDraggingFiles: false,
  isIngestingImages: false,
};

function renderComposerBody(showTopBanner: boolean) {
  const toolbarStore = createComposerToolbarStore({
    seedKey: "seed-1",
    values: {
      permission: "supervised",
      selection: { harnessId: "claude", modelSlug: "sonnet", profileId: null },
      reasoning: "medium",
      serviceTier: "",
      agentMode: "regular",
    },
    onSettingsChange: null,
    tuiOnly: false,
  });
  return render(
    <ComposerBody
      pickerStore={createComposerPickerStore()}
      editorRef={{ current: null }}
      toolbarStore={toolbarStore}
      composerMode="chat"
      chatEditorIsActive={false}
      editorClassName=""
      initialContent={EMPTY_CONTENT}
      initialSelection={null}
      canSubmit={false}
      isSubmitting={false}
      attachmentPending={false}
      workspaceDisabledHint={null}
      header={<div data-testid="mode-switch-header">header</div>}
      topBanner={
        showTopBanner ? <div data-testid="rate-limit-banner">banner</div> : null
      }
      attachmentsStrip={null}
      workspaceControls={null}
      dictationControl={null}
      dictationPreparing={null}
      paste={paste}
      hasPastedImageBytes={null}
      onSubmit={() => undefined}
      onStartTerminal={() => undefined}
      onSnapshot={() => undefined}
    />,
  );
}

afterEach(() => {
  cleanup();
});

describe("ComposerBody topBanner placement", () => {
  it("renders nothing extra when topBanner is null", () => {
    renderComposerBody(false);
    expect(screen.queryByTestId("rate-limit-banner")).toBeNull();
    expect(screen.getByTestId("mode-switch-header")).toBeTruthy();
    expect(screen.getByTestId("composer-card")).toBeTruthy();
  });

  it("renders the mode-switch header, then topBanner, then the composer card, in that DOM order", () => {
    const { container } = renderComposerBody(true);
    const header = screen.getByTestId("mode-switch-header");
    const banner = screen.getByTestId("rate-limit-banner");
    const card = screen.getByTestId("composer-card");

    // header precedes banner precedes card
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
    ).map((el) => el.getAttribute("data-testid"));
    expect(order).toEqual([
      "mode-switch-header",
      "rate-limit-banner",
      "composer-card",
    ]);
  });
});

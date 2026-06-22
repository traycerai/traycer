import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChatDiffTargetContext,
  type ChatSnapshotDiffOpener,
} from "@/components/chat/chat-diff-target";
import { OpenFullDiffControl } from "@/components/chat/segments/open-full-diff-control";

function renderControl(input: {
  readonly opener: ChatSnapshotDiffOpener | null;
}) {
  return render(
    <ChatDiffTargetContext.Provider value={input.opener}>
      <OpenFullDiffControl
        filePath="index.md"
        beforeHash="h0"
        afterHash="h1"
        title="Auth Spec"
      />
    </ChatDiffTargetContext.Provider>,
  );
}

describe("<OpenFullDiffControl />", () => {
  afterEach(() => {
    cleanup();
  });

  it("opens a preview on single click and pins on double click, by hash", () => {
    const onClick = vi.fn();
    const onDoubleClick = vi.fn();
    const hash = vi.fn(() => ({ onClick, onDoubleClick }));
    const opener: ChatSnapshotDiffOpener = {
      segment: () => ({ onClick: vi.fn(), onDoubleClick: vi.fn() }),
      cumulative: () => ({ onClick: vi.fn(), onDoubleClick: vi.fn() }),
      cumulativeBundle: () => vi.fn(),
      hash,
    };

    renderControl({ opener });

    // The opener is consulted with the artifact's hashes + title.
    expect(hash).toHaveBeenCalledWith({
      filePath: "index.md",
      beforeHash: "h0",
      afterHash: "h1",
      title: "Auth Spec",
    });

    // Single click opens a non-sticky preview tab (onClick), mirroring a
    // file_change path-click; double click pins it (onDoubleClick).
    const button = screen.getByRole("button", { name: "Open full diff" });
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);

    fireEvent.doubleClick(button);
    expect(onDoubleClick).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when no chat diff target is in context", () => {
    renderControl({ opener: null });

    expect(screen.queryByRole("button", { name: "Open full diff" })).toBeNull();
  });
});

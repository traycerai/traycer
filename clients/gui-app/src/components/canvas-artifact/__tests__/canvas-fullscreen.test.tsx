import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanvasPageError } from "@/lib/sandbox/canvas-bridge";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CanvasFullscreen } from "../canvas-fullscreen";
import type { CanvasFrameEvents } from "../canvas-frame";
import { snapshotFromFixture } from "./canvas-fixtures";

afterEach(() => {
  cleanup();
});

const BOARD = { x: 0, y: 0, w: 320, h: 240 };
const snapshot = snapshotFromFixture({
  pages: [{ id: "page-1", name: "Page 1" }],
  boards: { "home.html": { ...BOARD, title: "Home screen" } },
  notes: {},
  order: ["home.html"],
});

const BOOM: CanvasPageError = { message: "boom in the page", stack: null };

function renderFullscreen(
  path: string,
  errors: Readonly<Record<string, CanvasPageError | null | undefined>>,
  onAddError: CanvasFrameEvents["onAddError"],
): void {
  const events: CanvasFrameEvents = {
    onBridge: () => undefined,
    onStatus: () => undefined,
    onEditPointer: () => undefined,
    onAddError,
  };
  render(
    <TooltipProvider>
      <CanvasFullscreen
        path={path}
        snapshot={snapshot}
        errors={errors}
        events={events}
        viewOnly={false}
        sizing="fit"
        onSizing={() => undefined}
        onSelect={() => undefined}
        onClose={() => undefined}
        container={null}
      />
    </TooltipProvider>,
  );
}

describe("<CanvasFullscreen /> for a board path", () => {
  it("shows the board's title and its error, and hands that error to Add to chat", async () => {
    const onAddError = vi.fn<(path: string, error: CanvasPageError) => void>();
    renderFullscreen("home.html", { "home.html": BOOM }, onAddError);

    expect(
      screen.getByRole("button", { name: "Choose board" }).textContent,
    ).toBe("Home screen");
    expect(screen.getByRole("status").textContent).toBe("boom in the page");
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Add to chat" }));
    expect(onAddError).toHaveBeenCalledWith("home.html", BOOM);
  });

  it("shows no error for a path named like an inherited member, and its path as the title", () => {
    const onAddError = vi.fn<(path: string, error: CanvasPageError) => void>();
    renderFullscreen("constructor", { "home.html": BOOM }, onAddError);

    expect(
      screen.getByRole("button", { name: "Choose board" }).textContent,
    ).toBe("constructor");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add to chat" })).toBeNull();
  });
});

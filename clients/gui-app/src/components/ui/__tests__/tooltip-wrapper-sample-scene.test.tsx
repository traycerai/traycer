/**
 * R3-02. `inert` left the sample scene (L-131), so every control on the
 * editor's canvas is hit-testable again - and Radix Tooltip opens from
 * `onPointerMove` on its trigger and closes on the trigger's `onPointerDown`,
 * which is the one gesture the edit firewall swallows. A label that opens over
 * the canvas therefore covers the hover chip that IS the canvas's hover signal
 * (L-12, L-102) and cannot be dismissed by pressing.
 *
 * Fired as a real `pointerMove` through the real delay rather than through the
 * suite's focus probe, because pointer-move is the path the firewall cannot
 * block: focus is bounced, so a focus-opened tooltip was never the bug.
 */
import "../../../../__tests__/test-browser-apis";

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerAttachImageButton } from "@/components/home/toolbar/composer-attach-image-button";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  TooltipsSuppressedProvider,
  TooltipWrapper,
} from "@/components/ui/tooltip-wrapper";
import { SampleSceneProvider } from "@/components/sample-workspace/sample-scene-provider";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";

/** The shape every dock panel wraps its icon-only actions in. */
function DockPanelAction(): ReactNode {
  return (
    <TooltipWrapper
      label="Stop"
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <span className="inline-flex">
        <Button type="button" variant="ghost" size="xs" aria-label="Stop">
          Stop
        </Button>
      </span>
    </TooltipWrapper>
  );
}

function Scene(props: { readonly suppressed: boolean }): ReactNode {
  return (
    <TooltipProvider>
      <TooltipsSuppressedProvider value={props.suppressed}>
        <ComposerAttachImageButton onAttachImages={() => undefined} />
        <DockPanelAction />
      </TooltipsSuppressedProvider>
    </TooltipProvider>
  );
}

/** Radix opens from `pointermove` after the provider's own delay. */
function hover(trigger: Element): void {
  fireEvent.pointerMove(trigger);
  act(() => {
    vi.advanceTimersByTime(1000);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("tooltips inside the layout editor's sample scene", () => {
  it("opens no label on the sample composer's Attach image chip", () => {
    render(<Scene suppressed />);

    hover(screen.getByRole("button", { name: "Attach image" }));

    expect(screen.queryByRole("tooltip")).toBeNull();
    // No Radix root at all, which is also what takes ~8 of them out of the
    // scene: a suppressed wrapper is the transparent `Slot`.
    expect(document.querySelector('[data-slot="tooltip-trigger"]')).toBeNull();
  });

  it("opens no label on a dock panel's action either", () => {
    render(<Scene suppressed />);

    hover(screen.getByRole("button", { name: "Stop" }));

    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("still opens both outside the sample scene, unchanged", () => {
    render(<Scene suppressed={false} />);

    hover(screen.getByRole("button", { name: "Attach image" }));
    expect(screen.getByRole("tooltip").textContent).toBe("Attach image");

    cleanup();
    render(<Scene suppressed={false} />);
    hover(screen.getByRole("button", { name: "Stop" }));
    expect(screen.getByRole("tooltip").textContent).toBe("Stop");
  });

  it("lets the inspector's own panel republish its controls' labels", () => {
    // How `layout-editor.tsx` keeps the instrument panel's own tooltips: it is
    // a DOM sibling of the column but a React descendant of the provider that
    // suppresses them, so it says otherwise for its own subtree.
    render(
      <TooltipProvider>
        <TooltipsSuppressedProvider value>
          <TooltipsSuppressedProvider value={false}>
            <DockPanelAction />
          </TooltipsSuppressedProvider>
        </TooltipsSuppressedProvider>
      </TooltipProvider>,
    );

    hover(screen.getByRole("button", { name: "Stop" }));

    expect(screen.getByRole("tooltip").textContent).toBe("Stop");
  });

  it("is published by the sample scene for exactly the life of a session", () => {
    // The wiring, at the one place that decides it: the provider covers the
    // real shell as well as the sample body, because the canvas is the whole
    // app column - the status bar and the tab strip are regions too.
    render(
      <TooltipProvider>
        <SampleSceneProvider>
          <DockPanelAction />
        </SampleSceneProvider>
      </TooltipProvider>,
    );
    hover(screen.getByRole("button", { name: "Stop" }));
    expect(screen.getByRole("tooltip").textContent).toBe("Stop");

    act(() => {
      useLayoutEditorStore.getState().beginSession({
        entry: "pointer",
        source: "direct_ui",
        startedAt: 0,
        origin: { kind: "tab" },
      });
    });

    hover(screen.getByRole("button", { name: "Stop" }));
    expect(screen.queryByRole("tooltip")).toBeNull();

    act(() => {
      useLayoutEditorStore.getState().endSession();
    });

    hover(screen.getByRole("button", { name: "Stop" }));
    expect(screen.getByRole("tooltip").textContent).toBe("Stop");
  });
});

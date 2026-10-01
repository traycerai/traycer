import { act, cleanup, render, screen } from "@testing-library/react";
import type { Key, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SampleModelPicker } from "@/components/sample-workspace/sample-model-picker";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";

// The real Virtuoso measures a scroller in a real browser and renders nothing
// in jsdom's zero-height viewport - stubbed the same way the live picker's own
// suite does, as a plain scroller that renders every row `itemContent` hands
// it (the sample list is 3 rows, so there is no windowing to reproduce).
vi.mock("react-virtuoso", async () => {
  const React = await import("react");

  interface MockVirtuosoHandle {
    readonly scrollIntoView: (location: unknown) => void;
    readonly scrollToIndex: (location: unknown) => void;
    readonly scrollBy: (location: unknown) => void;
    readonly scrollTo: (location: unknown) => void;
    readonly autoscrollToBottom: () => void;
    readonly getState: (callback: (state: null) => void) => void;
  }

  interface MockVirtuosoProps {
    readonly id?: string;
    readonly role?: string;
    readonly "aria-label"?: string;
    readonly className?: string;
    readonly data?: ReadonlyArray<unknown>;
    readonly totalCount?: number;
    readonly computeItemKey?: (index: number, item: undefined) => Key;
    readonly itemContent?: (index: number, item: undefined) => ReactNode;
  }

  const Virtuoso = React.forwardRef<MockVirtuosoHandle, MockVirtuosoProps>(
    (props, ref) => {
      React.useImperativeHandle(ref, () => ({
        autoscrollToBottom: () => undefined,
        getState: (callback) => {
          callback(null);
        },
        scrollBy: () => undefined,
        scrollIntoView: () => undefined,
        scrollTo: () => undefined,
        scrollToIndex: () => undefined,
      }));

      const totalCount = props.totalCount ?? props.data?.length ?? 0;
      const children = Array.from({ length: totalCount }, (_unused, index) =>
        React.createElement(
          React.Fragment,
          { key: props.computeItemKey?.(index, undefined) ?? index },
          props.itemContent?.(index, undefined),
        ),
      );

      return React.createElement(
        "div",
        {
          id: props.id,
          role: props.role,
          "aria-label": props["aria-label"],
          className: props.className,
          "data-testid": "virtuoso-scroller",
        },
        ...children,
      );
    },
  );

  return { Virtuoso };
});

function beginSession(): void {
  act(() => {
    useLayoutEditorStore.getState().beginSession({
      entry: "pointer",
      source: "direct_ui",
      startedAt: 0,
      origin: { kind: "tab" },
    });
  });
}

function resetStores(): void {
  useLayoutStore.setState({
    ...DEFAULT_LAYOUT_SNAPSHOT,
  });
  useLayoutEditorStore.getState().endSession();
}

beforeEach(() => {
  resetStores();
});

afterEach(() => {
  cleanup();
  resetStores();
});

describe("<SampleModelPicker /> - visibility", () => {
  it("renders nothing outside an editor session, even with Model hovered", () => {
    useLayoutEditorStore.setState({ hovered: "model" });

    render(<SampleModelPicker />);

    expect(screen.queryByTestId("sample-model-picker")).toBeNull();
  });

  it("renders nothing in a session while Model is neither hovered nor selected", () => {
    beginSession();
    act(() => {
      useLayoutEditorStore.getState().setHovered("mic");
    });

    render(<SampleModelPicker />);

    expect(screen.queryByTestId("sample-model-picker")).toBeNull();
  });

  it("shows while Model is hovered or selected, and hides once hover/selection moves elsewhere", () => {
    beginSession();
    render(<SampleModelPicker />);
    expect(screen.queryByTestId("sample-model-picker")).toBeNull();

    act(() => {
      useLayoutEditorStore.getState().setHovered("model");
    });
    expect(screen.getByTestId("sample-model-picker")).not.toBeNull();

    act(() => {
      useLayoutEditorStore.getState().setHovered("mic");
    });
    expect(screen.queryByTestId("sample-model-picker")).toBeNull();

    act(() => {
      useLayoutEditorStore.getState().select("model");
    });
    expect(screen.getByTestId("sample-model-picker")).not.toBeNull();

    act(() => {
      useLayoutEditorStore.getState().select(null);
    });
    expect(screen.queryByTestId("sample-model-picker")).toBeNull();
  });
});

describe("<SampleModelPicker /> - the region part and its picture", () => {
  it("names the outer box the Model region's part, and keeps the picture inert", () => {
    beginSession();
    act(() => {
      useLayoutEditorStore.getState().select("model");
    });

    render(<SampleModelPicker />);

    const box = screen.getByTestId("sample-model-picker");
    expect(box.getAttribute("data-layout-region-part")).toBe("model");
    const surface = box.firstElementChild;
    expect(surface).not.toBeNull();
    expect(surface?.hasAttribute("inert")).toBe(true);
  });
});

describe("<SampleModelPicker /> - the real picker body, fed sample data", () => {
  beforeEach(() => {
    beginSession();
    act(() => {
      useLayoutEditorStore.getState().select("model");
    });
  });

  it("renders with no host providers or QueryClient around it", () => {
    render(<SampleModelPicker />);

    expect(screen.getByTestId("sample-model-picker")).not.toBeNull();
  });

  it("draws the search field, the account line, the model rows and the footer's Fast and effort controls", () => {
    render(<SampleModelPicker />);

    expect(screen.getByPlaceholderText("Search Sample models")).not.toBeNull();
    expect(screen.getByText("Sample account")).not.toBeNull();

    const rows = screen.getAllByRole("option");
    expect(rows.map((row) => row.textContent)).toEqual([
      "Sample model",
      "Sample model max",
      "Sample model mini",
    ]);

    expect(screen.getByRole("button", { name: "Fast mode" })).not.toBeNull();
    expect(
      screen.getByRole("group", { name: "Thinking effort" }),
    ).not.toBeNull();
  });

  it("follows the Layout > Model > Reasoning control live", () => {
    render(<SampleModelPicker />);

    expect(screen.getByTestId("model-reasoning-slider")).not.toBeNull();
    expect(screen.queryByTestId("model-reasoning-scroller")).toBeNull();

    act(() => {
      useLayoutStore
        .getState()
        .setRegionValues("model", { reasoningControl: "list" });
    });

    expect(screen.queryByTestId("model-reasoning-slider")).toBeNull();
    expect(screen.getByTestId("model-reasoning-scroller")).not.toBeNull();

    act(() => {
      useLayoutStore
        .getState()
        .setRegionValues("model", { reasoningControl: "slider" });
    });

    expect(screen.getByTestId("model-reasoning-slider")).not.toBeNull();
    expect(screen.queryByTestId("model-reasoning-scroller")).toBeNull();
  });

  it("does not move focus when it mounts", () => {
    const outsideButton = document.createElement("button");
    document.body.appendChild(outsideButton);
    outsideButton.focus();
    expect(document.activeElement).toBe(outsideButton);

    render(<SampleModelPicker />);

    expect(document.activeElement).toBe(outsideButton);
    outsideButton.remove();
  });
});

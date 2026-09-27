import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { useCallback, useRef, type ReactElement } from "react";

import { useComposerSheetPin } from "../use-composer-sheet-pin";

afterEach(cleanup);

interface RectInput {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Builds a `DOMRect`-shaped value from the live fields on `rect`. */
function toDomRect(rect: RectInput): DOMRect {
  const { left, top, width, height } = rect;
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

/**
 * jsdom lays nothing out, so every element reports a zero rect. This stubs
 * `getBoundingClientRect` on one element to read the live fields of `rect`,
 * so a test can mutate `rect` later and see the change without remounting.
 */
function stubRect(element: Element, rect: RectInput): void {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => toDomRect(rect),
  });
}

/**
 * Records every `ResizeObserver` the hook creates, so a test can fire its
 * callback directly the way a real slot resize would.
 */
class RecordingResizeObserver implements ResizeObserver {
  readonly callback: ResizeObserverCallback;
  readonly targets: Element[] = [];
  disconnected = false;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    resizeObservers.push(this);
  }

  observe(target: Element): void {
    this.targets.push(target);
  }

  unobserve(target: Element): void {
    const index = this.targets.indexOf(target);
    if (index !== -1) this.targets.splice(index, 1);
  }

  disconnect(): void {
    this.disconnected = true;
  }

  trigger(): void {
    this.callback([], this);
  }
}

const resizeObservers: RecordingResizeObserver[] = [];

function lastResizeObserver(): RecordingResizeObserver {
  const observer = resizeObservers.at(-1);
  if (observer === undefined) throw new Error("no ResizeObserver was created");
  return observer;
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", RecordingResizeObserver);
});

afterEach(() => {
  resizeObservers.length = 0;
  vi.unstubAllGlobals();
});

interface HarnessProps {
  readonly expanded: boolean;
  readonly originRect: RectInput;
  readonly slotRect: RectInput;
  readonly attachOffsetParent: boolean;
}

/**
 * Stands in for the real sheet: a positioned "origin" (the sheet's own
 * `offsetParent`), a slot mounted only while expanded (the real backdrop
 * mounts its slot the same way), and the sheet the hook pins. Geometry is
 * stubbed on each element as it mounts, in ref callbacks, so it is in place
 * before the hook's own layout effect ever reads it. Siblings commit in JSX
 * order, so the origin's ref (first) always runs before the sheet's ref
 * (last), letting the sheet's callback read back the mounted origin element.
 */
function SheetPinHarness(props: HarnessProps): ReactElement {
  const { expanded, originRect, slotRect, attachOffsetParent } = props;
  const { slotRef, sheetRef } = useComposerSheetPin(expanded);
  const originElementRef = useRef<HTMLDivElement | null>(null);

  const originCallbackRef = useCallback(
    (element: HTMLDivElement | null) => {
      originElementRef.current = element;
      if (element === null) return;
      stubRect(element, originRect);
    },
    [originRect],
  );

  const slotCallbackRef = useCallback(
    (element: HTMLDivElement | null) => {
      slotRef.current = element;
      if (element === null) return;
      stubRect(element, slotRect);
    },
    [slotRef, slotRect],
  );

  const sheetCallbackRef = useCallback(
    (element: HTMLDivElement | null) => {
      sheetRef.current = element;
      if (element === null || !attachOffsetParent) return;
      Object.defineProperty(element, "offsetParent", {
        configurable: true,
        value: originElementRef.current,
      });
    },
    [sheetRef, attachOffsetParent],
  );

  return (
    <>
      <div ref={originCallbackRef} data-testid="origin" />
      {expanded ? <div ref={slotCallbackRef} data-testid="slot" /> : null}
      <div ref={sheetCallbackRef} data-testid="sheet" />
    </>
  );
}

function sheetStyle(): CSSStyleDeclaration {
  return screen.getByTestId("sheet").style;
}

describe("useComposerSheetPin", () => {
  it("pins the sheet to the slot's box, measured from its offset parent", () => {
    const originRect: RectInput = { left: 12, top: 600, width: 0, height: 0 };
    const slotRect: RectInput = { left: 16, top: 50, width: 370, height: 700 };
    const view = render(
      <SheetPinHarness
        expanded={false}
        originRect={originRect}
        slotRect={slotRect}
        attachOffsetParent
      />,
    );

    // The slot only mounts once expanded, so the pin happens on this
    // transition, the same way opening the real sheet does.
    view.rerender(
      <SheetPinHarness
        expanded
        originRect={originRect}
        slotRect={slotRect}
        attachOffsetParent
      />,
    );

    const style = sheetStyle();
    expect(style.left).toBe("4px");
    expect(style.top).toBe("-550px");
    expect(style.width).toBe("370px");
    expect(style.height).toBe("700px");
  });

  it("re-pins when the slot resizes", () => {
    const originRect: RectInput = { left: 12, top: 600, width: 0, height: 0 };
    const slotRect: RectInput = { left: 16, top: 50, width: 370, height: 700 };
    const view = render(
      <SheetPinHarness
        expanded={false}
        originRect={originRect}
        slotRect={slotRect}
        attachOffsetParent
      />,
    );
    view.rerender(
      <SheetPinHarness
        expanded
        originRect={originRect}
        slotRect={slotRect}
        attachOffsetParent
      />,
    );
    expect(sheetStyle().left).toBe("4px");

    // The surface resizes under the slot (e.g. the keyboard opening); the
    // hook is watching the slot, not the sheet, so it must notice.
    slotRect.left = 30;
    slotRect.width = 300;
    lastResizeObserver().trigger();

    const style = sheetStyle();
    expect(style.left).toBe("18px");
    expect(style.width).toBe("300px");
  });

  it("removes the inline box and disconnects the observer on collapse", () => {
    const originRect: RectInput = { left: 12, top: 600, width: 0, height: 0 };
    const slotRect: RectInput = { left: 16, top: 50, width: 370, height: 700 };
    const view = render(
      <SheetPinHarness
        expanded={false}
        originRect={originRect}
        slotRect={slotRect}
        attachOffsetParent
      />,
    );
    view.rerender(
      <SheetPinHarness
        expanded
        originRect={originRect}
        slotRect={slotRect}
        attachOffsetParent
      />,
    );
    expect(sheetStyle().left).not.toBe("");
    const observer = lastResizeObserver();

    view.rerender(
      <SheetPinHarness
        expanded={false}
        originRect={originRect}
        slotRect={slotRect}
        attachOffsetParent
      />,
    );

    const style = sheetStyle();
    expect(style.left).toBe("");
    expect(style.top).toBe("");
    expect(style.width).toBe("");
    expect(style.height).toBe("");
    expect(observer.disconnected).toBe(true);
  });

  it("does nothing while never expanded", () => {
    const originRect: RectInput = { left: 0, top: 0, width: 0, height: 0 };
    const slotRect: RectInput = { left: 0, top: 0, width: 0, height: 0 };
    render(
      <SheetPinHarness
        expanded={false}
        originRect={originRect}
        slotRect={slotRect}
        attachOffsetParent
      />,
    );

    const style = sheetStyle();
    expect(style.left).toBe("");
    expect(style.top).toBe("");
    expect(style.width).toBe("");
    expect(style.height).toBe("");
    expect(resizeObservers).toHaveLength(0);
  });

  it("writes nothing when the sheet has no offset parent", () => {
    const originRect: RectInput = { left: 12, top: 600, width: 0, height: 0 };
    const slotRect: RectInput = { left: 16, top: 50, width: 370, height: 700 };
    // `attachOffsetParent` stays false, so the sheet keeps jsdom's default
    // `null` offsetParent, the same as an unstubbed element.
    const view = render(
      <SheetPinHarness
        expanded={false}
        originRect={originRect}
        slotRect={slotRect}
        attachOffsetParent={false}
      />,
    );
    view.rerender(
      <SheetPinHarness
        expanded
        originRect={originRect}
        slotRect={slotRect}
        attachOffsetParent={false}
      />,
    );

    const style = sheetStyle();
    expect(style.left).toBe("");
    expect(style.top).toBe("");
    expect(style.width).toBe("");
    expect(style.height).toBe("");
  });
});

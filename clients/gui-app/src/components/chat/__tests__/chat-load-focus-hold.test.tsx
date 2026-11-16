import { useEffect, useRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useChatLoadFocusHold } from "@/components/chat/chat-load-focus-hold";
import {
  PaneActivationFocusIntentContext,
  usePaneActivationFocusIntent,
} from "@/components/epic-canvas/pane-activation";

function Composer(): React.ReactElement {
  const intent = usePaneActivationFocusIntent();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!intent.shouldYieldAutoFocus()) textareaRef.current?.focus();
  }, [intent]);
  return <textarea aria-label="composer" ref={textareaRef} />;
}

interface HarnessProps {
  readonly loaded: boolean;
  readonly active: boolean;
  readonly composerKey: number;
}

function Harness(props: HarnessProps): React.ReactElement {
  const surface = useRef<HTMLDivElement>(null);
  const hookResult = useChatLoadFocusHold({
    loaded: props.loaded,
    active: props.active,
    surface,
  });
  return (
    <PaneActivationFocusIntentContext value={hookResult.intent}>
      <div ref={surface}>
        {props.loaded ? <Composer key={props.composerKey} /> : null}
      </div>
      <input aria-label="rename" />
      <button type="button">row</button>
      <div role="menu">
        <div role="menuitem" tabIndex={-1}>
          item
        </div>
      </div>
    </PaneActivationFocusIntentContext>
  );
}

function renderHarness(props: HarnessProps) {
  const view = render(<Harness {...props} />);
  return {
    update: (next: HarnessProps) => view.rerender(<Harness {...next} />),
  };
}

const LOADING: HarnessProps = { loaded: false, active: true, composerKey: 0 };
const LOADED: HarnessProps = { ...LOADING, loaded: true };

describe("useChatLoadFocusHold", () => {
  afterEach(cleanup);

  it("lets the composer take focus when nothing happened during the load", () => {
    const view = renderHarness(LOADING);
    screen.getByRole("button", { name: "row" }).focus();

    view.update(LOADED);

    expect(document.activeElement).toBe(screen.getByLabelText("composer"));
  });

  it("keeps focus in a text field the reader moved to while the active tile loaded", () => {
    const view = renderHarness(LOADING);
    fireEvent.pointerDown(document.body);
    screen.getByLabelText("rename").focus();

    view.update(LOADED);

    expect(document.activeElement).toBe(screen.getByLabelText("rename"));
  });

  it("keeps focus in an open menu the reader moved to while the active tile loaded", () => {
    const view = renderHarness(LOADING);
    fireEvent.pointerDown(document.body);
    screen.getByRole("menuitem", { name: "item" }).focus();

    view.update(LOADED);

    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "item" }),
    );
  });

  it("lets the composer take focus when focus ended on a plain control", () => {
    const view = renderHarness(LOADING);
    fireEvent.keyDown(document.body, { key: "a" });
    screen.getByRole("button", { name: "row" }).focus();

    view.update(LOADED);

    expect(document.activeElement).toBe(screen.getByLabelText("composer"));
  });

  it("does not arm the hold from a gesture made before the tile was active", () => {
    const view = renderHarness({ ...LOADING, active: false });
    fireEvent.pointerDown(document.body);
    screen.getByLabelText("rename").focus();

    view.update(LOADING);
    view.update(LOADED);

    expect(document.activeElement).toBe(screen.getByLabelText("composer"));
  });

  it("releases the hold on the first gesture after the load", () => {
    const view = renderHarness(LOADING);
    fireEvent.pointerDown(document.body);
    screen.getByLabelText("rename").focus();
    view.update(LOADED);
    expect(document.activeElement).toBe(screen.getByLabelText("rename"));

    fireEvent.pointerDown(document.body);
    screen.getByLabelText("rename").focus();
    view.update({ ...LOADED, composerKey: 1 });

    expect(document.activeElement).toBe(screen.getByLabelText("composer"));
  });
});

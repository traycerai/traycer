/// <reference types="node" />

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useRef } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computePosition } from "@floating-ui/dom";
import { FirstTaskCoachmark } from "@/components/onboarding/first-task-coachmark";
import { OnboardingCoachmark } from "@/components/onboarding/onboarding-coachmark";
import { useFirstTaskGuideStore } from "@/stores/onboarding/first-task-guide-store";

// Click-through and the stacking order are stylesheet rules, and jsdom loads
// no stylesheet - a computed style comes back empty either way. So they are
// read from the real source file, which is still an output independent of the
// component under test.
const guideCss = readFileSync(
  join(process.cwd(), "src/components/onboarding/first-task-guide.css"),
  "utf8",
);
/** The body of the rule whose selector is exactly `selector`, not a group. */
function ruleBody(selector: string): string {
  const start = guideCss.lastIndexOf(`${selector} {`);
  expect(start).toBeGreaterThan(-1);
  return guideCss.slice(start, guideCss.indexOf("}", start));
}

// jsdom has no layout, so Floating UI is stubbed rather than run: a fixed
// placement, and an `autoUpdate` that measures once, synchronously. What stays
// real is WHICH element the coachmark hands it - every anchoring assertion
// below reads the reference the component passed.
vi.mock("@floating-ui/dom", () => ({
  computePosition: vi.fn(() =>
    Promise.resolve({
      x: 24,
      y: 48,
      placement: "bottom-start",
      strategy: "fixed",
      middlewareData: {},
    }),
  ),
  autoUpdate: (
    _reference: Element,
    _floating: Element,
    update: () => void,
  ): (() => void) => {
    update();
    return () => undefined;
  },
  offset: () => ({ name: "offset", fn: () => ({}) }),
  flip: () => ({ name: "flip", fn: () => ({}) }),
  shift: () => ({ name: "shift", fn: () => ({}) }),
}));

const positioned = vi.mocked(computePosition);

/** Every element the card has been anchored to, oldest first. */
function anchors(): Element[] {
  return positioned.mock.calls
    .map(([reference]) => reference)
    .filter((reference): reference is Element => reference instanceof Element);
}

function CoachmarkHarness() {
  const rootRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={rootRef} data-testid="guide-root">
      <FirstTaskCoachmark
        step="folder"
        rootRef={rootRef}
        selector='[data-testid="folder-add"]'
      />
    </div>
  );
}

function SharedCoachmarkHarness() {
  const rootRef = useRef<HTMLDivElement>(null);
  return (
    <section
      role="dialog"
      data-slot="dialog-content"
      data-state="open"
      data-testid="settings-dialog"
    >
      <div ref={rootRef} data-testid="shared-guide-root">
        <OnboardingCoachmark
          id="settings-guide"
          title="Review settings"
          content="Choose how this workspace should work."
          progress={{ step: 2, total: 3 }}
          rootRef={rootRef}
          selector='[data-testid="dialog-target"]'
          onClose={() => useFirstTaskGuideStore.getState().dismiss()}
          onTarget={null}
          back={null}
          action={null}
        />
      </div>
    </section>
  );
}

function PopoverCoachmarkHarness() {
  const rootRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={rootRef} data-testid="popover-guide-root">
      <div data-slot="popover-content" data-state="open">
        <button type="button" data-testid="popover-target">
          Pick
        </button>
      </div>
      <OnboardingCoachmark
        id="popover-guide"
        title="Pick a location"
        content="Choose where this task runs."
        progress={null}
        rootRef={rootRef}
        selector='[data-testid="popover-target"]'
        onClose={() => undefined}
        onTarget={null}
        back={null}
        action={null}
      />
    </div>
  );
}

function KeyboardCoachmarkHarness(props: {
  readonly onNext: () => void;
  readonly onBack: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={rootRef} data-testid="keyboard-guide-root">
      <button type="button" data-testid="keyboard-target">
        Target
      </button>
      <OnboardingCoachmark
        id="keyboard-guide"
        title="Keyboard guide"
        content="Use the arrow keys."
        progress={{ step: 2, total: 3 }}
        rootRef={rootRef}
        selector='[data-testid="keyboard-target"]'
        onClose={() => undefined}
        onTarget={null}
        back={props.onBack}
        action={{ label: "Continue", onClick: props.onNext }}
      />
    </div>
  );
}

function ActionCoachmarkHarness(props: {
  readonly step: "folder" | "workspace" | "prompt";
  readonly onTarget: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const selectorByStep: Record<typeof props.step, string> = {
    folder: '[data-testid="folder-add"]',
    workspace: '[data-testid="workspace-settings"]',
    prompt: '[data-testid="prompt-editor"]',
  };
  return (
    <div ref={rootRef}>
      {props.step === "prompt" ? (
        <>
          <input data-testid="prompt-editor" />
          <button type="button" data-testid="prompt-submit" />
        </>
      ) : (
        <button
          type="button"
          data-testid={
            props.step === "folder" ? "folder-add" : "workspace-settings"
          }
          onClick={props.onTarget}
        />
      )}
      <FirstTaskCoachmark
        step={props.step}
        rootRef={rootRef}
        selector={selectorByStep[props.step]}
      />
    </div>
  );
}

function InputCoachmarkHarness(props: {
  readonly step: "prompt" | "continue";
  readonly value: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={rootRef}>
      <input
        data-testid="composer-input"
        defaultValue={props.value}
        aria-label="Composer input"
      />
      <FirstTaskCoachmark
        step={props.step}
        rootRef={rootRef}
        selector='[data-testid="composer-input"]'
      />
    </div>
  );
}

function DisabledCoachmarkHarness() {
  const rootRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={rootRef}>
      {/* `folder-add` is disabled while the host binding resolves. */}
      <button type="button" disabled data-testid="folder-add" />
      <FirstTaskCoachmark
        step="folder"
        rootRef={rootRef}
        selector='[data-testid="folder-add"]'
      />
    </div>
  );
}

function ImportedCoachmarkHarness(props: { readonly onOpen: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={rootRef}>
      <div data-first-task-imports data-testid="imported-list">
        <button
          type="button"
          data-testid="imported-task-a"
          onClick={props.onOpen}
        >
          First task
        </button>
        <button
          type="button"
          data-testid="imported-task-b"
          onClick={props.onOpen}
        >
          Second task
        </button>
      </div>
      <FirstTaskCoachmark
        step="imported"
        rootRef={rootRef}
        selector="[data-first-task-imports]"
      />
    </div>
  );
}

function ChangingCoachmarkHarness(props: {
  readonly step: "folder" | "workspace";
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const selector =
    props.step === "folder"
      ? '[data-testid="folder-add"]'
      : '[data-testid="workspace-settings"]';
  return (
    <div ref={rootRef} data-testid="changing-guide-root">
      <button type="button" data-testid="folder-add" />
      <button type="button" data-testid="workspace-settings" />
      <FirstTaskCoachmark
        step={props.step}
        rootRef={rootRef}
        selector={selector}
      />
    </div>
  );
}

function addVisibleTarget(): HTMLButtonElement {
  const target = document.createElement("button");
  target.setAttribute("data-testid", "folder-add");
  makeTargetVisible(target);
  screen.getByTestId("guide-root").append(target);
  return target;
}

function addVisibleDialogTarget(): HTMLButtonElement {
  const target = document.createElement("button");
  target.setAttribute("data-testid", "dialog-target");
  makeTargetVisible(target);
  screen.getByTestId("shared-guide-root").append(target);
  return target;
}

function makeTargetVisible(target: HTMLElement): void {
  Object.defineProperty(target, "getClientRects", {
    configurable: true,
    value: () => ({ length: 1 }),
  });
}

async function renderReadyGuide(): Promise<HTMLButtonElement> {
  render(<CoachmarkHarness />);
  const target = addVisibleTarget();
  await waitFor(() =>
    expect(screen.getByTestId("guide-coachmark")).toBeTruthy(),
  );
  return target;
}

describe("FirstTaskCoachmark", () => {
  beforeEach(() => {
    positioned.mockClear();
    useFirstTaskGuideStore.setState({
      status: "active",
      imports: new Map(),
      workspaceReviewed: false,
      acknowledgedHints: new Set(),
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("waits for a visible target, spotlights it without touching it, and stays nonmodal", async () => {
    render(<CoachmarkHarness />);
    expect(screen.queryByTestId("guide-coachmark")).toBeNull();

    const target = addVisibleTarget();
    const card = await screen.findByTestId("guide-coachmark");
    expect(anchors()).toContain(target);
    expect(card.getAttribute("aria-modal")).toBe("false");
    expect(card.getAttribute("role")).toBe("dialog");
    expect(card.getAttribute("aria-keyshortcuts")).toBe(
      "ArrowLeft ArrowRight Enter Escape",
    );
    // The spotlight is a layer of its own: the target keeps the DOM it had.
    expect(target.hasAttribute("data-first-task-highlight")).toBe(false);
    expect(target.getAttribute("style")).toBeNull();

    const halo = screen.getByTestId("guide-coachmark-halo");
    expect(halo.className).toContain("first-task-coachmark-halo");
    expect(halo.getAttribute("aria-hidden")).toBe("true");
    // The ring recipe itself lives in CSS; what the component owns is the box
    // it draws on - the target's rect, bled 4px on every side.
    await waitFor(() => expect(halo.style.width).toBe("8px"));
    expect(halo.style.height).toBe("8px");
    expect(halo.style.left).toBe("-4px");
    expect(halo.style.top).toBe("-4px");
    expect(halo.style.borderRadius).toBe("4px");
  });

  it("dims the app around the target and leaves both layers click-through", async () => {
    await renderReadyGuide();
    const dim = screen.getByTestId("guide-coachmark-dim");
    const halo = screen.getByTestId("guide-coachmark-halo");

    expect(dim.getAttribute("aria-hidden")).toBe("true");
    expect(halo.getAttribute("aria-hidden")).toBe("true");
    // The hole is a mask, so the dim can round its corners and glide.
    expect(dim.querySelector("mask")).toBeTruthy();
    expect(dim.querySelector(".first-task-coachmark-dim-cutout")).toBeTruthy();
    expect(ruleBody(".first-task-coachmark-dim")).toContain(
      "pointer-events: none;",
    );
    expect(ruleBody(".first-task-coachmark-halo")).toContain(
      "pointer-events: none;",
    );
    // Under the card, never over it.
    expect(ruleBody(".first-task-coachmark-halo")).toContain(
      "z-index: var(--coachmark-z);",
    );
    expect(ruleBody(".first-task-coachmark-dim")).toContain(
      "z-index: calc(var(--coachmark-z) - 1);",
    );
  });

  it("pauses under a modal and consumes the Escape that dismisses it", async () => {
    const target = await renderReadyGuide();

    const dialog = document.createElement("div");
    dialog.setAttribute("data-slot", "dialog-content");
    dialog.setAttribute("data-state", "open");
    document.body.append(dialog);
    await waitFor(() =>
      expect(screen.queryByTestId("guide-coachmark")).toBeNull(),
    );
    expect(target.hasAttribute("data-first-task-highlight")).toBe(false);

    dialog.remove();
    await waitFor(() =>
      expect(screen.getByTestId("guide-coachmark")).toBeTruthy(),
    );
    fireEvent.keyDown(target, { key: "Escape" });
    expect(useFirstTaskGuideStore.getState().status).toBe("finished");
  });

  it("does not dismiss on the Escape that closes a picker, but dismisses on the next Escape", async () => {
    const target = await renderReadyGuide();
    const popover = document.createElement("div");
    popover.setAttribute("data-slot", "popover-content");
    popover.setAttribute("data-state", "open");
    document.body.append(popover);
    await waitFor(() =>
      expect(screen.queryByTestId("guide-coachmark")).toBeNull(),
    );

    const closePickerOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      popover.remove();
      window.removeEventListener("keydown", closePickerOnEscape, true);
    };
    window.addEventListener("keydown", closePickerOnEscape, true);
    fireEvent.keyDown(target, { key: "Escape" });

    await waitFor(() =>
      expect(screen.getByTestId("guide-coachmark")).toBeTruthy(),
    );
    expect(useFirstTaskGuideStore.getState().status).toBe("active");

    fireEvent.keyDown(target, { key: "Escape" });
    expect(useFirstTaskGuideStore.getState().status).toBe("finished");
  });

  it("answers Escape from the commit that puts the card back on screen", async () => {
    const target = await renderReadyGuide();
    const popover = document.createElement("div");
    popover.setAttribute("data-slot", "popover-content");
    popover.setAttribute("data-state", "open");
    document.body.append(popover);
    await waitFor(() =>
      expect(screen.queryByTestId("guide-coachmark")).toBeNull(),
    );

    // The card is inserted during React's commit, and a MutationObserver
    // callback for that insertion is a microtask of the commit's own task -
    // while the effects React schedules for that same commit are a later task.
    // So this presses Escape at the first instant the card is on screen, ahead
    // of anything the commit only queued. Escape armed from an effect keyed on
    // the target is dropped here every time; Escape armed by the commit is not.
    const statusOnArrival = new Promise<string>((resolve) => {
      const observer = new MutationObserver(() => {
        if (screen.queryByTestId("guide-coachmark") === null) return;
        observer.disconnect();
        fireEvent.keyDown(target, { key: "Escape" });
        resolve(useFirstTaskGuideStore.getState().status);
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
    popover.remove();

    await expect(statusOnArrival).resolves.toBe("finished");
  });

  it("never anchors a new step to the previous step's target", async () => {
    const view = render(<ChangingCoachmarkHarness step="folder" />);
    const folderTarget = screen.getByTestId("folder-add");
    const workspaceTarget = screen.getByTestId("workspace-settings");
    makeTargetVisible(folderTarget);
    makeTargetVisible(workspaceTarget);
    fireEvent(window, new Event("resize"));

    await waitFor(() => expect(anchors()).toContain(folderTarget));
    positioned.mockClear();

    view.rerender(<ChangingCoachmarkHarness step="workspace" />);

    await waitFor(() => expect(anchors()).toContain(workspaceTarget));
    expect(anchors()).not.toContain(folderTarget);
  });

  it("portals into a settings dialog, skips the dim there, pauses for its nested picker, and consumes Escape", async () => {
    render(<SharedCoachmarkHarness />);
    const target = addVisibleDialogTarget();
    const card = await screen.findByTestId("guide-coachmark");
    const dialog = screen.getByTestId("settings-dialog");
    expect(dialog.contains(card)).toBe(true);
    expect(dialog.contains(screen.getByTestId("guide-coachmark-halo"))).toBe(
      true,
    );
    // The dialog already owns attention - dimming behind it would darken the
    // surface the step is about.
    expect(screen.queryByTestId("guide-coachmark-dim")).toBeNull();
    const progress = screen.getByTestId("guide-coachmark-progress");
    expect(progress.getAttribute("aria-valuenow")).toBe("2");
    expect(progress.getAttribute("aria-valuemax")).toBe("3");
    expect(progress.querySelectorAll('[data-filled="true"]')).toHaveLength(1);

    const popover = document.createElement("div");
    popover.setAttribute("data-slot", "popover-content");
    popover.setAttribute("data-state", "open");
    dialog.append(popover);
    await waitFor(() =>
      expect(screen.queryByTestId("guide-coachmark")).toBeNull(),
    );

    popover.remove();
    await waitFor(() =>
      expect(screen.getByTestId("guide-coachmark")).toBeTruthy(),
    );
    let dialogClosed = false;
    dialog.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (!event.defaultPrevented) dialogClosed = true;
    });

    fireEvent.keyDown(target, { key: "Escape" });

    expect(useFirstTaskGuideStore.getState().status).toBe("finished");
    expect(dialogClosed).toBe(false);
    expect(dialog.isConnected).toBe(true);
  });

  it("lifts the card and its halo over an open popover, and drops the dim", async () => {
    render(<PopoverCoachmarkHarness />);
    makeTargetVisible(screen.getByTestId("popover-target"));
    fireEvent(window, new Event("resize"));

    const card = await screen.findByTestId("guide-coachmark");
    const floater = card.closest<HTMLElement>(".first-task-coachmark-floater");
    expect(floater?.dataset.overPopover).toBe("true");
    expect(screen.getByTestId("guide-coachmark-halo").dataset.overPopover).toBe(
      "true",
    );
    // The attribute is only worth anything because the stylesheet raises the
    // shared layer above a popover's own when it is set.
    expect(guideCss).toContain(
      '.first-task-coachmark-halo[data-over-popover="true"]',
    );
    expect(guideCss).toMatch(
      /\[data-over-popover="true"\][\s\S]*?--coachmark-z: 60;/,
    );
    expect(screen.queryByTestId("guide-coachmark-dim")).toBeNull();
  });

  it("supports arrow and card Enter navigation while button Enter stays native", async () => {
    const onNext = vi.fn();
    const onBack = vi.fn();
    render(<KeyboardCoachmarkHarness onNext={onNext} onBack={onBack} />);
    makeTargetVisible(screen.getByTestId("keyboard-target"));
    fireEvent(window, new Event("resize"));
    const card = await screen.findByTestId("guide-coachmark");

    fireEvent.keyDown(card, { key: "ArrowRight" });
    fireEvent.keyDown(card, { key: "ArrowLeft" });
    fireEvent.keyDown(card, { key: "Enter" });
    expect(onNext).toHaveBeenCalledTimes(2);
    expect(onBack).toHaveBeenCalledOnce();

    const continueButton = screen.getByRole("button", { name: /Continue/ });
    fireEvent.keyDown(continueButton, { key: "Enter" });
    expect(onNext).toHaveBeenCalledTimes(2);
    fireEvent.click(continueButton);
    expect(onNext).toHaveBeenCalledTimes(3);
  });

  it("leaves application input Enter and caret movement untouched", async () => {
    const onNext = vi.fn();
    const onBack = vi.fn();
    render(
      <>
        <input aria-label="Application input" />
        <KeyboardCoachmarkHarness onNext={onNext} onBack={onBack} />
      </>,
    );
    const applicationInput = screen.getByRole("textbox", {
      name: "Application input",
    });
    applicationInput.focus();
    makeTargetVisible(screen.getByTestId("keyboard-target"));
    fireEvent(window, new Event("resize"));
    await screen.findByTestId("guide-coachmark");
    expect(document.activeElement).toBe(applicationInput);

    fireEvent.keyDown(applicationInput, { key: "Enter" });
    fireEvent.keyDown(applicationInput, { key: "ArrowLeft" });
    expect(onNext).not.toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();
  });

  it("Add folder clicks the folder target", async () => {
    const onTarget = vi.fn();
    render(<ActionCoachmarkHarness step="folder" onTarget={onTarget} />);
    makeTargetVisible(screen.getByTestId("folder-add"));
    fireEvent(window, new Event("resize"));
    await screen.findByTestId("guide-coachmark");
    fireEvent.click(screen.getByRole("button", { name: /Add folder/ }));
    expect(onTarget).toHaveBeenCalledOnce();
    expect(useFirstTaskGuideStore.getState().acknowledgedHints).toContain(
      "folder",
    );
  });

  it("Choose location clicks the workspace target without reviewing it", async () => {
    const onTarget = vi.fn();
    render(<ActionCoachmarkHarness step="workspace" onTarget={onTarget} />);
    makeTargetVisible(screen.getByTestId("workspace-settings"));
    fireEvent(window, new Event("resize"));
    await screen.findByTestId("guide-coachmark");
    fireEvent.click(screen.getByRole("button", { name: /Choose location/ }));
    expect(onTarget).toHaveBeenCalledOnce();
    expect(useFirstTaskGuideStore.getState().workspaceReviewed).toBe(false);
    expect(useFirstTaskGuideStore.getState().acknowledgedHints).toContain(
      "workspace",
    );
  });

  it("Write a task focuses the editor without submitting", async () => {
    const onTarget = vi.fn();
    render(<ActionCoachmarkHarness step="prompt" onTarget={onTarget} />);
    makeTargetVisible(screen.getByTestId("prompt-editor"));
    fireEvent(window, new Event("resize"));
    await screen.findByTestId("guide-coachmark");
    fireEvent.click(screen.getByRole("button", { name: /Write a task/ }));
    expect(document.activeElement).toBe(screen.getByTestId("prompt-editor"));
    expect(document.activeElement).not.toBe(
      screen.getByTestId("prompt-submit"),
    );
    expect(onTarget).not.toHaveBeenCalled();
  });

  it("acknowledges a folder target click and never remounts after clear or remount", async () => {
    const target = await renderReadyGuide();
    fireEvent.click(target);

    await waitFor(() =>
      expect(useFirstTaskGuideStore.getState().acknowledgedHints).toContain(
        "folder",
      ),
    );
    expect(screen.queryByTestId("guide-coachmark")).toBeNull();
    expect(screen.queryByTestId("guide-coachmark-dim")).toBeNull();

    cleanup();
    render(<CoachmarkHarness />);
    addVisibleTarget();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId("guide-coachmark")).toBeNull();
  });

  it.each([
    ["prompt", "prefilled task"],
    ["continue", "follow-up message"],
  ] as const)(
    "acknowledges a nonempty %s composer input on mount",
    async (step, value) => {
      render(<InputCoachmarkHarness step={step} value={value} />);
      const input = screen.getByRole("textbox", { name: "Composer input" });
      makeTargetVisible(input);
      fireEvent(window, new Event("resize"));

      await waitFor(() =>
        expect(useFirstTaskGuideStore.getState().acknowledgedHints).toContain(
          step,
        ),
      );
      expect(screen.queryByTestId("guide-coachmark")).toBeNull();
    },
  );

  it("acknowledges nonempty typing, then stays hidden after clearing and remounting", async () => {
    render(<InputCoachmarkHarness step="prompt" value="" />);
    const input = screen.getByRole("textbox", { name: "Composer input" });
    makeTargetVisible(input);
    fireEvent(window, new Event("resize"));
    await screen.findByTestId("guide-coachmark");

    fireEvent.input(input, { target: { value: "typed task" } });
    await waitFor(() =>
      expect(useFirstTaskGuideStore.getState().acknowledgedHints).toContain(
        "prompt",
      ),
    );
    expect(screen.queryByTestId("guide-coachmark")).toBeNull();

    fireEvent.input(input, { target: { value: "" } });
    cleanup();
    render(<InputCoachmarkHarness step="prompt" value="" />);
    expect(screen.queryByTestId("guide-coachmark")).toBeNull();
  });

  it("leaves the Escape that closes the composer's picker to the picker", async () => {
    const target = await renderReadyGuide();
    // The mention / slash menu portals to the body and carries no
    // `data-state`: it is mounted only while it is open.
    const menu = document.createElement("div");
    menu.setAttribute("data-slot", "composer-menu");
    menu.setAttribute("role", "presentation");
    const list = document.createElement("div");
    list.setAttribute("role", "listbox");
    menu.append(list);
    document.body.append(menu);

    fireEvent.keyDown(target, { key: "Escape" });
    expect(useFirstTaskGuideStore.getState().status).toBe("active");
    expect(screen.getByTestId("guide-coachmark")).toBeTruthy();

    menu.remove();
    fireEvent.keyDown(target, { key: "Escape" });
    expect(useFirstTaskGuideStore.getState().status).toBe("finished");
  });

  // Escape means "close this guide" wherever it was pressed: someone reaching
  // for it wants out of the guidance, not out of whatever holds focus. Only a
  // dismissable surface that is genuinely elsewhere - the picker cases above -
  // answers it first.
  it("closes the guide on an Escape aimed at neither the card nor the target", async () => {
    render(
      <>
        <input aria-label="Application input" />
        <CoachmarkHarness />
      </>,
    );
    addVisibleTarget();
    await screen.findByTestId("guide-coachmark");

    const applicationInput = screen.getByRole("textbox", {
      name: "Application input",
    });
    fireEvent.keyDown(applicationInput, { key: "Escape" });
    expect(useFirstTaskGuideStore.getState().status).toBe("finished");
  });

  it("does not acknowledge Add folder when the target is still disabled", async () => {
    render(<DisabledCoachmarkHarness />);
    makeTargetVisible(screen.getByTestId("folder-add"));
    fireEvent(window, new Event("resize"));
    await screen.findByTestId("guide-coachmark");

    fireEvent.click(screen.getByRole("button", { name: /Add folder/ }));

    // Nothing happened, so the guidance has to stay: acknowledging a press
    // that did nothing removes the card for the rest of the session.
    expect(useFirstTaskGuideStore.getState().acknowledgedHints).not.toContain(
      "folder",
    );
    expect(screen.getByTestId("guide-coachmark")).toBeTruthy();
  });

  it("Pick a task focuses the first imported task without opening it", async () => {
    const onOpen = vi.fn();
    render(<ImportedCoachmarkHarness onOpen={onOpen} />);
    makeTargetVisible(screen.getByTestId("imported-list"));
    fireEvent(window, new Event("resize"));
    await screen.findByTestId("guide-coachmark");

    fireEvent.click(screen.getByRole("button", { name: /Pick a task/ }));

    // Which task to pick up is the user's call - the step only puts them in
    // front of the list.
    expect(document.activeElement).toBe(screen.getByTestId("imported-task-a"));
    expect(onOpen).not.toHaveBeenCalled();
    expect(useFirstTaskGuideStore.getState().acknowledgedHints).not.toContain(
      "imported",
    );
    expect(screen.getByTestId("guide-coachmark")).toBeTruthy();

    // Opening one is what settles the step.
    fireEvent.click(screen.getByTestId("imported-task-b"));
    await waitFor(() =>
      expect(useFirstTaskGuideStore.getState().acknowledgedHints).toContain(
        "imported",
      ),
    );
  });

  it("acknowledges a late mounted target through the root click listener", async () => {
    render(<CoachmarkHarness />);
    const target = addVisibleTarget();
    await screen.findByTestId("guide-coachmark");

    fireEvent.click(target);
    await waitFor(() =>
      expect(useFirstTaskGuideStore.getState().acknowledgedHints).toContain(
        "folder",
      ),
    );
    expect(screen.queryByTestId("guide-coachmark")).toBeNull();
  });
});

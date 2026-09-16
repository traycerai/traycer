import { useRef, type ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FirstTaskCoachmark } from "@/components/onboarding/first-task-coachmark";
import { OnboardingCoachmark } from "@/components/onboarding/onboarding-coachmark";
import { useFirstTaskGuideStore } from "@/stores/onboarding/first-task-guide-store";

type MockJoyrideProps = {
  readonly run: boolean;
  readonly steps: ReadonlyArray<{
    readonly id: string;
    readonly target: () => HTMLElement | null;
  }>;
  readonly options: {
    readonly hideOverlay: boolean;
    readonly disableFocusTrap: boolean;
    readonly blockTargetInteraction: boolean;
  };
  readonly portalElement: HTMLElement | undefined;
  readonly tooltipComponent: (props: {
    readonly step: {
      readonly title: string;
      readonly content: string;
    };
    readonly tooltipProps: {
      readonly role: string;
      readonly "aria-modal": boolean;
      readonly "data-testid": string;
    };
  }) => ReactNode;
};

const joyrideTargets = vi.hoisted(
  (): { records: Array<{ id: string; targetId: string | null }> } => ({
    records: [],
  }),
);

vi.mock("react-joyride", () => ({
  ACTIONS: { CLOSE: "close", SKIP: "skip" },
  Joyride: (props: MockJoyrideProps) => {
    const step = props.steps[0];
    const stepId = step.id;
    const targetId = step.target()?.getAttribute("data-testid") ?? null;
    const Tooltip = props.tooltipComponent;
    joyrideTargets.records.push({ id: stepId, targetId });
    return (
      <div
        data-testid="joyride"
        data-run={String(props.run)}
        data-step-id={stepId}
        data-target-id={targetId ?? "none"}
        data-hide-overlay={String(props.options.hideOverlay)}
        data-focus-trap={String(props.options.disableFocusTrap)}
        data-block-target={String(props.options.blockTargetInteraction)}
        data-portal-element={
          props.portalElement?.getAttribute("data-testid") ?? "none"
        }
      >
        <Tooltip
          step={{ title: "Guide title", content: "Guide content" }}
          tooltipProps={{
            role: "dialog",
            "aria-modal": false,
            "data-testid": "joyride-tooltip",
          }}
        />
      </div>
    );
  },
}));

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
          progress="2 of 3"
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
        progress="2 of 3"
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
  Object.defineProperty(target, "getClientRects", {
    configurable: true,
    value: () => ({ length: 1 }),
  });
  screen.getByTestId("guide-root").append(target);
  return target;
}

function addVisibleDialogTarget(): HTMLButtonElement {
  const target = document.createElement("button");
  target.setAttribute("data-testid", "dialog-target");
  Object.defineProperty(target, "getClientRects", {
    configurable: true,
    value: () => ({ length: 1 }),
  });
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
  await waitFor(() => expect(screen.getByTestId("joyride")).toBeTruthy());
  return target;
}

describe("FirstTaskCoachmark", () => {
  beforeEach(() => {
    joyrideTargets.records.length = 0;
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

  it("waits for a visible target, pauses under a modal, and uses nonmodal Joyride options", async () => {
    render(<CoachmarkHarness />);
    expect(screen.queryByTestId("joyride")).toBeNull();

    const target = addVisibleTarget();
    await waitFor(() => expect(screen.getByTestId("joyride")).toBeTruthy());
    await waitFor(() =>
      expect(joyrideTargets.records).toContainEqual({
        id: "folder",
        targetId: "folder-add",
      }),
    );
    expect(target.hasAttribute("data-first-task-highlight")).toBe(false);
    expect(screen.getByTestId("joyride").getAttribute("data-run")).toBe("true");
    expect(
      screen.getByTestId("joyride").getAttribute("data-hide-overlay"),
    ).toBe("true");
    expect(screen.getByTestId("joyride").getAttribute("data-focus-trap")).toBe(
      "true",
    );
    expect(
      screen.getByTestId("joyride").getAttribute("data-block-target"),
    ).toBe("false");
    expect(
      screen.getByTestId("joyride-tooltip").getAttribute("aria-modal"),
    ).toBe("false");

    const dialog = document.createElement("div");
    dialog.setAttribute("data-slot", "dialog-content");
    dialog.setAttribute("data-state", "open");
    document.body.append(dialog);
    await waitFor(() => expect(screen.queryByTestId("joyride")).toBeNull());
    expect(target.hasAttribute("data-first-task-highlight")).toBe(false);

    dialog.remove();
    await waitFor(() => expect(screen.getByTestId("joyride")).toBeTruthy());
    fireEvent.keyDown(target, { key: "Escape" });
    expect(useFirstTaskGuideStore.getState().status).toBe("finished");
  });

  it("does not dismiss on the Escape that closes a picker, but dismisses on the next Escape", async () => {
    const target = await renderReadyGuide();
    const popover = document.createElement("div");
    popover.setAttribute("data-slot", "popover-content");
    popover.setAttribute("data-state", "open");
    document.body.append(popover);
    await waitFor(() => expect(screen.queryByTestId("joyride")).toBeNull());

    const closePickerOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      popover.remove();
      window.removeEventListener("keydown", closePickerOnEscape, true);
    };
    window.addEventListener("keydown", closePickerOnEscape, true);
    fireEvent.keyDown(target, { key: "Escape" });

    await waitFor(() => expect(screen.getByTestId("joyride")).toBeTruthy());
    expect(useFirstTaskGuideStore.getState().status).toBe("active");

    fireEvent.keyDown(target, { key: "Escape" });
    expect(useFirstTaskGuideStore.getState().status).toBe("finished");
  });

  it("does not mount a new step against the previous step's target", async () => {
    const view = render(<ChangingCoachmarkHarness step="folder" />);
    const folderTarget = screen.getByTestId("folder-add");
    const workspaceTarget = screen.getByTestId("workspace-settings");
    makeTargetVisible(folderTarget);
    makeTargetVisible(workspaceTarget);
    fireEvent(window, new Event("resize"));

    await waitFor(() =>
      expect(joyrideTargets.records).toContainEqual({
        id: "folder",
        targetId: "folder-add",
      }),
    );
    joyrideTargets.records.length = 0;

    view.rerender(<ChangingCoachmarkHarness step="workspace" />);

    await waitFor(() =>
      expect(joyrideTargets.records).toContainEqual({
        id: "workspace",
        targetId: "workspace-settings",
      }),
    );
    expect(joyrideTargets.records).not.toContainEqual({
      id: "workspace",
      targetId: "folder-add",
    });
  });

  it("allows a target in a settings dialog, pauses for its nested picker, and consumes Escape", async () => {
    render(<SharedCoachmarkHarness />);
    const target = addVisibleDialogTarget();
    await waitFor(() => expect(screen.getByTestId("joyride")).toBeTruthy());
    expect(
      screen.getByTestId("joyride").getAttribute("data-portal-element"),
    ).toBe("settings-dialog");

    const popover = document.createElement("div");
    popover.setAttribute("data-slot", "popover-content");
    popover.setAttribute("data-state", "open");
    screen.getByTestId("settings-dialog").append(popover);
    await waitFor(() => expect(screen.queryByTestId("joyride")).toBeNull());

    popover.remove();
    await waitFor(() => expect(screen.getByTestId("joyride")).toBeTruthy());
    let dialogClosed = false;
    screen
      .getByTestId("settings-dialog")
      .addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        if (!event.defaultPrevented) dialogClosed = true;
      });

    fireEvent.keyDown(target, { key: "Escape" });

    expect(useFirstTaskGuideStore.getState().status).toBe("finished");
    expect(dialogClosed).toBe(false);
    expect(screen.getByTestId("settings-dialog").isConnected).toBe(true);
  });

  it("supports arrow and card Enter navigation while button Enter stays native", async () => {
    const onNext = vi.fn();
    const onBack = vi.fn();
    render(<KeyboardCoachmarkHarness onNext={onNext} onBack={onBack} />);
    makeTargetVisible(screen.getByTestId("keyboard-target"));
    fireEvent(window, new Event("resize"));
    await waitFor(() =>
      expect(screen.getByTestId("joyride-tooltip")).toBeTruthy(),
    );

    const tooltip = screen.getByTestId("joyride-tooltip");
    fireEvent.keyDown(tooltip, { key: "ArrowRight" });
    fireEvent.keyDown(tooltip, { key: "ArrowLeft" });
    fireEvent.keyDown(tooltip, { key: "Enter" });
    expect(onNext).toHaveBeenCalledTimes(2);
    expect(onBack).toHaveBeenCalledOnce();

    const continueButton = screen.getByRole("button", { name: "Continue" });
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
    await waitFor(() =>
      expect(screen.getByTestId("joyride-tooltip")).toBeTruthy(),
    );
    expect(document.activeElement).toBe(applicationInput);

    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "ArrowLeft" });
    expect(onNext).not.toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();
  });

  it("Add folder clicks the folder target", async () => {
    const onTarget = vi.fn();
    render(<ActionCoachmarkHarness step="folder" onTarget={onTarget} />);
    makeTargetVisible(screen.getByTestId("folder-add"));
    fireEvent(window, new Event("resize"));
    await waitFor(() =>
      expect(screen.getByTestId("joyride-tooltip")).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add folder" }));
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
    await waitFor(() =>
      expect(screen.getByTestId("joyride-tooltip")).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose location" }));
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
    await waitFor(() =>
      expect(screen.getByTestId("joyride-tooltip")).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Write a task" }));
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
    expect(screen.queryByTestId("joyride")).toBeNull();

    cleanup();
    render(<CoachmarkHarness />);
    addVisibleTarget();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId("joyride")).toBeNull();
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
      expect(screen.queryByTestId("joyride")).toBeNull();
    },
  );

  it("acknowledges nonempty typing, then stays hidden after clearing and remounting", async () => {
    render(<InputCoachmarkHarness step="prompt" value="" />);
    const input = screen.getByRole("textbox", { name: "Composer input" });
    makeTargetVisible(input);
    fireEvent(window, new Event("resize"));
    await waitFor(() => expect(screen.getByTestId("joyride")).toBeTruthy());

    fireEvent.input(input, { target: { value: "typed task" } });
    await waitFor(() =>
      expect(useFirstTaskGuideStore.getState().acknowledgedHints).toContain(
        "prompt",
      ),
    );
    expect(screen.queryByTestId("joyride")).toBeNull();

    fireEvent.input(input, { target: { value: "" } });
    cleanup();
    render(<InputCoachmarkHarness step="prompt" value="" />);
    expect(screen.queryByTestId("joyride")).toBeNull();
  });

  it("acknowledges a late mounted target through the root click listener", async () => {
    render(<CoachmarkHarness />);
    const target = addVisibleTarget();
    await waitFor(() => expect(screen.getByTestId("joyride")).toBeTruthy());

    fireEvent.click(target);
    await waitFor(() =>
      expect(useFirstTaskGuideStore.getState().acknowledgedHints).toContain(
        "folder",
      ),
    );
    expect(screen.queryByTestId("joyride")).toBeNull();
  });
});

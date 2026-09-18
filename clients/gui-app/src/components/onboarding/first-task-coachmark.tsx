import { useEffect, type RefObject } from "react";
import { OnboardingCoachmark } from "./onboarding-coachmark";
import { interactWithGuideTarget, focusGuideTarget } from "./guide-target";
import {
  useFirstTaskGuideStore,
  type FirstTaskHint,
} from "@/stores/onboarding/first-task-guide-store";

export type FirstTaskStep = FirstTaskHint;

const STEPS = {
  folder: {
    progress: { step: 1, total: 3 },
    title: "Pick a project",
    content: "Add the folder Traycer should work in.",
    action: "Add folder",
  },
  workspace: {
    progress: { step: 2, total: 3 },
    title: "Choose where it runs",
    content: "Local, a new worktree, or an existing one.",
    action: "Choose location",
  },
  prompt: {
    progress: { step: 3, total: 3 },
    title: "Give it a task",
    content: "Describe what to build or debug, then press Enter.",
    action: "Write a task",
  },
  imported: {
    progress: { step: 1, total: 2 },
    title: "Your tasks are here",
    content: "Open one to pick up where you left off.",
    action: "Pick a task",
  },
  continue: {
    progress: { step: 2, total: 2 },
    title: "Keep going",
    content: "Send a message to continue this conversation.",
    action: "Write a message",
  },
  "tasks-menu": {
    progress: { step: 1, total: 2 },
    title: "Your tasks live here",
    content: "Open the menu to see everything you started.",
    action: "Open menu",
  },
  "tasks-pick": {
    progress: { step: 2, total: 2 },
    title: "Pick up where you left off",
    content: "Tap any task to continue it.",
    action: "Show me",
  },
} as const;

/**
 * The steps the drawer's open state decides, rather than a click on the
 * target. They never acknowledge: closing the drawer without picking a task
 * has to put the user back on step 1, and an acknowledged hint is gone for
 * good. What ends this branch is opening a task, which finishes the guide
 * outright (`mobile-nav-drawer.tsx`).
 */
function derivedFromDrawer(step: FirstTaskStep): boolean {
  return step === "tasks-menu" || step === "tasks-pick";
}

export function FirstTaskCoachmark(props: {
  readonly step: FirstTaskStep;
  readonly rootRef: RefObject<HTMLElement | null>;
  readonly selector: string;
}) {
  const dismiss = useFirstTaskGuideStore((state) => state.dismiss);
  const acknowledged = useFirstTaskGuideStore((state) =>
    state.acknowledgedHints.has(props.step),
  );
  const acknowledge = useFirstTaskGuideStore((state) => state.acknowledgeHint);
  const writing = props.step === "prompt" || props.step === "continue";
  const derived = derivedFromDrawer(props.step);
  useEffect(() => {
    const root = props.rootRef.current;
    if (root === null || acknowledged || derived) return;
    const editorSelector = 'textarea, input, [contenteditable="true"]';
    const onClick = (event: MouseEvent): void => {
      if (!(event.target instanceof Element)) return;
      const target = event.target.closest(props.selector);
      if (target === null || !root.contains(target)) return;
      if (!writing || event.target.closest(editorSelector))
        acknowledge(props.step);
    };
    const onInput = (): void => {
      const target = root.querySelector<HTMLElement>(props.selector);
      const editor = target?.matches(editorSelector)
        ? target
        : target?.querySelector<HTMLElement>(editorSelector);
      const text =
        editor instanceof HTMLTextAreaElement ||
        editor instanceof HTMLInputElement
          ? editor.value
          : editor?.textContent;
      if (text?.trim()) acknowledge(props.step);
    };
    root.addEventListener("click", onClick);
    const observer = new MutationObserver(onInput);
    if (writing) {
      root.addEventListener("input", onInput);
      observer.observe(root, { childList: true, subtree: true });
      onInput();
    }
    return () => {
      root.removeEventListener("click", onClick);
      root.removeEventListener("input", onInput);
      observer.disconnect();
    };
  }, [
    props.rootRef,
    props.selector,
    props.step,
    writing,
    derived,
    acknowledged,
    acknowledge,
  ]);
  const step = STEPS[props.step];
  // `imported` joins the writing steps in only putting the user in front of
  // the control: clicking the first task card would open a task they never
  // chose. And it is the one step whose action does not settle it - opening a
  // task is what acknowledges it, through the click listener above.
  // `tasks-pick` joins them: there is nothing to press for the user - which
  // task they resume is theirs to choose - so "Show me" puts the first row
  // under their finger and stops there.
  const interact =
    writing || props.step === "imported" || props.step === "tasks-pick"
      ? focusGuideTarget
      : interactWithGuideTarget;
  if (acknowledged) return null;
  return (
    <OnboardingCoachmark
      id={props.step}
      title={step.title}
      content={step.content}
      progress={step.progress}
      rootRef={props.rootRef}
      selector={props.selector}
      onClose={dismiss}
      onTarget={props.step === "prompt" ? focusGuideTarget : null}
      back={null}
      action={{
        label: step.action,
        onClick: () => {
          const target = props.rootRef.current?.querySelector<HTMLElement>(
            props.selector,
          );
          // A press that found no enabled control did nothing, and retiring
          // the step's guidance for it removes the card for good.
          if (!target || !interact(target)) return;
          if (props.step !== "imported" && !derived) acknowledge(props.step);
        },
      }}
    />
  );
}

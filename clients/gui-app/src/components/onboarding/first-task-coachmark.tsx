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
    title: "Choose a project",
    content: "Add the folder you want Traycer to work in.",
    action: "Add folder",
  },
  workspace: {
    title: "Set up your workspace",
    content: "Choose where to run this task.",
    action: "Choose location",
  },
  prompt: {
    title: "Give your agent a task",
    content: "Describe what to build or change, then send.",
    action: "Write a task",
  },
  imported: {
    title: "Your work is here",
    content: "Open an imported task to continue.",
    action: "Open first task",
  },
  continue: {
    title: "Continue your task",
    content: "Send a message to continue the conversation.",
    action: "Write a message",
  },
} as const;

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
  useEffect(() => {
    const root = props.rootRef.current;
    if (root === null || acknowledged) return;
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
    acknowledged,
    acknowledge,
  ]);
  const step = STEPS[props.step];
  const interact =
    props.step === "prompt" || props.step === "continue"
      ? focusGuideTarget
      : interactWithGuideTarget;
  if (acknowledged) return null;
  return (
    <OnboardingCoachmark
      id={props.step}
      title={step.title}
      content={step.content}
      progress={null}
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
          if (target) {
            interact(target);
            acknowledge(props.step);
          }
        },
      }}
    />
  );
}

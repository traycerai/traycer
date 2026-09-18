import { useEffect, type RefObject } from "react";
import type { WorkspaceRunItem } from "@/components/home/host-workspace-selector/workspace-run-item";
import { useFirstTaskGuideStore } from "@/stores/onboarding/first-task-guide-store";
import { OnboardingCoachmark } from "./onboarding-coachmark";

export function FirstTaskWorkspaceSetup(props: {
  readonly items: readonly WorkspaceRunItem[];
  readonly rootRef: RefObject<HTMLElement | null>;
  readonly onContinue: () => void;
  readonly onClose: () => void;
}) {
  const { rootRef } = props;
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const observe = (): void => {
      if (
        root.querySelector(
          '[data-testid="folder-location-trigger"][aria-expanded="true"]',
        )
      ) {
        useFirstTaskGuideStore.getState().reviewWorkspace();
      }
    };
    observe();
    const observer = new MutationObserver(observe);
    observer.observe(root, {
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-expanded"],
    });
    return () => observer.disconnect();
  }, [rootRef]);
  const ready =
    props.items.length > 0 &&
    props.items.every(
      (item) =>
        !item.unresolved &&
        !item.missing &&
        !item.metadataPending &&
        !item.modeDisabled,
    );
  const hasGitFolder = props.items.some((item) => item.isGitRepo);
  return (
    <>
      {ready ? (
        <OnboardingCoachmark
          id="workspace-location"
          rootRef={rootRef}
          selector={
            hasGitFolder
              ? '[data-testid="folder-location-trigger"]'
              : '[data-testid="folder-chip"]'
          }
          title={
            hasGitFolder
              ? "Work here or in a fresh worktree"
              : "This folder is ready"
          }
          content={
            hasGitFolder
              ? "A worktree keeps your main branch clean."
              : "Your task will run right here."
          }
          progress={{ step: 2, total: 3 }}
          cardAnchor={null}
          onTarget={null}
          back={null}
          onClose={() => {
            useFirstTaskGuideStore.getState().dismiss();
            props.onClose();
          }}
          action={{ label: "Use this setup", onClick: props.onContinue }}
        />
      ) : null}
    </>
  );
}

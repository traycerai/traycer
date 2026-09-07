import { useEffect } from "react";
import { useRouter } from "@tanstack/react-router";
import { modalLayerCoversApp } from "@/components/layout/shell/shell-gestures";
import {
  goBack,
  resolveEligibleHistoryTarget,
  type HistoryNavRouter,
} from "@/lib/commands/actions";
import { getHistoryController } from "@/lib/persistent-history";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";
import { useMobileNavStore } from "@/stores/layout/mobile-nav-store";

/** A missing runner host (route-level tests that mount the shell bare) reads the same way - no shell, no
 * request to answer - rather than as an error. */
export function useSystemBack(): void {
  const router = useRouter();
  const runnerHost = useRunnerHostOrNull();
  useEffect(() => {
    const systemBack = runnerHost?.systemBack ?? null;
    if (systemBack === null) return;
    const subscription = systemBack.onBack(() => {
      const nav = useMobileNavStore.getState();
      if (nav.open) {
        nav.setOpen(false);
        return;
      }
      if (modalLayerCoversApp()) {
        dismissCoveringLayer();
        return;
      }
      if (canStepBack(router)) {
        goBack(router);
        return;
      }
      void systemBack.minimize();
    });
    return () => {
      subscription.dispose();
    };
  }, [router, runnerHost]);
}

/** The branded history answers from its entry list, skipping entries a step would refuse; a plain history only
 * knows whether it is on its first entry - the same split `goBack` itself has. */
function canStepBack(router: HistoryNavRouter): boolean {
  if (getHistoryController(router.history) === null) {
    return router.history.canGoBack();
  }
  return resolveEligibleHistoryTarget(router, -1) !== null;
}

/** Dispatched at the focused element so it travels the path a real key press would; the dismissable-layer
 * primitive listens at the document in the capture phase and sees it either way. */
function dismissCoveringLayer(): void {
  const active = document.activeElement;
  const target = active instanceof HTMLElement ? active : document.body;
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }),
  );
}

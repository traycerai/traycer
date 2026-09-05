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

/**
 * Binds the shell's OS back request (`IRunnerHost.systemBack`) to what "back"
 * means in this app, in the order the platform's users expect and one answer
 * per press:
 *
 * 1. An open navigation drawer closes.
 * 2. A modal layer covering the app is asked to dismiss - through the same
 *    Escape its own primitive already answers, so nothing has to be enumerated
 *    and a surface that refuses Escape (a required dialog) keeps refusing.
 * 3. Otherwise the app's history steps back through the SAME `goBack` the
 *    edge swipe and the desktop arrows call. One implementation of "go back".
 * 4. With nothing behind, the shell is asked to step out of the way.
 *
 * Gated on the capability alone: shells with no OS back request pass `null`
 * and this attaches nothing. No platform is named here. A missing runner host
 * (route-level tests that mount the shell bare) reads the same way - no shell,
 * no request to answer - rather than as an error.
 */
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

/**
 * Whether a back step would land somewhere. The branded history answers from
 * its entry list, skipping entries a step would refuse; a plain history only
 * knows whether it is on its first entry - the same split `goBack` itself has.
 */
function canStepBack(router: HistoryNavRouter): boolean {
  if (getHistoryController(router.history) === null) {
    return router.history.canGoBack();
  }
  return resolveEligibleHistoryTarget(router, -1) !== null;
}

/**
 * Dispatched at the focused element so it travels the path a real key press
 * would; the dismissable-layer primitive listens at the document in the
 * capture phase and sees it either way.
 */
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

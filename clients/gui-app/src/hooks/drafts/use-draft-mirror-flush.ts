import { useEffect } from "react";
import { flushDraftMirrorSessions } from "@/lib/drafts/draft-mirror-coordinator";

/**
 * `LandingDraftMirrorMount` and every `TabDraftMirrorSession` call this hook,
 * so one blur/pagehide fires several identical listeners. Collapse them onto
 * a single in-flight pass: without it each listener starts its own
 * `upsertDirty` sweep and the same dirty draft goes out several times.
 * Module-level because the hook INSTANCES are what is being deduplicated.
 *
 * A second event arriving mid-pass is dropped rather than queued. Flush is an
 * expedite, not the only path: an edit made during the pass is still dirty
 * and the session's own debounce timer carries it.
 */
let flushInFlight: Promise<void> | null = null;

function flushOnce(): void {
  if (flushInFlight !== null) return;
  const pass = flushDraftMirrorSessions(null).finally(() => {
    if (flushInFlight === pass) flushInFlight = null;
  });
  flushInFlight = pass;
}

export function useDraftMirrorFlush(): void {
  useEffect(() => {
    const onHide = (): void => {
      if (document.visibilityState !== "hidden") return;
      flushOnce();
    };
    const onBlur = (): void => {
      flushOnce();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("blur", onBlur);
    window.addEventListener("pagehide", onBlur);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("pagehide", onBlur);
    };
  }, []);
}

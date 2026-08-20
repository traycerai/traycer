import { useEffect } from "react";
import { flushDraftMirrorSessions } from "@/lib/drafts/draft-mirror-coordinator";

export function useDraftMirrorFlush(): void {
  useEffect(() => {
    const onHide = (): void => {
      if (document.visibilityState !== "hidden") return;
      void flushDraftMirrorSessions(null);
    };
    const onBlur = (): void => {
      void flushDraftMirrorSessions(null);
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

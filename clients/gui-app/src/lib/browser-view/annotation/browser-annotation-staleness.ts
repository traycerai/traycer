import type { BrowserSessionInfo } from "@traycer/protocol/host/browser/contracts";

import type { BrowserAnnotationRecord } from "@/lib/browser-view/annotation/browser-annotation-record";

type AnnotationStalenessHint = "navigated" | "closed" | null;

export const ANNOTATION_STALENESS_COPY = {
  navigated: "page has navigated",
  closed: "source tab closed",
} as const;

/**
 * Cosmetic composer hint. "closed" is reserved for a tab the live session
 * list positively still names and whose status says it is gone. A missing
 * session, an unregistered tabId on a real session, or no sessions feed
 * makes no claim - those are UNKNOWN, not closed.
 */
export function annotationStalenessHint(
  record: BrowserAnnotationRecord,
  sessions: ReadonlyArray<BrowserSessionInfo> | null,
): AnnotationStalenessHint {
  const source = record.source;
  if (sessions === null || source.kind === "canvas") return null;
  for (const session of sessions) {
    if (session.sessionId !== source.sessionId) continue;
    for (const tab of session.tabs) {
      if (tab.tabId !== source.tabId) continue;
      if (tab.status === "closing" || tab.status === "crashed") {
        return "closed";
      }
      return tab.url === source.pageUrl ? null : "navigated";
    }
    return null;
  }
  return null;
}

/**
 * D06's once-per-epic sharing sentence for tile captures.
 *
 * It lives in its own module rather than beside the control that shows it so
 * that file exports components only: a module that mixes a component with a
 * plain function loses React Fast Refresh for the whole file.
 */

/**
 * Captures from a `primary`-profile tab are readable by everyone with epic
 * permission (D06), which is not obvious from a button that looks like a
 * screenshot key. Said ONCE per epic rather than on every capture: repeated on
 * each one it becomes the thing people click past.
 */
export const COLLABORATOR_SHARING_COPY =
  "Files captured here are visible to everyone on this epic.";

const SHARING_NOTICE_STORAGE_PREFIX = "traycer:epic-capture-sharing-notice:";

/**
 * Epics whose notice has been shown in THIS renderer, consulted before
 * storage. It is the fallback that makes the rule survive a `localStorage`
 * that throws (private mode, disabled site data): once per session beats
 * once per capture, and beats never.
 */
const sharingNoticeShownThisSession = new Set<string>();

/** Whether this capture is the one that carries the D06 sentence. */
export function claimSharingNotice(epicId: string): boolean {
  if (sharingNoticeShownThisSession.has(epicId)) return false;
  sharingNoticeShownThisSession.add(epicId);
  const key = `${SHARING_NOTICE_STORAGE_PREFIX}${epicId}`;
  try {
    if (window.localStorage.getItem(key) !== null) return false;
    window.localStorage.setItem(key, "1");
  } catch {
    // Storage unavailable - the in-memory set above still bounds it.
    return true;
  }
  return true;
}

/** Test seam: the module-level notice memory outlives one test's epic. */
export function __resetCaptureSharingNoticeForTests(): void {
  sharingNoticeShownThisSession.clear();
}

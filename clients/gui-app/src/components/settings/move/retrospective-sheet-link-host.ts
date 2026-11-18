/**
 * Tracy's first message on a computer an earlier version shared (the host's
 * `already_shared` invitation) carries this link,
 * `environment/retrospective?host=<hostId>`: a path inside the task, so the
 * host's announcement check accepts it. The desktop draws it as the message's
 * one action, Review, which opens that host's retrospective sheet.
 */
const LINK_BASE = "https://task.invalid/task/";
const LINK_PATH = "/task/environment/retrospective";

/** The host a retrospective sheet link names, or null for any other link. */
export function retrospectiveSheetLinkHostId(link: string): string | null {
  if (!URL.canParse(link, LINK_BASE) || URL.canParse(link)) return null;
  const url = new URL(link, LINK_BASE);
  if (url.pathname !== LINK_PATH) return null;
  const hostId = url.searchParams.get("host") ?? "";
  return hostId.length > 0 ? hostId : null;
}

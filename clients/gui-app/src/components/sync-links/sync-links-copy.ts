/**
 * The words of the ask about computers a 1.5.4 "Sync profiles" linked. Every
 * string here is on the approved canvas (sync-links-ask boards 1 to 13) except
 * where a comment says it waits for a ruling.
 */

/** "MacBook Air", "MacBook Air and Mac mini", "A, B and C". */
export function joinComputerNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
}

export function askToastTitle(names: readonly string[]): string {
  return `Accounts synced with ${joinComputerNames(names)}`;
}

export const ASK_TOAST_ACTION = "Choose…";

export function askDialogTitle(names: readonly string[]): string {
  return `Synced with ${joinComputerNames(names)}`;
}

export function askFolderRowText(providerName: string, label: string): string {
  return `${providerName} · ${label}`;
}

export const ASK_DETAILS = "Details";
export const ASK_STOP = "Stop syncing";

/**
 * One linked computer reads "both"; two or more read "all" (boards 2 and 7).
 */
export function askMoveLabel(peerCount: number): string {
  return peerCount === 1 ? "Move both to Personal" : "Move all to Personal";
}

export function askMoveDetail(names: readonly string[]): string {
  return names.length === 1
    ? `Move both to Personal: they keep working on both computers. ${atSentenceStart(names[0])} moves too.`
    : "Move all to Personal: they keep working on every computer. Each computer moves too.";
}

/**
 * The Stop line. Stop only ends the sync and removes nothing on any computer;
 * an account that renews may later need a sign-in on one of them. Two
 * computers read "both"; three or more read "every".
 */
export function askStopDetail(
  holdsRenewingAccount: boolean,
  peerCount: number,
): string {
  const computers = peerCount === 1 ? "both computers" : "every computer";
  return holdsRenewingAccount
    ? `Stop syncing: they stay on ${computers}. One of them may need to sign in again later.`
    : `Stop syncing: they keep working on ${computers}.`;
}

export function peerNeedsUpdateText(name: string): string {
  return `${atSentenceStart(name)} needs the latest Traycer.`;
}

export function heldForPersonalText(names: readonly string[]): string {
  const verb = names.length === 1 ? "does" : "do";
  return `Moves to Personal when ${joinComputerNames(names)} ${verb}`;
}

/**
 * What every sentence calls a linked computer whose name the host does not
 * know (board 13).
 */
export const UNNAMED_PEER_NAME = "another computer";

/** A computer's own name keeps its case; only {@link UNNAMED_PEER_NAME} is capitalised. */
function atSentenceStart(name: string | undefined): string {
  if (name === UNNAMED_PEER_NAME) return "Another computer";
  return name ?? "";
}

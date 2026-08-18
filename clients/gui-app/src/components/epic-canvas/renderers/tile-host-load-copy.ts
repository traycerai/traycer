import type { HostLeaseDeadState } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import type { BoundedHostLoad } from "@/hooks/host/use-bounded-host-load";

/**
 * The words for every bounded tile-load state, as pure functions.
 *
 * Split out of `tile-host-load-state.tsx` for the reason that file's own
 * neighbour `chat-tile-runtime-gate.tsx` records: a module that exports both
 * components and plain functions breaks Fast Refresh. It also means the copy
 * can be asserted without mounting anything.
 */

export type TileLoadSubject =
  "agent" | "terminal" | "shell-output" | "diff" | "pull-request" | "document";

/**
 * The noun each subject is called in copy. A table rather than the union
 * member itself so the wire-ish key and the reader-facing word can differ
 * ("shell-output" is not a phrase anyone says).
 */
const SUBJECT_NOUN: Record<TileLoadSubject, string> = {
  agent: "agent",
  terminal: "terminal",
  "shell-output": "output",
  diff: "diff",
  "pull-request": "pull request",
  document: "document",
};

export function tileLoadNoun(subject: TileLoadSubject): string {
  return SUBJECT_NOUN[subject];
}

/**
 * Keyed on the CONTRACT's own `reason` union (`HostLeaseDeadState`), not on a
 * hand-written copy of it. A sixth dead reason added to the contract fails to
 * compile HERE, naming its missing key - rather than arriving at runtime and
 * routing silently to a generic fallback. That failure mode is not
 * hypothetical: it is exactly how `activateRefusalMessage` shipped a broker
 * message instead of a compile error during P1.2, and how this very tile
 * family rendered every `plan-restricted` host as "offline" for months.
 */
const DEAD_MESSAGE: Record<
  HostLeaseDeadState["reason"],
  /** `named` arrives pre-quoted, or as "the host" when no label resolved. */
  (noun: string, named: string) => string
> = {
  offline: (noun, named) =>
    `Host ${named} is offline, so this ${noun} can't be loaded. It will load once that host is back.`,
  "plan-restricted": (noun, named) =>
    `Host ${named} is local only on your current plan, so this ${noun} can't be reached from here. Upgrade to use that host remotely, or open it on that machine.`,
  removed: (noun, named) =>
    `Host ${named} was removed from your account, so this ${noun} can't be loaded.`,
  incompatible: (noun, named) =>
    `Host ${named} needs to be updated before this ${noun} can be loaded.`,
};

/**
 * The sentence for one bounded load state. Asserted directly by the S1-S6
 * catalog suite: "no spinner is on screen" passes vacuously when nothing
 * rendered at all, and that is the exact shape an empty mount produces, so
 * the pins assert the WORDS.
 */
export function tileHostLoadMessage(
  load: Exclude<BoundedHostLoad, { kind: "ready" }>,
  noun: string,
): string {
  // `null` means the directory has not resolved a label, so the sentence says
  // "the host" instead of printing a raw uuid at a person.
  const named = load.hostLabel === null ? "the host" : `"${load.hostLabel}"`;
  switch (load.kind) {
    case "connecting":
      return `Waiting for ${named} to start…`;
    case "loading":
      return `Loading this ${noun} from ${named}…`;
    case "timed-out":
      // Says what is true - the host did not answer in time - and refuses to
      // guess why. The host may be fine and merely slow, so a death claim
      // here would be the same lie the `indeterminate` arm of
      // `useHostReachability` exists to avoid.
      return `This ${noun} hasn't loaded from ${named} yet. That host hasn't answered.`;
    case "dead":
      return DEAD_MESSAGE[load.dead.reason](noun, named);
  }
}

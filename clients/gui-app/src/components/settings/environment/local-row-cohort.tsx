import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";

/**
 * The verb at the end of a Local row: `Move to Personal` opens the move
 * sheet, `finish moving` the computer's Overview, where the stopped upload
 * has its Retry.
 */
export type LocalRowVerb = "move_to_personal" | "finish_moving";

/**
 * STUB (P5 replaces its body): the cohort rule for a
 * host's Local row, read from its `environment.status` (`planes`).
 *
 * - `none`: the host has no Local row.
 * - `local`: it has one, with this subtitle (the text before the verb) and
 *   verb; `defaultsToLocal` makes it the window's default pick when the host
 *   is this window's own.
 *
 * `null` leaves the decision to the picker's own rule (a Local row while
 * setup awaits consent, `not moved · …` or `partly moved · finish moving`).
 */
export type LocalRowCohort =
  | { readonly kind: "none" }
  | {
      readonly kind: "local";
      readonly subtitle: string;
      readonly verb: LocalRowVerb | null;
      readonly defaultsToLocal: boolean;
    };

export function localRowCohort(
  _status: EnvironmentStatusResponseV11,
): LocalRowCohort | null {
  return null;
}

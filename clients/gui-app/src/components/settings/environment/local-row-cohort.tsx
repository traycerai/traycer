import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import { cohortFromPlanes } from "@/components/settings/move/cohort-rows";

/**
 * The verb at the end of a Local row: `Move to Personal` opens the move
 * sheet, `Finish moving` the computer's Overview, where the stopped upload
 * has its Retry.
 */
export type LocalRowVerb = "move_to_personal" | "finish_moving";

/**
 * The cohort rule for a host's Local row, read from its
 * `environment.status` (`planes`).
 *
 * - `none`: the host has no Local row.
 * - `local`: it has one, with this subtitle (the text before the verb) and
 *   verb; `defaultsToLocal` makes it the window's default pick when the host
 *   is this window's own.
 *
 * `none` is the whole answer for a computer with no plane of its own left:
 * the planes decide, and there is no second rule behind this one.
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
  status: EnvironmentStatusResponseV11,
): LocalRowCohort {
  const cohort = cohortFromPlanes(
    status.planes,
    status.pendingUploads.length > 0,
  );
  if (!cohort.hasLocalRow || cohort.subtitle === null) {
    return { kind: "none" };
  }
  return {
    kind: "local",
    subtitle: cohort.subtitle,
    verb: cohort.verb,
    defaultsToLocal: cohort.defaultToLocalRow,
  };
}

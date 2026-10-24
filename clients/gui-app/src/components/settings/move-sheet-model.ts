import type {
  EnvironmentMoveAcceptRequest,
  EnvironmentMovePlanResponse,
} from "@traycer/protocol/host/environment/move-contracts";

export type MoveRow = EnvironmentMovePlanResponse["rows"]["moves"][number];
export type MoveKeyChoice =
  EnvironmentMoveAcceptRequest["keyChoices"][number]["choice"];

/**
 * A row that looks like a key becomes a secret unless the person chooses
 * `Leave as a variable` or `Leave on this computer only`.
 */
export const DEFAULT_KEY_CHOICE: MoveKeyChoice = "secret";

export const MOVE_DISCLOSURE =
  "Stored encrypted in Traycer's cloud. Computers running Personal receive the value, readable by their tools and agents; sandboxes use it through the broker.";

export const MOVE_ACCEPTS_AS_SHOWN =
  "Move accepts this list as shown; if it changes before the upload finishes, you are asked again.";

export const PLAN_CHANGED_TEXT = "This list changed. Read it again.";

/** The sheet's sections, in the order it draws them. */
export const MOVE_SECTIONS = [
  { rows: "moves", title: "Moves", empty: "Nothing to move." },
  {
    rows: "staysOnThisComputer",
    title: "Stays on this computer",
    empty: "Nothing.",
  },
  {
    rows: "alreadyInPersonal",
    title: "Already in Personal",
    empty: "Nothing yet.",
  },
  { rows: "differsMasked", title: "Differs, masked", empty: null },
] as const satisfies ReadonlyArray<{
  readonly rows: keyof EnvironmentMovePlanResponse["rows"];
  readonly title: string;
  readonly empty: string | null;
}>;

/**
 * The accept request for `plan` as the person left it: the plan's hash and
 * one choice per row that looks like a key, the default where they made none.
 */
export function moveAcceptRequest(
  plan: EnvironmentMovePlanResponse,
  choices: ReadonlyMap<string, MoveKeyChoice>,
): EnvironmentMoveAcceptRequest {
  return {
    planHash: plan.planHash,
    keyChoices: plan.rows.looksLikeAKey.map((row) => ({
      key: row.key,
      choice: choices.get(row.key) ?? DEFAULT_KEY_CHOICE,
    })),
  };
}

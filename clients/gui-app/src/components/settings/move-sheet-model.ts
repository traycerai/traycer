import type {
  EnvironmentMoveAcceptRequest,
  EnvironmentMovePlanResponseV11,
} from "@traycer/protocol/host/environment/move-contracts";

export type MoveRow = EnvironmentMovePlanResponseV11["rows"]["moves"][number];
export type MoveKeyChoice =
  EnvironmentMoveAcceptRequest["keyChoices"][number]["choice"];

/**
 * A row that looks like a key moves as a secret unless the person chooses
 * `Leave as a variable` (it moves as a plain variable) or `Leave on this
 * computer only` (it stays).
 */
export const DEFAULT_KEY_CHOICE: MoveKeyChoice = "secret";

export const MOVE_DISCLOSURE =
  "Stored encrypted in Traycer's cloud. Computers running Personal receive the value, readable by their tools and agents; sandboxes use it without seeing it.";

export const MOVE_ACCEPTS_AS_SHOWN =
  "Move accepts this list as shown; if it changes before the upload finishes, you are asked again.";

export const PLAN_CHANGED_TEXT = "This list changed. Read it again.";

/** A move this computer is no longer waiting to start: nothing was moved. */
export function notAwaitingLine(hostName: string): string {
  return `${hostName} has no move waiting to start, so nothing moved.`;
}

/** `MacBook Pro`, `MacBook Pro and dev-box`, `A, B and C`. */
function joinHostNames(hostNames: readonly string[]): string {
  const last = hostNames[hostNames.length - 1] ?? "";
  return hostNames.length < 2
    ? last
    : `${hostNames.slice(0, -1).join(", ")} and ${last}`;
}

/**
 * Where the moved settings go: the computers running Personal, by name, or
 * the computer moving alone when no other runs it.
 */
export function moveReachSentence(
  hostNames: readonly string[],
  movingHostName: string,
): string {
  const reach =
    "Your settings then reach every computer and sandbox running Personal";
  if (hostNames.length === 0) {
    return `${reach}. After the move, that is ${movingHostName} only.`;
  }
  return `${reach}, which today is ${joinHostNames(hostNames)}.`;
}

/**
 * The custody sentence's recipient boundary: the computers that receive a
 * moved secret's value today, and every one that joins Personal later.
 */
export function moveRecipientSentence(hostNames: readonly string[]): string {
  if (hostNames.length === 0) {
    return "No other computer runs Personal yet. Any computer that starts running Personal later receives these keys and secrets as values its tools and agents can read.";
  }
  return `Today that is ${joinHostNames(hostNames)}, and any computer that joins Personal later.`;
}

export function nothingToMoveLine(hostName: string): string {
  return `Nothing on ${hostName} needs moving.`;
}

/**
 * The note above Moves when this computer's agent selection guide has the
 * person's edits (`guideDiffers`): where it goes, and that Personal's guide,
 * or its removal, stands.
 */
export function guideDiffersNote(hostName: string): string {
  return `Agent selection guide: this computer's guide has your edits. It moves to Personal only if Personal has never had a guide. Otherwise it is set aside on ${hostName}, and ${hostName} uses Personal's guide, or the built-in one if Personal's was removed. Nothing in Personal is replaced or restored.`;
}

/**
 * Nothing would leave this computer: no row moves, and no row that looks
 * like a key could be moved by a choice.
 */
export function planMovesNothing(
  plan: EnvironmentMovePlanResponseV11,
): boolean {
  return plan.rows.moves.length === 0 && plan.rows.looksLikeAKey.length === 0;
}

/**
 * What the Moves section lists: every row that leaves this computer. That is
 * the plan's moves, and each row that looks like a key, named by how it
 * moves (`<NAME>, as a secret`, `<NAME>, as a variable`); only one left on
 * this computer (`stays`) is not in it.
 */
export function movesSectionRows(
  plan: EnvironmentMovePlanResponseV11,
  choices: ReadonlyMap<string, MoveKeyChoice>,
): readonly MoveRow[] {
  return [
    ...plan.rows.moves,
    ...plan.rows.looksLikeAKey.flatMap((row) => {
      const choice = choices.get(row.key) ?? DEFAULT_KEY_CHOICE;
      if (choice === "stays") return [];
      const as = choice === "secret" ? "as a secret" : "as a variable";
      return [{ ...row, label: `${row.label}, ${as}`, detail: null }];
    }),
  ];
}

/**
 * Whether the move stores anything as a secret: a secret among the moves, or
 * a row that looks like a key while its choice is `secret`. Only then does
 * the sheet say where secrets are stored.
 */
export function planMovesASecret(
  plan: EnvironmentMovePlanResponseV11,
  choices: ReadonlyMap<string, MoveKeyChoice>,
): boolean {
  return (
    plan.rows.moves.some((row) => row.kind === "secret") ||
    plan.rows.looksLikeAKey.some(
      (row) => (choices.get(row.key) ?? DEFAULT_KEY_CHOICE) === "secret",
    )
  );
}

/**
 * The sheet's sections, in the order it draws them; one with no `empty`
 * line is left out while it has no rows. `detailSeparator` sits between a
 * row's label and its detail: a differing or same-name row's detail is a
 * sentence about that item, so it reads `<label>: <detail>`. `null` means a
 * row with a detail shows the detail alone: a stays row's reason starts with
 * the item's name (`github (MCP server) runs … on this computer, so it stays
 * here and keeps working.`), so the label would name it twice.
 */
export const MOVE_SECTIONS = [
  {
    rows: "moves",
    title: "Moves",
    empty: null,
    detailSeparator: " · ",
  },
  {
    rows: "staysOnThisComputer",
    title: "Stays on this computer",
    empty: "Nothing.",
    detailSeparator: null,
  },
  {
    rows: "alreadyInPersonal",
    title: "Already in Personal",
    empty: "Nothing yet.",
    detailSeparator: " · ",
  },
  {
    rows: "sameNameInPersonal",
    title: "Same name in Personal",
    empty: null,
    detailSeparator: ": ",
  },
  {
    rows: "differsMasked",
    title: "Different from Personal",
    empty: null,
    detailSeparator: ": ",
  },
] as const satisfies ReadonlyArray<{
  readonly rows: keyof EnvironmentMovePlanResponseV11["rows"];
  readonly title: string;
  readonly empty: string | null;
  readonly detailSeparator: string | null;
}>;

/**
 * The accept request for `plan` as the person left it: the plan's hash and
 * one choice per row that looks like a key, the default where they made none.
 */
export function moveAcceptRequest(
  plan: EnvironmentMovePlanResponseV11,
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

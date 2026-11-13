import {
  environmentMoveItemChoiceKey,
  type EnvironmentMoveAcceptRequest,
  type EnvironmentMovePlanResponseV12,
} from "@traycer/protocol/host/environment/move-contracts";
import {
  envOverrideProviderName,
  itemPageName,
} from "@/components/settings/personal/personal-page-status";

export type MovePlan = EnvironmentMovePlanResponseV12;
export type MoveRow = MovePlan["rows"]["moves"][number];
export type MoveKeyChoice =
  EnvironmentMoveAcceptRequest["keyChoices"][number]["choice"];

export const MOVE_DISCLOSURE =
  "Stored encrypted in Traycer's cloud. Computers running Personal receive the value, readable by their tools and agents; sandboxes use it without seeing it.";

export const MOVE_ACCEPTS_AS_SHOWN =
  "Move accepts this list as shown; if it changes before the upload finishes, you are asked again.";

export const PLAN_CHANGED_TEXT = "This list changed. Read it again.";

/** A move this computer is no longer waiting to start: nothing was moved. */
export function notAwaitingLine(hostName: string): string {
  return `${hostName} has no move waiting to start, so nothing moved.`;
}

/**
 * Other computers by name: up to two named (`A`, `A and B`), from three the
 * first two and a count (`A, B and 2 more`).
 */
function namedOthers(hostNames: readonly string[]): string {
  const [first = "", second = ""] = hostNames;
  if (hostNames.length === 1) return first;
  if (hostNames.length === 2) return `${first} and ${second}`;
  return `${first}, ${second} and ${String(hostNames.length - 2)} more`;
}

/**
 * Where the moved settings go: the other computers running Personal, up to
 * two by name, and the moving computer; or the moving computer alone when no other
 * runs it.
 */
export function moveReachSentence(
  hostNames: readonly string[],
  movingHostName: string,
): string {
  const reach =
    "Your settings then reach every computer and sandbox running Personal";
  const [first = "", second = ""] = hostNames;
  if (hostNames.length === 0) {
    return `${reach}. After the move, that is ${movingHostName} only.`;
  }
  if (hostNames.length === 1) {
    return `${reach}, which today is ${first} and ${movingHostName}.`;
  }
  if (hostNames.length === 2) {
    return `${reach}, which today is ${first}, ${second} and ${movingHostName}.`;
  }
  return `${reach}, which today is ${namedOthers(hostNames)}, and ${movingHostName}.`;
}

/**
 * The custody sentence's recipient boundary: the computers that receive a
 * moved secret's value today, and every one that starts running Personal
 * later.
 */
export function moveRecipientSentence(hostNames: readonly string[]): string {
  const later =
    "computer that starts running Personal later receives these keys and secrets as values its tools and agents can read.";
  if (hostNames.length === 0) {
    return `No other computer runs Personal yet. Any ${later}`;
  }
  return `Today that is ${namedOthers(hostNames)}, and any ${later}`;
}

/**
 * The disclosure when this move stores nothing as a secret but Personal
 * holds keys or secrets: they reach this computer once it runs Personal.
 */
export function existingSecretsArriveSentence(hostName: string): string {
  return `Nothing new is stored as a secret. Once ${hostName} runs Personal, it receives Personal's existing keys and secrets as values its tools and agents can read.`;
}

/** What moving gives the computer, under the sheet's title. */
export const MOVE_SHEET_DESCRIPTION =
  "It then uses your Personal settings, the same ones every computer and sandbox running Personal uses. You can move it back any time.";

/** A plan with no Moves row: the computer still moves, with nothing in it. */
export function nothingToMoveLine(hostName: string): string {
  return `Nothing on ${hostName} needs moving.`;
}

/** A plan with Moves rows: what moves is copied, never taken off. */
export function nothingDeletedLine(hostName: string): string {
  return `Everything also stays on ${hostName}; nothing is deleted.`;
}

/**
 * The note above Moves when this computer's agent selection guide has the
 * person's edits (`guideDiffers`): where it goes, and that Personal's guide,
 * or its removal, stands.
 */
export function guideDiffersNote(hostName: string): string {
  return `Agent selection guide: this computer's guide has your edits. It moves to Personal only if Personal has never had a guide. Otherwise it is set aside on ${hostName}, and ${hostName} uses Personal's guide, or the built-in one if Personal's was removed. Nothing in Personal is replaced or restored.`;
}

/** Nothing would leave this computer: no row moves. */
export function planMovesNothing(plan: MovePlan): boolean {
  return plan.rows.moves.length === 0;
}

/**
 * The person's choices on the sheet, by the key each is sent under: a Moves
 * row's item choice key (`environmentMoveItemChoiceKey`). A Moves row with
 * no entry moves as planned.
 */
export type MoveChoices = ReadonlyMap<string, MoveKeyChoice>;

/** A Moves row's choice key. */
export function moveItemChoiceKey(row: MoveRow): string {
  return environmentMoveItemChoiceKey(row.kind, row.key);
}

/**
 * The choices a Moves row offers, on a host that honours them
 * (`plan.itemChoices`): `Leave on this computer only` on a variable, a
 * provider override and a provider key. Any other row moves as planned.
 */
export function moveRowChoices(
  plan: MovePlan,
  row: MoveRow,
): { readonly stays: boolean } {
  if (!plan.itemChoices) return { stays: false };
  const plain = row.kind === "variable" || row.kind === "env_override";
  return { stays: plain || row.kind === "secret" };
}

export interface MovesSectionRow {
  readonly row: MoveRow;
  /** The key the row's choice is sent under. */
  readonly choiceKey: string;
}

/**
 * What the Moves section lists: every row of the plan that leaves this
 * computer. A row left on this computer only (`stays`) is not in it: it is
 * under Stays.
 */
export function movesSectionRows(
  plan: MovePlan,
  choices: MoveChoices,
): readonly MovesSectionRow[] {
  return plan.rows.moves.flatMap((row): MovesSectionRow[] => {
    const choiceKey = moveItemChoiceKey(row);
    const choice = plan.itemChoices ? choices.get(choiceKey) : undefined;
    if (choice === "stays") return [];
    return [{ row, choiceKey }];
  });
}

/**
 * The rows the person left on this computer only, which Stays lists after
 * the plan's own: the Moves rows they chose `stays` on, each with its choice
 * key so Stays can take the choice back.
 */
export function rowsLeftHere(
  plan: MovePlan,
  choices: MoveChoices,
): readonly MoveRow[] {
  return plan.itemChoices
    ? plan.rows.moves.filter(
        (row) => choices.get(moveItemChoiceKey(row)) === "stays",
      )
    : [];
}

const SUMMARY_WORDS: Readonly<
  Record<string, { readonly one: string; readonly many: string }>
> = {
  variable: { one: "variable", many: "variables" },
  api_key: { one: "API key", many: "API keys" },
  profile: { one: "profile", many: "profiles" },
  mcp_server: { one: "MCP server", many: "MCP servers" },
  skill: { one: "skill", many: "skills" },
  agent_definition: { one: "agent definition", many: "agent definitions" },
  pack_policy: { one: "permission pack", many: "permission packs" },
};

/** The group a Moves row counts in: by its kind, an override by its provider. */
function summaryGroup(entry: MovesSectionRow): string {
  const { kind, key } = entry.row;
  // The one secret a move stores is a provider's key.
  if (kind === "secret") return "api_key";
  if (kind === "env_override")
    return `env_override:${envOverrideProviderName(key) ?? ""}`;
  return kind;
}

function summaryLabel(group: string, count: number): string {
  if (group.startsWith("env_override:")) {
    const provider = group.slice("env_override:".length);
    const noun =
      provider.length === 0 ? "env setting" : `${provider} env setting`;
    return count === 1 ? `1 ${noun}` : `${String(count)} ${noun}s`;
  }
  const pageName = itemPageName(group);
  if (pageName !== null) return pageName;
  const words = SUMMARY_WORDS[group] ?? { one: "item", many: "items" };
  return count === 1 ? `1 ${words.one}` : `${String(count)} ${words.many}`;
}

/**
 * Moves as counts, in the order the rows come: `1 variable · 2 API keys ·
 * Model routing`; a kind a configuration holds one of is named by its page.
 */
export function movesSummary(rows: readonly MovesSectionRow[]): string {
  const counts = new Map<string, number>();
  for (const entry of rows) {
    const group = summaryGroup(entry);
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  return [...counts]
    .map(([group, count]) => summaryLabel(group, count))
    .join(" · ");
}

/**
 * Whether the move stores a secret: a provider's key among the rows that
 * still leave this computer. Only then does the sheet say where secrets are
 * stored.
 */
export function planMovesASecret(
  plan: MovePlan,
  choices: MoveChoices,
): boolean {
  return movesSectionRows(plan, choices).some(
    (entry) => entry.row.kind === "secret",
  );
}

/**
 * The sheet's sections after Moves, in the order it draws them; one with no
 * `empty` line is left out while it has no rows. `detailSeparator` sits
 * between a row's label and its detail: a differing row's detail is a
 * sentence about that item, so it reads `<label>: <detail>`.
 * `null` means a row with a detail shows the detail alone: a stays row's
 * reason starts with the item's name (`github (MCP server) runs … on this
 * computer, so it stays here and keeps working.`), so the label would name it
 * twice.
 */
export const MOVE_SECTIONS = [
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
    rows: "differsMasked",
    title: "Different from Personal",
    empty: null,
    detailSeparator: ": ",
  },
] as const satisfies ReadonlyArray<{
  readonly rows: keyof MovePlan["rows"];
  readonly title: string;
  readonly empty: string | null;
  readonly detailSeparator: string | null;
}>;

/**
 * The accept request for `plan` as the person left it: the plan's hash and,
 * on a host that honours them, each Moves row's choice.
 */
export function moveAcceptRequest(
  plan: MovePlan,
  choices: MoveChoices,
): EnvironmentMoveAcceptRequest {
  return {
    planHash: plan.planHash,
    keyChoices: plan.itemChoices
      ? plan.rows.moves.flatMap((row) => {
          const key = moveItemChoiceKey(row);
          const choice = choices.get(key);
          return choice === undefined ? [] : [{ key, choice }];
        })
      : [],
  };
}

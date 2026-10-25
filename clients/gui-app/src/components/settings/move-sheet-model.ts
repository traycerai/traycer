import {
  environmentMoveItemChoiceKey,
  type EnvironmentMoveAcceptRequest,
  type EnvironmentMovePlanResponseV12,
} from "@traycer/protocol/host/environment/move-contracts";
import {
  envOverrideProviderName,
  itemPageName,
  moveRowLabel,
} from "@/components/settings/personal/personal-page-status";

export type MovePlan = EnvironmentMovePlanResponseV12;
export type MoveRow = MovePlan["rows"]["moves"][number];
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
 * two by name, and this computer; or the computer moving alone when no other
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
    return `${reach}, which today is ${first} and this computer.`;
  }
  if (hostNames.length === 2) {
    return `${reach}, which today is ${first}, ${second} and this computer.`;
  }
  return `${reach}, which today is ${namedOthers(hostNames)}, and this computer.`;
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
export function planMovesNothing(plan: MovePlan): boolean {
  return plan.rows.moves.length === 0 && plan.rows.looksLikeAKey.length === 0;
}

/**
 * The person's choices on the sheet, by the key each is sent under: a
 * `looksLikeAKey` row's own key, a Moves row's item choice key
 * (`environmentMoveItemChoiceKey`). A Moves row with no entry moves as
 * planned.
 */
export type MoveChoices = ReadonlyMap<string, MoveKeyChoice>;

/** A Moves row's choice key. */
export function moveItemChoiceKey(row: MoveRow): string {
  return environmentMoveItemChoiceKey(row.kind, row.key);
}

/**
 * The choices a Moves row offers, on a host that honours them
 * (`plan.itemChoices`): `Mark as a secret` on a variable or a provider
 * override, `Leave on this computer only` on those and on a provider key.
 * Any other row moves as planned.
 */
export function moveRowChoices(
  plan: MovePlan,
  row: MoveRow,
): { readonly secret: boolean; readonly stays: boolean } {
  if (!plan.itemChoices) return { secret: false, stays: false };
  const plain = row.kind === "variable" || row.kind === "env_override";
  return { secret: plain, stays: plain || row.kind === "secret" };
}

/** How a row in Moves goes: as planned, or as the person chose on it. */
export type MovesTreatment = "secret" | "variable" | null;

export interface MovesSectionRow {
  readonly row: MoveRow;
  /** The key the row's choice is sent under. */
  readonly choiceKey: string;
  readonly treatment: MovesTreatment;
  /** Whether the row came from Looks like a key, whose buttons live there. */
  readonly looksLikeAKey: boolean;
}

/**
 * What the Moves section lists: every row that leaves this computer. That is
 * the plan's moves, each named by how it moves when it was marked as a
 * secret, and each row that looks like a key, named by how it moves
 * (`<NAME>, as a secret`, `<NAME>, as a variable`). A row left on this
 * computer only (`stays`) is not in it: it is under Stays.
 */
export function movesSectionRows(
  plan: MovePlan,
  choices: MoveChoices,
): readonly MovesSectionRow[] {
  return [
    ...plan.rows.moves.flatMap((row): MovesSectionRow[] => {
      const choiceKey = moveItemChoiceKey(row);
      const choice = plan.itemChoices ? choices.get(choiceKey) : undefined;
      if (choice === "stays") return [];
      return [
        {
          row,
          choiceKey,
          treatment: choice === "secret" ? "secret" : null,
          looksLikeAKey: false,
        },
      ];
    }),
    ...plan.rows.looksLikeAKey.flatMap((row): MovesSectionRow[] => {
      const choice = choices.get(row.key) ?? DEFAULT_KEY_CHOICE;
      if (choice === "stays") return [];
      return [
        {
          row,
          choiceKey: row.key,
          treatment: choice === "secret" ? "secret" : "variable",
          looksLikeAKey: true,
        },
      ];
    }),
  ];
}

/**
 * A Moves row as the sheet names it: `<NAME> (<Provider>)` for an override,
 * with how it moves when that is not as planned (`, as a secret`).
 */
export function movesRowText(entry: MovesSectionRow): string {
  const name = moveRowLabel(entry.row);
  return entry.treatment === null ? name : `${name}, as a ${entry.treatment}`;
}

/**
 * The rows the person left on this computer only, which Stays lists after
 * the plan's own: `items` from Moves, each with its choice key so Stays can
 * take the choice back, and `keys` from Looks like a key, whose buttons stay
 * in that section.
 */
export function rowsLeftHere(
  plan: MovePlan,
  choices: MoveChoices,
): {
  readonly items: readonly MoveRow[];
  readonly keys: readonly MoveRow[];
} {
  return {
    items: plan.itemChoices
      ? plan.rows.moves.filter(
          (row) => choices.get(moveItemChoiceKey(row)) === "stays",
        )
      : [],
    keys: plan.rows.looksLikeAKey.filter(
      (row) => (choices.get(row.key) ?? DEFAULT_KEY_CHOICE) === "stays",
    ),
  };
}

const SUMMARY_WORDS: Readonly<
  Record<string, { readonly one: string; readonly many: string }>
> = {
  variable: { one: "variable", many: "variables" },
  secret: { one: "secret", many: "secrets" },
  api_key: { one: "API key", many: "API keys" },
  profile: { one: "profile", many: "profiles" },
  mcp_server: { one: "MCP server", many: "MCP servers" },
  skill: { one: "skill", many: "skills" },
  agent_definition: { one: "agent definition", many: "agent definitions" },
  pack_policy: { one: "permission pack", many: "permission packs" },
};

/** The group a Moves row counts in: by how it moves, an override by its provider. */
function summaryGroup(entry: MovesSectionRow): string {
  if (entry.treatment === "secret") return "secret";
  const { kind, key } = entry.row;
  if (entry.treatment === "variable" && kind !== "env_override") return kind;
  // A secret the plan moves as itself is a provider's key.
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
 * Moves as counts, in the order the rows come: `1 variable · 2 secrets ·
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
 * Whether the move stores anything as a secret: a secret among the moves, a
 * Moves row marked as one, or a row that looks like a key while its choice is
 * `secret`. Only then does the sheet say where secrets are stored.
 */
export function planMovesASecret(
  plan: MovePlan,
  choices: MoveChoices,
): boolean {
  return movesSectionRows(plan, choices).some(
    (entry) => entry.treatment === "secret" || entry.row.kind === "secret",
  );
}

/**
 * The sheet's sections after Moves, in the order it draws them; one with no
 * `empty` line is left out while it has no rows. `detailSeparator` sits
 * between a row's label and its detail: a differing or same-name row's
 * detail is a sentence about that item, so it reads `<label>: <detail>`.
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
  readonly rows: keyof MovePlan["rows"];
  readonly title: string;
  readonly empty: string | null;
  readonly detailSeparator: string | null;
}>;

/**
 * The accept request for `plan` as the person left it: the plan's hash, one
 * choice per row that looks like a key (the default where they made none),
 * and, on a host that honours them, each Moves row's choice.
 */
export function moveAcceptRequest(
  plan: MovePlan,
  choices: MoveChoices,
): EnvironmentMoveAcceptRequest {
  return {
    planHash: plan.planHash,
    keyChoices: [
      ...plan.rows.looksLikeAKey.map((row) => ({
        key: row.key,
        choice: choices.get(row.key) ?? DEFAULT_KEY_CHOICE,
      })),
      ...(plan.itemChoices
        ? plan.rows.moves.flatMap((row) => {
            const key = moveItemChoiceKey(row);
            const choice = choices.get(key);
            return choice === undefined ? [] : [{ key, choice }];
          })
        : []),
    ],
  };
}

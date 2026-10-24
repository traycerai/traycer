import type { StopChoice } from "@/components/settings/move/stop-sharing-copy";

export interface StopManagedRow {
  readonly kind: string;
  readonly key: string;
  readonly label: string;
  readonly detail: string | null;
}

export interface StopNeedsChoiceRow {
  readonly kind: string;
  readonly key: string;
  readonly label: string;
  readonly detail: string | null;
  readonly reason: "edited_here" | "depended_on";
}

export interface StopChoiceEntry {
  readonly kind: string;
  readonly key: string;
  readonly choice: StopChoice;
}

/**
 * A row's identity: its kind and its key, since a variable and a skill can
 * share a key.
 */
export function stopRowAddress(row: {
  readonly kind: string;
  readonly key: string;
}): string {
  return JSON.stringify([row.kind, row.key]);
}

/**
 * A choice keyed by row address ({@link stopRowAddress}). The value type
 * includes `undefined` so a missing key is distinguishable: a plain
 * `Record<string, StopChoice>` makes `choices[key] !== undefined` always true.
 */
export type StopChoiceMap = { readonly [key: string]: StopChoice | undefined };

/** Confirm is enabled only once every row that needs a choice has one. */
export function stopSharingConfirmEnabled(
  needsChoice: readonly StopNeedsChoiceRow[],
  choices: StopChoiceMap,
): boolean {
  return needsChoice.every((row) => choices[stopRowAddress(row)] !== undefined);
}

export function stopChoiceEntries(
  needsChoice: readonly StopNeedsChoiceRow[],
  choices: StopChoiceMap,
): readonly StopChoiceEntry[] {
  const entries: StopChoiceEntry[] = [];
  for (const row of needsChoice) {
    const choice = choices[stopRowAddress(row)];
    if (choice === undefined) continue;
    entries.push({ kind: row.kind, key: row.key, choice });
  }
  return entries;
}

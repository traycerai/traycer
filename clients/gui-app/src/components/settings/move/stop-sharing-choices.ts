import type {
  StopChoice,
  StopChoiceOrigin,
} from "@/components/settings/move/stop-sharing-copy";

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
  readonly origin: StopChoiceOrigin;
  /** The names of the rows that depend on it. */
  readonly usedBy: readonly string[];
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

/** The rows that need no choice: the stop removes them from this computer. */
export function stopRemovedRows(
  managed: readonly StopManagedRow[],
  needsChoice: readonly StopNeedsChoiceRow[],
): readonly StopManagedRow[] {
  const choosing = new Set(needsChoice.map(stopRowAddress));
  return managed.filter((row) => !choosing.has(stopRowAddress(row)));
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

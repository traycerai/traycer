import {
  ORDERED_PROVIDERS,
  providerDisplayName,
} from "@/lib/provider-ordering";

/** History can name an unused setting with either its key or its display label. */
export function unusedSettingLabel(item: string | null): string {
  const harnessId = item?.split(":")[0];
  const provider = ORDERED_PROVIDERS.find(
    (entry) =>
      entry.harnessId === harnessId ||
      item === `${providerDisplayName(entry.providerId)} key`,
  );
  const label =
    provider === undefined ? "Agent" : providerDisplayName(provider.providerId);
  return `${label} key`;
}

/**
 * The rows a person reads: one line per agent, however many keys are stored.
 * A line names the agent and never the key, so a second key adds nothing to it.
 */
export function oneLinePerAgent<T>(
  rows: readonly T[],
  lineOf: (row: T) => string,
): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const line = lineOf(row);
    if (seen.has(line)) return false;
    seen.add(line);
    return true;
  });
}

/**
 * The name the held-items line gives the host its rows came from: the first
 * known, non-empty name of `names` (the account's, then the directory's),
 * then the window's own host's when the rows came from it. Never empty: a
 * host none of them names is "another computer", the window's own "this
 * computer".
 */
export function heldItemsHostName(
  names: readonly (string | null)[],
  windowHost: { readonly isSource: boolean; readonly name: string | null },
): string {
  const known = names.find(
    (name): name is string => name !== null && name.trim().length > 0,
  );
  if (known !== undefined) return known;
  if (!windowHost.isSource) return "another computer";
  const own = windowHost.name;
  return own !== null && own.trim().length > 0 ? own : "this computer";
}

/**
 * Secrets page held-items line. Self-retiring: the parent omits it when no
 * held row is left. `Review them` (`Review it` for one) is the verb that
 * opens the retrospective sheet. Values and commands are counted apart, and
 * a kind with none is left out.
 */
export function heldItemsLineText(
  counts: { readonly values: number; readonly commands: number },
  hostName: string,
): string {
  const parts: string[] = [];
  if (counts.values > 0) {
    parts.push(counts.values === 1 ? "1 value" : `${counts.values} values`);
  }
  if (counts.commands > 0) {
    parts.push(
      counts.commands === 1 ? "1 command" : `${counts.commands} commands`,
    );
  }
  const one = counts.values + counts.commands === 1;
  return `${parts.join(" and ")} from ${hostName} ${one ? "is" : "are"} on hold until you choose · ${one ? "Review it" : "Review them"}`;
}

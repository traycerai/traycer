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
 * opens the retrospective sheet.
 */
export function heldItemsLineText(commands: number, hostName: string): string {
  const one = commands === 1;
  const count = one ? "1 command" : `${commands} commands`;
  return `${count} from ${hostName} ${one ? "is" : "are"} on hold until you choose · ${one ? "Review it" : "Review them"}`;
}

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

/** The teams in `previous` that `next` no longer lists, in `previous` order. */
export function removedTeamIds(
  previous: readonly string[],
  next: readonly string[],
): readonly string[] {
  const kept = new Set(next);
  return previous.filter((teamId) => !kept.has(teamId));
}

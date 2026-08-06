import type { IFuseOptions } from "fuse.js";
import { resortByNameTier, searchFuzzyMatches } from "./fuzzy-ranking";
import type { SlashCommand } from "./types";

/**
 * The command name is what the user is completing, so it dominates; the
 * description is the visible secondary line; the usage hint and kind are
 * matched so queries like "skill" or an argument keyword still narrow the
 * list, but a hit there never outranks a comparable name hit.
 */
const FUSE_KEYS: NonNullable<IFuseOptions<SlashCommand>["keys"]> = [
  { name: "name", weight: 2 },
  { name: "description", weight: 1 },
  { name: "argumentHint", weight: 0.5 },
  { name: "kind", weight: 0.5 },
];

/**
 * Filters and ranks the slash-command catalog for a typed query: one fuzzy
 * pass with the same Fuse tolerance the `@` mention root search uses
 * (replacing the exact-substring filter, which dropped any query with a
 * typo), then the shared stable resort into name prefix/substring tiers so a
 * completion-style query like `/an` ranks literal name hits first.
 *
 * Unlike root `@` search there is no upstream matcher: the whole catalog is
 * fetched and matched only here, so this pass is the filter and rows that
 * don't match are dropped, not appended. Callers pass the catalog
 * alphabetically sorted, so equal-quality matches stay alphabetical via the
 * ranked tie-break on input order.
 */
export function rankSlashCommands(
  commands: ReadonlyArray<SlashCommand>,
  query: string,
): ReadonlyArray<SlashCommand> {
  const trimmedQuery = query.trim();
  if (commands.length === 0 || trimmedQuery.length === 0) {
    return commands;
  }
  const matches = searchFuzzyMatches(commands, trimmedQuery, FUSE_KEYS, null);
  return resortByNameTier(matches, trimmedQuery, (command) => command.name).map(
    (match) => match.item,
  );
}

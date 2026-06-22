/**
 * Declarative scope <-> prefix <-> chip map. Adding a new scope is
 * a single file edit - update `SCOPE_DESCRIPTORS` and the renderer
 * picks it up on the next load. Keep this module framework-free:
 * the palette shell reads it; tests read it; no React.
 *
 * A scope ties together:
 *   - the chip label shown above the input;
 *   - the leading prefix character that narrows to it (`>` etc);
 *   - the per-scope item filter (by `CommandItem.scope`).
 *
 * The `activeScope: null` state is "show everything" and is the
 * default. Only scopes listed here render chips; items with a
 * `CommandItem.scope` not in this table still surface under
 * fuzzy search when no chip is active.
 */
import type { CommandScope } from "@/lib/commands/types";

export interface ScopeDescriptor {
  readonly scope: CommandScope;
  readonly prefix: string;
  readonly label: string;
  readonly keywordHint: string;
}

/**
 * Rendering order is chip-bar order. Keep the list intentionally
 * lean - every extra chip burns header real-estate. Items in other
 * scopes (e.g. "help" leaf rows, "workspaces" worktree rows) remain
 * reachable via fuzzy search without a chip.
 */
export const SCOPE_DESCRIPTORS: ReadonlyArray<ScopeDescriptor> = [
  {
    scope: "actions",
    prefix: ">",
    label: "Actions",
    keywordHint: "action",
  },
  {
    scope: "epics",
    prefix: "#",
    label: "Tasks",
    keywordHint: "task",
  },
  {
    scope: "workspaces",
    prefix: "@",
    label: "Workspaces",
    keywordHint: "workspace",
  },
  {
    scope: "help",
    prefix: "?",
    label: "Help",
    keywordHint: "help",
  },
];

const PREFIX_BY_SCOPE = new Map<CommandScope, string>(
  SCOPE_DESCRIPTORS.map((d) => [d.scope, d.prefix]),
);

const DESCRIPTOR_BY_PREFIX = new Map<string, ScopeDescriptor>(
  SCOPE_DESCRIPTORS.map((d) => [d.prefix, d]),
);

/**
 * Pull an active scope out of a query string. A prefix must be the
 * very first character; mid-string matches stay as plain text so a
 * user searching for `#tag` in, say, a commit message (or
 * hypothetical future repo mentions) isn't silently re-scoped.
 *
 * Returns `{ scope, restQuery }` where `restQuery` is the query
 * minus the prefix (and any single space that follows), or `null`
 * when no prefix is active.
 */
export interface PrefixMatch {
  readonly scope: CommandScope;
  readonly restQuery: string;
}

export function parseScopePrefix(query: string): PrefixMatch | null {
  if (query.length === 0) return null;
  const first = query[0];
  const descriptor = DESCRIPTOR_BY_PREFIX.get(first);
  if (descriptor === undefined) return null;
  const rest = query.slice(1);
  const restTrimmed = rest.startsWith(" ") ? rest.slice(1) : rest;
  return { scope: descriptor.scope, restQuery: restTrimmed };
}

/**
 * Build a query string carrying a scope prefix. Used by chip
 * clicks so the input visibly reflects the active scope - typing
 * keeps working on the `rest` portion after the prefix.
 */
export function writeScopePrefix(scope: CommandScope, rest: string): string {
  const prefix = PREFIX_BY_SCOPE.get(scope);
  if (prefix === undefined) return rest;
  if (rest.length === 0) return prefix;
  return `${prefix} ${rest}`;
}

export function scopeForPrefix(prefix: string): CommandScope | null {
  return DESCRIPTOR_BY_PREFIX.get(prefix)?.scope ?? null;
}

export function prefixForScope(scope: CommandScope): string | null {
  return PREFIX_BY_SCOPE.get(scope) ?? null;
}

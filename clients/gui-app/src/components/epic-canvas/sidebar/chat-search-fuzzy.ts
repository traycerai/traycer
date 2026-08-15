/**
 * Fuzzy title matching for the Epic sidebar's agent (chat) panel search.
 *
 * Deliberately UNLIKE artifact search, which is a host RPC that greps the
 * on-disk artifact mirror and returns ranked hits with content snippets. An
 * agent's searchable text is its title and nothing else - the sidebar already
 * holds every title it renders - so this is a local Fuse pass with no request,
 * no loading state, and no way to fail.
 *
 * The output is a visible-id SET, not a result list: matches feed the same
 * `SidebarFilterVisibilityContext` the interface/ownership filters use, so the
 * tree itself narrows and every row keeps its live chrome (progress icon,
 * notification indicators, archive/share menus, drag-drop). See
 * `epic-sidebar-filter.ts` for that plumbing.
 *
 * Lives apart from `epic-sidebar-chat-search.tsx` so the component file keeps
 * exporting only components (Fast Refresh).
 */
import Fuse, { type IFuseOptions } from "fuse.js";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import type { TreeNode } from "@/stores/epics/open-epic/types";
import { collectWithAncestors } from "@/components/epic-canvas/sidebar/epic-sidebar-filter";
import { displayTitle } from "@/lib/display-title";
import { isEpicNodeKind } from "@/lib/artifacts/node-display";

interface ChatSearchRow {
  readonly id: string;
  readonly title: string;
}

/**
 * Tuned for short, human-written agent titles rather than prose:
 * `ignoreLocation` so a match late in a long title scores like an early one,
 * and a threshold loose enough to survive a typo without matching everything.
 */
const CHAT_SEARCH_FUSE_OPTIONS: IFuseOptions<ChatSearchRow> = {
  includeScore: false,
  ignoreLocation: true,
  threshold: 0.4,
  minMatchCharLength: 1,
  keys: [{ name: "title", weight: 1 }],
};

/** The title text a row is searched by - the same string the row renders. */
export function chatSearchTitle(node: {
  readonly title: string;
  readonly type: string;
}): string {
  // A node whose type the display map does not know still has to answer with
  // SOMETHING searchable, and its raw title is the honest answer - falling back
  // to a kind label would invent text the row never renders.
  return isEpicNodeKind(node.type)
    ? displayTitle(node.title, node.type)
    : node.title;
}

function matchRows(
  rows: ReadonlyArray<ChatSearchRow>,
  query: string,
): ReadonlyArray<ChatSearchRow> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return rows;
  return new Fuse(rows, CHAT_SEARCH_FUSE_OPTIONS)
    .search(trimmed)
    .map((result) => result.item);
}

/**
 * Local tree ids whose title matches `query` - the raw matches, with no
 * ancestor expansion.
 *
 * `null` means "no active search" - the caller passes that straight through as
 * the no-narrowing value, exactly like an inactive filter.
 */
export function chatSearchMatchIds(args: {
  readonly query: string;
  readonly nodeById: Readonly<Record<string, TreeNode>>;
  /** Which node types this panel renders; anything else never matches. */
  readonly treeFilter: (type: string | null | undefined) => boolean;
}): ReadonlySet<string> | null {
  if (args.query.trim().length === 0) return null;
  const rows = Object.values(args.nodeById).flatMap((node): ChatSearchRow[] =>
    args.treeFilter(node.type)
      ? [{ id: node.id, title: chatSearchTitle(node) }]
      : [],
  );
  return new Set(matchRows(rows, args.query).map((row) => row.id));
}

/**
 * Cloud-only rows that match `query`. They are not in the tree, so they cannot
 * be narrowed by an id set and are filtered as a list instead - the same split
 * the interface/ownership filters already make for these rows.
 */
export function filterCloudChatsBySearch(
  chats: ReadonlyArray<CloudChatSummary>,
  query: string,
): ReadonlyArray<CloudChatSummary> {
  if (query.trim().length === 0) return chats;
  const matchedIds = new Set(
    matchRows(
      chats.map((chat) => ({
        id: chat.identity.chatId,
        // The literal `EpicSidebarCloudChatRow` renders: a cloud row's title is
        // nullable on the wire and falls back to the same "Untitled chat".
        title: displayTitle(chat.title ?? "", "chat"),
      })),
      query,
    ).map((row) => row.id),
  );
  return chats.filter((chat) => matchedIds.has(chat.identity.chatId));
}

/**
 * Intersect the filter's MATCHES with the search's. Either side may be `null`
 * ("not narrowing"), and two nulls stay null so the tree renders unnarrowed.
 *
 * Both inputs must be raw matches, never ancestor-expanded sets. Expanding
 * first and intersecting after lets a row that matched NEITHER predicate
 * survive: given a terminal-agent parent with a GUI-chat child, a GUI-only
 * filter expands to {child, parent} and a search for the parent's title expands
 * to {parent}, whose intersection is {parent} - a terminal agent rendered under
 * a GUI-only filter, with the child that actually matched the filter dropped.
 * Intersecting the matches first correctly yields nothing.
 */
export function intersectMatchIds(
  filterMatchIds: ReadonlySet<string> | null,
  searchMatchIds: ReadonlySet<string> | null,
): ReadonlySet<string> | null {
  if (searchMatchIds === null) return filterMatchIds;
  if (filterMatchIds === null) return searchMatchIds;
  const combined = new Set<string>();
  for (const id of searchMatchIds) {
    if (filterMatchIds.has(id)) combined.add(id);
  }
  return combined;
}

/**
 * Ancestor-expand a combined match set so a nested match stays reachable under
 * parents that did not themselves match. Call this ONCE, after every narrowing
 * has been intersected.
 */
export function expandMatchesToVisibleIds(
  matchIds: ReadonlySet<string> | null,
  nodeById: Readonly<Record<string, TreeNode>>,
): ReadonlySet<string> | null {
  if (matchIds === null) return null;
  return collectWithAncestors([...matchIds], nodeById);
}

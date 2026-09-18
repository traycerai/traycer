/**
 * The request behind the Agents panel's "In messages" section, and the one
 * thing the tree above it needs to know about the answer.
 *
 * Separate from the section itself so the mount point can ask once: the tree
 * and the section are driven by the same query box, and the tree's empty state
 * is only honest if it knows whether the messages below it matched. Keeping
 * the hook out of the component file also keeps that file exporting components
 * alone, which is what fast refresh wants.
 */
import { useMemo, type ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useMaybeSidebarBulkSelection } from "@/components/epic-canvas/sidebar/epic-sidebar-selection";
import {
  useChatSearchMessageHits,
  type ChatSearchMessageHitsStatus,
  type ChatSearchSurfaceScope,
} from "@/hooks/chats/use-chat-search-message-hits";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { useEpicSessionHostId } from "@/hooks/epic/use-epic-session-host-id";
import type { HostRpcRegistry } from "@/lib/host";
import {
  usePanelHeaderSearchOpen,
  usePanelHeaderSearchQuery,
} from "@/stores/epics/panel-header-search-store";

/** The panel whose search box this section reads. */
const CHATS_PANEL_ID = "chats";

/** Everything the section needs, resolved once at the mount point. */
export interface EpicSidebarMessageHitsState {
  readonly status: ChatSearchMessageHitsStatus;
  /** Raw, as typed: what "All tasks" hands to the dialog. */
  readonly query: string;
  readonly client: HostClient<HostRpcRegistry> | null;
  /** The session host that answered; results are host-local. */
  readonly hostId: string | null;
}

/**
 * What the tree is told about the section below it. The tree draws no hits
 * itself; it needs this to decide whether its own "No agents match your
 * search." is still true, which is the one thing the two surfaces share.
 *
 * - `absent` - nothing was asked (short query, selection mode, no host).
 * - `loading` / `hits` - the search DID match, or may yet: no empty state.
 * - `empty` - it settled with nothing, and the tree's empty state says so too.
 * - `error` - the section reports it; the tree's empty state stands unchanged.
 */
export interface ChatTreeMessageHits {
  /** Rendered after the tree, inside its scroll container. */
  readonly node: ReactNode;
  readonly state: "absent" | "loading" | "hits" | "empty" | "error";
}

/** For a chat tree mounted somewhere this section does not follow it. */
export const CHAT_TREE_MESSAGE_HITS_NONE: ChatTreeMessageHits = {
  node: null,
  state: "absent",
};

/**
 * The panel's live query, under the same rule the tree applies to it: closed
 * search and bulk selection both read as no query at all, because in neither
 * state is there an input on screen to see it in or to clear it from.
 */
function usePanelQuery(tabId: string): string {
  const searchOpen = usePanelHeaderSearchOpen(tabId, CHATS_PANEL_ID);
  const rawQuery = usePanelHeaderSearchQuery(tabId, CHATS_PANEL_ID);
  const bulkSelection = useMaybeSidebarBulkSelection();
  const selectionMode = bulkSelection?.selectionMode === true;
  return searchOpen && !selectionMode ? rawQuery : "";
}

/**
 * Message hits for the task this panel is showing, on the task's own session
 * host - the tree above is that host's, and the index is per host.
 *
 * The request keys on the debounced query and the epic alone, so a streaming
 * turn re-rendering the tree does not refetch it.
 */
export function useEpicSidebarMessageHits(args: {
  readonly epicId: string;
  readonly tabId: string;
}): EpicSidebarMessageHitsState {
  const { epicId, tabId } = args;
  const query = usePanelQuery(tabId);
  const hostId = useEpicSessionHostId();
  const client = useEpicSessionHostClient();
  const scope = useMemo<ChatSearchSurfaceScope>(
    () => ({ kind: "current-task", epicId }),
    [epicId],
  );
  const status = useChatSearchMessageHits({ client, hostId, query, scope });
  return useMemo(
    () => ({ status, query, client, hostId }),
    [client, hostId, query, status],
  );
}

/**
 * A settled request with nothing to show is `empty` rather than a section: the
 * news belongs in the tree's empty state, which is already saying the search
 * matched nothing, instead of a second header below it saying it again.
 *
 * A page that ranked matches and showed none of them - every one in a task
 * this requester cannot read - still carries a cursor, and the accessible hit
 * sits on the next page. That is `hits`, so the section keeps its continuation
 * control reachable.
 */
export function messageHitsTreeState(
  status: ChatSearchMessageHitsStatus,
): ChatTreeMessageHits["state"] {
  switch (status.kind) {
    case "absent":
      return "absent";
    case "loading":
      return "loading";
    case "error":
      return "error";
    case "ready":
      return status.messages.length === 0 &&
        status.showMore === null &&
        status.loadMoreError === null
        ? "empty"
        : "hits";
  }
}

/** Whether the section is drawn at all: it owns `loading`, `hits` and `error`. */
export function showsMessageHitsSection(
  state: ChatTreeMessageHits["state"],
): boolean {
  return state !== "absent" && state !== "empty";
}

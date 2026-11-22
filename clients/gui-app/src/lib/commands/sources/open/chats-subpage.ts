/**
 * Chat-interface half of the opener's unified **Agents** sub-page (see
 * `agents-subpage.ts`): the "New agent (Chat)" creation leaf plus the Task's
 * existing chat-interface Agents (each opens a fresh instance into the bound
 * target group).
 *
 * Existing Agents come from TWO sources, the same two the sidebar's tree
 * merges (`epic-sidebar-chat-tree.tsx`):
 *
 * - the live projection's chats (`existing`), the rows this device's record
 *   table holds;
 * - the cloud chat list's rows that fold into NO local chat (`cloudOnly`): a
 *   chat created on another machine that the polled record list has not
 *   carried here yet, or one on a host this device cannot reach. The sidebar
 *   shows those at once as cloud rows; the palette used to show them only once
 *   the record landed, up to one record poll later, so a chat just started
 *   elsewhere was in the sidebar and not in the opener.
 *
 * Returns the creation leaf SEPARATELY from the records so the merged sub-page
 * can group both interfaces' creation entries at the top instead of
 * interleaving them - which would read as two entity collections again - and
 * the cloud-only rows separately from `existing` because they have no node in
 * the projection's tree, which is what the merged page walks.
 *
 * The `open:chats:*` leaf ids are load-bearing beyond routing: the palette maps
 * that prefix to the `open_chat` analytics command
 * (`palette-cmdk-controller.ts`), so they survive the category merge unchanged.
 */
import { use, useMemo } from "react";
import { v4 as uuidv4 } from "uuid";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { readHostDirectoryEntry } from "@traycer-clients/shared/host-client/host-connection-registry";
import { hostUnavailability } from "@traycer-clients/shared/host-client/remote-fetcher";
import { ownerSandboxOpensLive } from "@/hooks/chats/use-owner-sandbox-opens-live";
import { ChatServingWitnessContext } from "@/lib/chats/chat-serving-witness";
import { isLocalHostBootingEntry } from "@/lib/host/transport-key";
import { openTileIntoTargetGroup } from "@/lib/commands/actions";
import { makePublishedChatTileRef } from "@/stores/epics/canvas/tile-schema/published-chat-tile";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useCloudChatList } from "@/hooks/chats/use-cloud-chat-queries";
import {
  publicationTargetMap,
  useChatPublicationTargets,
} from "@/hooks/chats/use-chat-publication-targets";
import {
  cloudChatLastActiveAt,
  selectUnfoldedCloudChats,
} from "@/lib/chats/unified-chat-list";
import { displayTitle } from "@/lib/display-title";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";
import {
  openerActionLeaf,
  openerExistingLeaf,
} from "@/lib/commands/sources/open/open-leaf";
import {
  useActiveEpicHostId,
  useActiveEpicProjection,
} from "@/lib/commands/sources/open/use-active-epic-projection";
import type { OpenerInterfaceItems } from "@/lib/commands/sources/open/agents-subpage";
import type { CommandContext, CommandItem } from "@/lib/commands/types";
import { hostNameFromLabel } from "@/hooks/agent/use-host-reachability";

const EMPTY_IDS: ReadonlyArray<string> = [];
const EMPTY_CLOUD_CHATS: ReadonlyArray<CloudChatSummary> = [];

export interface ChatsOpenerItems extends OpenerInterfaceItems {
  /**
   * The task's chats the cloud lists and this device's tree does not hold:
   * no projection node, so the merged Agents page appends them after the tree
   * rather than finding them in it. Most recently active first.
   */
  readonly cloudOnly: ReadonlyArray<CommandItem>;
}

/**
 * The node id a cloud-only row carries in the merged Agents tree (the merged
 * page reads it back off the leaf id). Keyed on the owner as well as the chat
 * id: two owners can hold chats with the same host-minted id under one task
 * (a fork leaves exactly that behind).
 */
function cloudOnlyChatNodeId(chat: CloudChatSummary): string {
  return `cloud:${chat.identity.ownerUserId}:${chat.identity.chatId}`;
}

/**
 * Whether a cloud-only chat opens LIVE against its owner host, or as the
 * published copy the owner last uploaded. The sidebar's cloud row answers
 * this with `useHostReachability` plus `useOwnerSandboxOpensLive`; a palette
 * leaf is data, not a mounted row, so it reads the same directory facts off
 * the connection registry at the moment it runs. The verdicts agree where
 * they can both be reached from here: a listed, dialable owner opens live; a
 * missing, not-dialable or still-booting one, and an empty directory, keep
 * the published copy, which is what "host-starting" lands on in the row too.
 * A sandbox owner at rest opens live where the pool serves it.
 */
function cloudChatOpensLive(
  entry: HostDirectoryEntry | null,
  witnessPresent: boolean,
): boolean {
  if (ownerSandboxOpensLive(entry, witnessPresent)) return true;
  if (entry === null || isLocalHostBootingEntry(entry)) return false;
  return hostUnavailability(entry) === null;
}

export function useChatsOpenerItems(ctx: CommandContext): ChatsOpenerItems {
  // The host serving the active epic's projection: the fallback a chat with
  // no recorded host binds to, and the reference a cross-host badge is judged
  // against. Not the app-wide host - see `useActiveEpicHostId`.
  const activeHostId = useActiveEpicHostId(ctx.activeEpicId);
  const defaultHostId = activeHostId ?? UNKNOWN_HOST_PLACEHOLDER;
  const projection = useActiveEpicProjection(ctx.activeEpicId);
  // Whether the pool serves a sandbox's chat at rest - see
  // `useOwnerSandboxOpensLive`. Absent above the palette, every owner's
  // reachability decides alone, as in a build with no pool.
  const servingWitnessPresent = use(ChatServingWitnessContext) !== null;
  const directoryList = useHostDirectoryList();
  const hostLabelById = useMemo(() => {
    return new Map(
      (directoryList.data ?? []).map((entry) => [entry.hostId, entry.label]),
    );
  }, [directoryList.data]);

  // The cloud read is a byte pipe any reachable host can serve; it rides the
  // epic's own serving host, the same client the sidebar reads the list on,
  // so the TanStack cache entry is shared with it rather than split. Disabled
  // until that host is resolved: a `null` id would follow the app-wide host
  // and mint a second cache entry the sidebar never refreshes.
  const epicId = ctx.activeEpicId ?? "";
  const cloudReadsEnabled = epicId.length > 0 && activeHostId !== null;
  const sessionHostClient = useHostClientForHostId(activeHostId);
  const cloudChats = useCloudChatList({
    client: sessionHostClient,
    taskId: epicId,
    enabled: cloudReadsEnabled,
  });
  const localChatIds = projection?.chats.allIds ?? EMPTY_IDS;
  const sortedLocalChatIds = useMemo(
    () => [...localChatIds].sort(),
    [localChatIds],
  );
  const publicationTargets = useChatPublicationTargets({
    client: sessionHostClient,
    epicId,
    chatIds: sortedLocalChatIds,
    enabled: cloudReadsEnabled,
  });
  const cloudOnlyChats = useMemo(
    () =>
      [
        ...selectUnfoldedCloudChats({
          chats: cloudChats.data?.chats ?? EMPTY_CLOUD_CHATS,
          localChatIds,
          publicationChatIdByChatId: publicationTargetMap(
            publicationTargets.data,
          ),
        }),
      ].sort((a, b) => cloudChatLastActiveAt(b) - cloudChatLastActiveAt(a)),
    [cloudChats.data, localChatIds, publicationTargets.data],
  );

  return useMemo<ChatsOpenerItems>(() => {
    const newChat = openerActionLeaf({
      id: "open:chats:new",
      label: "New agent (Chat)",
      keywords: ["new", "chat", "agent", "create"],
      run: () => {
        if (ctx.activeEpicId === null || ctx.activeTabId === null) return;
        if (ctx.targetGroupId === null) return;
        useNewConversationModalStore
          .getState()
          .setComposerMode(ctx.activeEpicId, "chat");
        useNewConversationModalOpenStore.getState().open({
          epicId: ctx.activeEpicId,
          tabId: ctx.activeTabId,
          placement: { kind: "tab", paneId: ctx.targetGroupId, index: null },
          parentId: null,
          hostId: null,
        });
      },
    });
    // A chat with no recorded hostId falls back to (and thus matches) the
    // epic's host, so only a real, differing hostId ever earns a badge.
    // Requires `activeHostId` to be genuinely resolved first - while it's
    // still `null` (boot, host reconnect window) `defaultHostId` would be
    // the `UNKNOWN_HOST_PLACEHOLDER` sentinel, which no real hostId can
    // ever equal, false-badging every chat as cross-host.
    const badgeFor = (hostId: string | null): string | null =>
      activeHostId !== null && hostId !== null && hostId !== activeHostId
        ? chatHostBadgeLabel(hostLabelById, hostId)
        : null;
    if (projection === null) {
      return { create: newChat, existing: [], cloudOnly: [] };
    }
    const existing = projection.chats.allIds.map((id) => {
      const chat = projection.chats.byId[id];
      return openerExistingLeaf(
        "chats",
        ctx,
        {
          id: chat.id,
          instanceId: uuidv4(),
          type: "chat",
          // Read surface: an untitled Agent renders the render-tier "Untitled
          // agent" fallback, NOT the creation-tier "New chat" default title.
          name: displayTitle(chat.title, "agent"),
          hostId: chat.hostId ?? defaultHostId,
        },
        badgeFor(chat.hostId),
      );
    });
    // The same two refs the sidebar's cloud row opens, chosen the same way.
    // A reachable owner gets the ordinary live chat ref bound to that host:
    // the tile subscribes against it directly and does not need the chat in
    // this device's projection. An unreachable owner gets the published copy,
    // read on this epic's serving host. The live tile's own published-copy
    // fallback cannot stand in for that choice here: it recovers the owner
    // from a SAME-host projection row, and a cloud-only chat has none, so a
    // live ref for an unreachable owner would show a dead tile with no
    // transcript where the sidebar shows the copy.
    const cloudOnly = cloudOnlyChats.map((chat) => {
      const name = displayTitle(chat.title ?? "", "agent");
      const liveRef = (): EpicCanvasTileRef => ({
        id: chat.identity.chatId,
        instanceId: uuidv4(),
        type: "chat",
        name,
        hostId: chat.ownerHostId,
      });
      const publishedRef = (): EpicCanvasTileRef =>
        makePublishedChatTileRef({
          taskId: chat.identity.taskId,
          chatId: chat.identity.chatId,
          ownerUserId: chat.identity.ownerUserId,
          ownerHostId: chat.ownerHostId,
          name,
          hostId: defaultHostId,
        });
      const leaf = openerActionLeaf({
        // Keyed on the owner too: `open:chats:<chatId>` is a LOCAL row's id,
        // and a cloud row can share a host-minted chat id with one. The
        // prefix stays: it routes the `open_chat` analytics command.
        id: `open:chats:${cloudOnlyChatNodeId(chat)}`,
        label: name,
        keywords: [name],
        run: () =>
          openTileIntoTargetGroup({
            tabId: ctx.activeTabId,
            groupId: ctx.targetGroupId,
            // Decided when the leaf RUNS, not when the list was built: the
            // owner can come or go while the palette is open.
            ref: cloudChatOpensLive(
              readHostDirectoryEntry(chat.ownerHostId),
              servingWitnessPresent,
            )
              ? liveRef()
              : publishedRef(),
            dedupe: false,
            navigateNestedFocus: ctx.router.navigateNestedFocus,
          }),
      });
      const hostBadge = badgeFor(chat.ownerHostId);
      const located = { ...leaf, tileHostId: chat.ownerHostId };
      return hostBadge === null ? located : { ...located, hostBadge };
    });
    return { create: newChat, existing, cloudOnly };
  }, [
    ctx,
    projection,
    cloudOnlyChats,
    activeHostId,
    defaultHostId,
    hostLabelById,
    servingWitnessPresent,
  ]);
}

/** "the host" when the directory has no (or a blank) label for it - never its id. */
function chatHostBadgeLabel(
  hostLabelById: ReadonlyMap<string, string>,
  hostId: string,
): string {
  return hostNameFromLabel(hostLabelById.get(hostId) ?? null, hostId);
}

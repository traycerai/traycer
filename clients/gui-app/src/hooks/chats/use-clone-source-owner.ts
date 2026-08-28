import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import { useChatById } from "@/lib/epic-selectors";
import { useCloudChatList } from "@/hooks/chats/use-cloud-chat-queries";

/**
 * The owner a clone surface is CURRENTLY SHOWING for its source chat, which is
 * what `epic.createChat`'s `forkSource.sourceOwnerUserId` carries
 * (chat-sync-v2 ticket 37).
 *
 * ## Why the client sends this at all
 *
 * The clone's cloud tier refuses to seed history unless the host can check the
 * resolved publication's owner against an expectation it holds locally - the
 * anti-squatting guard from ticket 34 B2. A host with no registry facts for the
 * source (a post-restart swept chat, a fresh identity) refuses correctly and
 * the clone degrades to settings-only, losing the transcript. The client knew
 * the owner the whole time: it is on the record it projected, or on the cloud
 * row it rendered the tile from.
 *
 * ## One mechanism, both clone surfaces
 *
 * The dead-tile banner and the in-epic host switcher resolve this identically,
 * so they resolve it HERE rather than each deriving their own. The two sources
 * are ordered, not merged: the local record is this device's own projection of
 * the chat and outranks a listing; the cloud row answers precisely the case the
 * local record cannot (there is no local record).
 *
 * Never a guess. `null` is the honest answer for "this surface does not know",
 * and the host treats it as "no expectation" rather than as a value - so a
 * fabricated owner would be TRUSTED where an absent one merely degrades.
 */

/**
 * `""` is not an owner.
 *
 * The projection reads this field straight off the Yjs record without a
 * length check (`readMaybeNullableString`), and the record can have been
 * written by any build or by a remote writer - the host applies the same
 * non-empty guard when it reads its own copy. It matters more here than it
 * looks: the wire field is `z.string().min(1).nullable()`, so forwarding `""`
 * would fail request validation and turn a clone that should have degraded to
 * settings-only into an outright failure.
 */
function usableOwnerUserId(value: string | null): string | null {
  return value !== null && value.length > 0 ? value : null;
}

export interface ResolveCloneSourceOwnerArgs {
  /** The source chat, or `null` when the surface has no chat in hand. */
  readonly chatId: string | null;
  /** `ChatProjection.userId` - the doc record's owner field. */
  readonly localRecordOwnerUserId: string | null;
  /** `epic.listCloudChats`' rows, or `null` when the list has not answered. */
  readonly cloudChats: readonly CloudChatSummary[] | null;
  /**
   * The host that OWNS the source chat, when the surface genuinely knows it -
   * the dead tile's `sourceHostId`, which every mount resolves from the chat's
   * own binding or its cloud row. Used ONLY to break a tie, never to filter:
   * see below.
   *
   * NOT the host a surface happens to be reading through. A published copy is
   * served by whatever host the DEVICE runs, which is generally not the
   * owner's, so a serving host here would resolve a colliding id to the
   * viewer's own row. Pass `null` unless the value is the owner's host.
   */
  readonly sourceOwnerHostId: string | null;
}

/**
 * The decision itself, kept pure so both surfaces and its tests share it.
 *
 * `chatId` alone is NOT an identity. `cloud-chat.ts` is explicit that the id is
 * host-minted and that two hosts can mint the same one under a single task, so
 * identity is the triple `(taskId, chatId, ownerUserId)` - and `ownerUserId` is
 * precisely what this function is trying to learn, which is why the list is
 * scanned by the other two. When that scan is ambiguous the honest answer is
 * `null`, exactly as the header says: a fabricated owner is TRUSTED by the host
 * where an absent one merely degrades to settings-only, and (since this PR) it
 * also decides whether the dead-tile banner calls a chat the viewer's own.
 *
 * `sourceOwnerHostId` breaks the tie rather than pre-filtering, so the ordinary
 * single-row case is untouched by a caller whose bound host disagrees with the
 * row's `ownerHostId` for any reason this function cannot see.
 */
export function resolveCloneSourceOwnerUserId(
  args: ResolveCloneSourceOwnerArgs,
): string | null {
  if (args.chatId === null) return null;
  const localOwnerUserId = usableOwnerUserId(args.localRecordOwnerUserId);
  if (localOwnerUserId !== null) return localOwnerUserId;
  const rows = (args.cloudChats ?? []).filter(
    (chat) => chat.identity.chatId === args.chatId,
  );
  if (rows.length === 1) {
    return usableOwnerUserId(rows[0].identity.ownerUserId);
  }
  if (rows.length === 0 || args.sourceOwnerHostId === null) return null;
  const onSourceHost = rows.filter(
    (chat) => chat.ownerHostId === args.sourceOwnerHostId,
  );
  if (onSourceHost.length !== 1) return null;
  return usableOwnerUserId(onSourceHost[0].identity.ownerUserId);
}

export interface UseCloneSourceOwnerUserIdArgs {
  /**
   * The app-wide client, matching the one `tab-group-view` and the sidebar
   * already read this list through - the same client means the same query key,
   * so a surface that renders beside them pays no second request.
   */
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly chatId: string | null;
  /** The source chat's bound host, when the surface knows it. */
  readonly sourceOwnerHostId: string | null;
}

export function useCloneSourceOwnerUserId(
  args: UseCloneSourceOwnerUserIdArgs,
): string | null {
  const chatRecord = useChatById(args.chatId);
  const localRecordOwnerUserId = chatRecord?.userId ?? null;
  // The list is consulted only when the local record cannot answer. Where it
  // can, this stays a pure projection read and costs nothing.
  const needsCloudRow =
    args.chatId !== null && usableOwnerUserId(localRecordOwnerUserId) === null;
  const cloudChats = useCloudChatList({
    client: args.client,
    taskId: args.epicId,
    enabled: needsCloudRow,
  });
  return resolveCloneSourceOwnerUserId({
    chatId: args.chatId,
    localRecordOwnerUserId,
    cloudChats: cloudChats.data?.chats ?? null,
    sourceOwnerHostId: args.sourceOwnerHostId,
  });
}

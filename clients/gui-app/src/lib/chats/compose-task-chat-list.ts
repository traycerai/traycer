import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import { defineComposedView } from "@/lib/view-composition/composed-view";

/**
 * A task's chat list as the app composes it: the viewer's own readable rows,
 * and the rows each team environment the task is attached to owns, which
 * only the pool's environment arm serves to a member.
 */
export const TASK_CHAT_LIST_COMPOSED_VIEW = defineComposedView(
  "task-chat-list",
  [
    { id: "viewer", kind: "unary", method: "epic.listCloudChats" },
    {
      id: "environment-arm",
      kind: "stream",
      method: "environment.chats.subscribe",
    },
  ],
);

function identityKey(chat: CloudChatSummary): string {
  return JSON.stringify([
    chat.identity.taskId,
    chat.identity.ownerUserId,
    chat.identity.chatId,
  ]);
}

/**
 * The union by identity triple - `chatId` alone is host-minted and not
 * unique. A chat both contributors describe keeps the viewer's row, the
 * answer to the viewer's own authorization. The viewer's rows keep their
 * order and the arm's follow; the list sorts by its own clock.
 */
export function uniteTaskChats(
  viewer: readonly CloudChatSummary[],
  arm: readonly CloudChatSummary[],
): readonly CloudChatSummary[] {
  if (arm.length === 0) return viewer;
  const seen = new Set(viewer.map(identityKey));
  const added = arm.filter((chat) => {
    const key = identityKey(chat);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return added.length === 0 ? viewer : [...viewer, ...added];
}

/**
 * Whether an environment arm row is the chat `held` stands in for: a team
 * host keys the chat it creates by its environment, so the creator holds it
 * under their own id while the arm serves it under the environment's. A host
 * mints its chat ids, so the same `(chatId, host)` filed under another owner
 * is the same chat.
 */
export function armRowNamesHeldChat(
  row: CloudChatSummary,
  held: {
    readonly id: string;
    readonly hostId: string | null;
    readonly userId: string | null;
  },
): boolean {
  return (
    row.identity.chatId === held.id &&
    row.ownerHostId === held.hostId &&
    row.identity.ownerUserId !== held.userId
  );
}

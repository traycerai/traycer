import { create } from "zustand";
import type { ChatDockSection } from "@/lib/chat/chat-dock-sections";

/**
 * Which compact-dock pill each chat has open (L-142).
 *
 * Per CHAT rather than per tile, and outside the React tree, because a
 * same-pane chat switch is a full REMOUNT in this app: component state would
 * lose the open panel every time the user looked at a sibling chat and came
 * back, which is not what "I opened Files changed in this conversation" means.
 *
 * Session-lifetime and never written to disk. What a pill is OPENED to is a
 * glance, not a preference - `compact` is the persisted statement about how a
 * chat's dock opens, and having one glance silently redefine it for every chat
 * on this machine is the failure the per-chat reveal exists to avoid.
 *
 * Nothing ever auto-opens: a chat with no entry here has no panel attached.
 *
 * The Message queue's fold lives here too (#2441), for the same reason and one
 * more: the queue panel unmounts whenever the queue drains, so a fold kept in
 * the panel came back open with the next queued message - in a busy chat, all
 * the time. A chat with no entry has its queue OPEN, which is what it always
 * was; only a fold the user made is remembered.
 */
const MAX_REMEMBERED_CHATS = 64;

interface ChatDockOpenState {
  readonly openByChatId: ReadonlyMap<string, ChatDockSection>;
  /** Opens `section`, or closes the chat's panel when it is already open. */
  readonly toggleSection: (chatId: string, section: ChatDockSection) => void;
  /** Closes whatever this chat had open - a section that went empty. */
  readonly closeSection: (chatId: string) => void;
  /** Chats whose Message queue the user folded; absent means open. */
  readonly queueCollapsedByChatId: ReadonlyMap<string, boolean>;
  readonly setQueueCollapsed: (chatId: string, collapsed: boolean) => void;
}

/**
 * Insertion-ordered and bounded: a long-lived window can visit thousands of
 * chats, and the oldest entry is the one nobody is looking at.
 */
function withBoundedEntry<T>(
  current: ReadonlyMap<string, T>,
  chatId: string,
  value: T,
): ReadonlyMap<string, T> {
  const next = new Map(current);
  // Delete first so a re-opened chat moves to the END of the insertion order
  // and cannot be evicted while it is the one on screen.
  next.delete(chatId);
  next.set(chatId, value);
  while (next.size > MAX_REMEMBERED_CHATS) {
    const oldest = next.keys().next();
    if (oldest.done === true) break;
    next.delete(oldest.value);
  }
  return next;
}

export const useChatDockOpenStore = create<ChatDockOpenState>((set) => ({
  openByChatId: new Map<string, ChatDockSection>(),
  toggleSection: (chatId, section) => {
    set((state) => {
      if (state.openByChatId.get(chatId) === section) {
        const next = new Map(state.openByChatId);
        next.delete(chatId);
        return { openByChatId: next };
      }
      return {
        openByChatId: withBoundedEntry(state.openByChatId, chatId, section),
      };
    });
  },
  closeSection: (chatId) => {
    set((state) => {
      if (!state.openByChatId.has(chatId)) return state;
      const next = new Map(state.openByChatId);
      next.delete(chatId);
      return { openByChatId: next };
    });
  },
  queueCollapsedByChatId: new Map<string, boolean>(),
  setQueueCollapsed: (chatId, collapsed) => {
    set((state) => {
      if (collapsed) {
        return {
          queueCollapsedByChatId: withBoundedEntry(
            state.queueCollapsedByChatId,
            chatId,
            true,
          ),
        };
      }
      // Open is the default, so an opened queue drops its entry rather than
      // holding a slot in the bound.
      if (!state.queueCollapsedByChatId.has(chatId)) return state;
      const next = new Map(state.queueCollapsedByChatId);
      next.delete(chatId);
      return { queueCollapsedByChatId: next };
    });
  },
}));

export function useChatDockOpenSection(chatId: string): ChatDockSection | null {
  return useChatDockOpenStore(
    (state) => state.openByChatId.get(chatId) ?? null,
  );
}

export function useChatQueueCollapsed(chatId: string): boolean {
  return useChatDockOpenStore(
    (state) => state.queueCollapsedByChatId.get(chatId) === true,
  );
}

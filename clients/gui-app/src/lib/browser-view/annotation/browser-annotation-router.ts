import type {
  BrowserAnnotationSetTargetChatLabelInput,
  BrowserAnnotationTargetOption,
} from "@traycer-clients/shared/platform/browser-annotation";
import type { BrowserViewTileKey } from "@traycer-clients/shared/platform/browser-view";
import { displayTitle } from "@/lib/display-title";
import type { ChatsSlice } from "@/stores/epics/open-epic/types";

export type AnnotationRoute = Omit<
  BrowserAnnotationSetTargetChatLabelInput,
  keyof BrowserViewTileKey
>;

interface ResolveAnnotationRouteInput {
  readonly orderedChatIds: readonly string[];
  readonly chats: ChatsSlice;
  readonly browserHostId: string;
  readonly preferredChatId: string | null;
  readonly lastFocusedChatId: string | null;
}

/**
 * Lists every reachable composer and chooses a default without binding the
 * annotation to the browser tile's layout. The most recent agent associated
 * with this browser wins, followed by the user's last-focused composer.
 */
export function resolveAnnotationRoute(
  input: ResolveAnnotationRouteInput,
): AnnotationRoute {
  const targets: BrowserAnnotationTargetOption[] = input.orderedChatIds.flatMap(
    (chatId) => {
      if (!Object.hasOwn(input.chats.byId, chatId)) return [];
      const chat = input.chats.byId[chatId];
      if (chat.archivedAt !== null) return [];
      if (chat.hostId !== null && chat.hostId !== input.browserHostId) {
        return [];
      }
      return [
        {
          chatId,
          label: displayTitle(chat.title, "agent"),
        },
      ];
    },
  );
  const targetIds = new Set(targets.map((target) => target.chatId));
  const defaultChatId = [input.preferredChatId, input.lastFocusedChatId].find(
    (chatId): chatId is string => chatId !== null && targetIds.has(chatId),
  );
  return {
    targets,
    defaultChatId: defaultChatId ?? targets.at(0)?.chatId ?? null,
  };
}

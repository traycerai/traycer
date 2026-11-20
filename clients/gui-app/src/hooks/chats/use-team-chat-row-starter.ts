import { useEpicChatStarter } from "@/hooks/chats/use-epic-chat-starter";
import { useHostOwnerTeamId } from "@/hooks/sandboxes/use-on-team-sandbox";
import { chatStarterPerson } from "@/lib/identity/started-by";

/**
 * Who started a team computer's chat, for its row's hover. `null` for any
 * other computer's chat, a row that is not a chat, no starter recorded, or a
 * `"system"` starter.
 */
export function useTeamChatRowStarter(input: {
  readonly epicId: string;
  readonly chatId: string;
  readonly isChat: boolean;
  readonly hostId: string | null;
  readonly ownerUserId: string | null;
}): string | null {
  const teamId = useHostOwnerTeamId(input.isChat ? input.hostId : null);
  const starter = chatStarterPerson(
    useEpicChatStarter(
      input.epicId,
      input.isChat ? input.ownerUserId : null,
      input.chatId,
    ),
  );
  return teamId === null ? null : starter;
}

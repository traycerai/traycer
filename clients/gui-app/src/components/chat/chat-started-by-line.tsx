import type { ReactNode } from "react";
import { PersonAvatar } from "@/components/bots/bot-avatars";
import { useEpicChatStarter } from "@/hooks/chats/use-epic-chat-starter";
import { usePersonIdentity } from "@/hooks/identity/use-person-identity";
import { useChatById } from "@/lib/epic-selectors";
import { SYSTEM_ACTOR_ID } from "@/lib/identity/person-identity";
import { chatStarterPerson, startedByText } from "@/lib/identity/started-by";

/**
 * "Started by <name>" at the head of a chat, with the person's picture, as
 * board C15 draws it. No line when nothing says who started the chat or no
 * person did.
 */
export function ChatStartedByLine(props: {
  readonly epicId: string;
  readonly chatId: string;
}): ReactNode {
  const ownerUserId = useChatById(props.chatId)?.userId ?? null;
  const starter = chatStarterPerson(
    useEpicChatStarter(props.epicId, ownerUserId, props.chatId),
  );
  const identity = usePersonIdentity(starter ?? SYSTEM_ACTOR_ID);
  if (starter === null) return null;
  const name = identity?.displayName ?? starter;
  return (
    <div
      data-testid={`chat-started-by-${props.chatId}`}
      className="flex min-w-0 shrink-0 items-center gap-1.5 px-3.5 py-1.5 text-ui-xs text-muted-foreground"
    >
      <PersonAvatar
        userId={starter}
        name={name}
        avatarUrl={identity?.avatarUrl ?? null}
        size="xs"
      />
      <span className="truncate">
        {startedByText(starter, identity?.displayName ?? null)}
      </span>
    </div>
  );
}

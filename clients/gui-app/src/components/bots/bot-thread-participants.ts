import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import type { StackedIdentity } from "@/components/bots/bot-avatars";
import {
  botMemberAvatarUrl,
  botMemberName,
  type BotMemberResolver,
} from "@/lib/bots/bot-member-names";
import type { AuthProfile } from "@/stores/auth/auth-store";

/** Reply authors supplied by the host; older summaries identify nobody. */
export function threadParticipants(
  thread: BotThreadSummary,
  viewer: AuthProfile | null,
  resolveMember: BotMemberResolver,
): ReadonlyArray<StackedIdentity> {
  return (thread.replyParticipants ?? []).map((participant) =>
    participant.kind === "bot"
      ? participant
      : {
          kind: "person",
          userId: participant.userId,
          name: botMemberName(participant.userId, viewer, resolveMember),
          avatarUrl: botMemberAvatarUrl(
            participant.userId,
            viewer,
            resolveMember,
          ),
        },
  );
}

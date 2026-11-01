import { useMemo } from "react";
import {
  attentionPromptsOf,
  replyRefsOf,
  type AttentionPrompts,
  type ReplyRef,
} from "@/lib/voice/queue-sources";
import { useMergedNotificationRows } from "@/stores/notifications/merged-notifications";

/** What the attention tier holds for the voice: unread bot replies and the prompts that wait. */
export interface VoiceAttention {
  readonly answers: ReadonlyArray<ReplyRef>;
  readonly prompts: AttentionPrompts;
}

/**
 * The voice's reading of the attention tier (Tracy Bots voice, VT4): the
 * merged notification rows the bell lists, reduced to ids and counts. The
 * queue hydrates each reply from the records; nothing of the rows' copy is
 * kept.
 */
export function useVoiceAttention(): VoiceAttention {
  const rows = useMergedNotificationRows();
  return useMemo(
    () => ({ answers: replyRefsOf(rows), prompts: attentionPromptsOf(rows) }),
    [rows],
  );
}

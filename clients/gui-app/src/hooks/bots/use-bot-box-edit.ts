import { useCallback, useState } from "react";
import type { BotComposerEdit } from "@/components/bots/bot-message-composer";
import {
  type BotActivity,
  type BotSessionActivity,
} from "@/hooks/bots/use-bot-activity";

/**
 * A box keeps its edit through missing activity and session/list reloads.
 * Only the session that failed the edited request can positively resume it.
 */
export function useBotBoxEdit(
  activity: BotActivity | null,
  conversationKey: string | null,
): {
  readonly edit: BotComposerEdit | null;
  readonly setEdit: (edit: BotComposerEdit | null) => void;
  readonly endEdit: () => void;
} {
  const [held, setHeld] = useState<BotComposerEdit | null>(null);
  const [heldKey, setHeldKey] = useState(conversationKey);
  const setEdit = useCallback(
    (edit: BotComposerEdit | null): void => {
      if (edit === null) {
        setHeld(null);
        return;
      }
      // A restored send keeps its original session through missing activity.
      // A new edit can also find a request that has already resumed.
      let threadId = edit.sessionThreadId;
      if (threadId === undefined) {
        threadId =
          activity?.trunk?.requestId === edit.requestId
            ? null
            : Object.entries(activity?.threads ?? {}).find(
                ([, session]) => session.requestId === edit.requestId,
              )?.[0];
      }
      setHeld({ ...edit, sessionThreadId: threadId });
    },
    [activity],
  );
  const endEdit = useCallback(() => setHeld(null), []);
  let session: BotSessionActivity | null | undefined = null;
  if (held?.sessionThreadId === null) session = activity?.trunk;
  else if (held?.sessionThreadId !== undefined)
    session = activity?.threads[held.sessionThreadId];
  if (
    conversationKey !== heldKey ||
    (held !== null &&
      session?.state === "replying" &&
      session.requestId === held.requestId)
  ) {
    setHeldKey(conversationKey);
    setHeld(null);
  }
  return { edit: held, setEdit, endEdit };
}

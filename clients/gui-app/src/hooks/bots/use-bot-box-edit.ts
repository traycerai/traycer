import { useCallback, useState } from "react";
import type { BotComposerEdit } from "@/components/bots/bot-message-composer";
import {
  type BotActivity,
  type BotSessionActivity,
} from "@/hooks/bots/use-bot-activity";

type HeldEdit = {
  readonly edit: BotComposerEdit;
  // null names the trunk; undefined means no matching session was observed.
  readonly threadId: string | null | undefined;
};

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
  const [held, setHeld] = useState<HeldEdit | null>(null);
  const [heldKey, setHeldKey] = useState(conversationKey);
  const setEdit = useCallback(
    (edit: BotComposerEdit | null): void => {
      if (edit === null) {
        setHeld(null);
        return;
      }
      // A failed send can be restored after the request has already resumed.
      // Capture that replying session too; the render below retires the edit.
      const threadId =
        activity?.trunk?.requestId === edit.requestId
          ? null
          : Object.entries(activity?.threads ?? {}).find(
              ([, session]) => session.requestId === edit.requestId,
            )?.[0];
      setHeld({ edit, threadId });
    },
    [activity],
  );
  const endEdit = useCallback(() => setHeld(null), []);
  let session: BotSessionActivity | null | undefined = null;
  if (held?.threadId === null) session = activity?.trunk;
  else if (held?.threadId !== undefined)
    session = activity?.threads[held.threadId];
  if (
    conversationKey !== heldKey ||
    (held !== null &&
      session?.state === "replying" &&
      session.requestId === held.edit.requestId)
  ) {
    setHeldKey(conversationKey);
    setHeld(null);
  }
  return { edit: held?.edit ?? null, setEdit, endEdit };
}

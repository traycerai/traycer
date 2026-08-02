import { Button } from "@/components/ui/button";
import { useAppDialogStore } from "@/stores/dialogs/app-dialog-store";
import { useChatForkEventQuery } from "@/hooks/chats/use-chat-fork-queries";

/**
 * Persistent, app-wide entry point into ticket 09's fork dialog.
 *
 * Ruling 3 (decision log, "Fork-resolution prompt"): dismissing the dialog
 * must not make the halted chats disappear from view - "a halted chat must
 * never sit unsynced with nothing saying why." This banner is driven by the
 * same `host.chatFork.get` query the dialog reads, so it renders exactly
 * whenever the host holds an open episode, independent of whether the
 * dialog was ever opened or dismissed.
 *
 * A GLOBAL banner rather than a per-chat sidebar badge: the settled UX calls
 * for the affected chat to carry the indicator, and integrating into the
 * existing per-chat indicator rollup (`epic-sidebar-chat-tree.tsx`'s
 * `NotificationIndicatorState`) is the more precise fit. Deferred to a
 * follow-up rather than a rushed edit to that file under this ticket's time
 * budget - see the implementation report. This banner is a correct interim:
 * it is never fully silent, and clicking it opens the exact same dialog a
 * per-chat badge would.
 */
export function ChatForkIndicatorBanner() {
  const openDialog = useAppDialogStore((state) => state.openDialog);
  const eventQuery = useChatForkEventQuery();
  const event = eventQuery.data?.event ?? null;
  if (event === null) return null;

  return (
    <div className="flex items-center justify-between gap-3 border-b bg-amber-500/10 px-4 py-2 text-sm">
      <span>
        {event.chats.length} chat{event.chats.length === 1 ? "" : "s"}{" "}
        stopped publishing and need{event.chats.length === 1 ? "s" : ""} a
        decision.
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => openDialog("chat-fork")}
      >
        Review
      </Button>
    </div>
  );
}

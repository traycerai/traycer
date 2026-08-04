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
 * The per-chat sidebar indicator is now the precise primary surface. This
 * banner remains as the secondary app-wide safety net: it stays visible when
 * the affected epic is closed, filtered, or collapsed, and it also preserves
 * ticket 09's degrade path while connected to an older host that cannot send
 * the additive `pendingFork` indicator bit. Both surfaces open the same dialog
 * and read the same host-owned episode.
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

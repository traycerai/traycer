import { AppWindow, X } from "lucide-react";
import {
  discardAppMessageDraft,
  useAppMessageDraftName,
} from "@/stores/composer/app-message-draft-store";

/**
 * McpApp state 4: the composer holds a message an app asked to send. The
 * reader sends it like any draft, or Discard puts the draft back as it was.
 * Same shape as `QueueEditDraftPill`.
 */
export function AppMessageDraftPill(props: { readonly chatId: string }) {
  const appName = useAppMessageDraftName(props.chatId);
  if (appName === null) return null;
  return (
    <div
      className="inline-flex max-w-full items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-ui-xs text-foreground"
      data-testid="app-message-draft-pill"
    >
      <AppWindow className="size-3.5 shrink-0 text-primary" aria-hidden />
      <span className="min-w-0 truncate font-medium">
        From the <bdi>{appName}</bdi> app
      </span>
      <button
        type="button"
        className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-primary/15 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`Discard the message from the ${appName} app`}
        onClick={() => discardAppMessageDraft(props.chatId)}
      >
        <X className="size-3" aria-hidden />
        <span>Discard</span>
      </button>
    </div>
  );
}

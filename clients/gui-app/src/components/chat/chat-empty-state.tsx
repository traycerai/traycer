import { EPIC_NODE_ICONS } from "@/lib/artifacts/node-display";

export function ChatEmptyState() {
  const ChatIcon = EPIC_NODE_ICONS.chat;

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="flex size-10 items-center justify-center rounded-lg border border-border/40 bg-muted/15 text-muted-foreground/45">
        <ChatIcon className="size-4" aria-hidden />
      </div>
      <div className="space-y-1">
        <p className="text-ui-sm font-medium text-muted-foreground/60">
          Start the conversation
        </p>
        <p className="text-ui-sm leading-6 text-muted-foreground/50">
          Send a message to get started.
        </p>
      </div>
    </div>
  );
}

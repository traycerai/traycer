import type { ReactNode } from "react";
import { sandboxDestroyedLine } from "@/lib/sandboxes/sandbox-row-lines";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEndedSandboxHost } from "@/stores/sandboxes/ended-sandbox-hosts-store";

/**
 * The line a chat shows once a member destroyed the sandbox it ran on: who
 * and when, in place of a fault. Nothing for any other host.
 */
export function ChatSandboxDestroyedLine(props: {
  readonly hostId: string | null;
}): ReactNode {
  const ended = useEndedSandboxHost(props.hostId);
  const viewerUserId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  if (ended === null) return null;
  return (
    <p
      className="shrink-0 border-b border-border/60 px-4 py-2 text-ui-sm text-muted-foreground"
      data-testid="chat-sandbox-destroyed"
    >
      {sandboxDestroyedLine(ended, viewerUserId)}
    </p>
  );
}

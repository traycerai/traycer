import { useCallback, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useRefreshSpinner } from "@/hooks/use-refresh-spinner";
import { cn } from "@/lib/utils";
import type { ChatRuntimeAvailability } from "./chat-tile-types";

// The gate hook + availability mapping live in `use-chat-runtime-gate.ts`;
// this file holds only the display components so Fast Refresh stays intact.
const CHAT_RUNTIME_RETRY_TIMEOUT_MS = 10_000;

export function ChatTileLoading(): ReactNode {
  return (
    <div
      data-testid="chat-tile-loading"
      className="flex w-full flex-1 items-center justify-center px-6 py-8"
    >
      <MutedAgentSpinner />
    </div>
  );
}

/**
 * Shown when the host terminates `chat.subscribe` with a fatal error before
 * any snapshot - the chat will never load on this attempt, so we surface the
 * reason and a retry instead of spinning forever. The wire collapses
 * CHAT_INVALID / CHAT_NOT_VISIBLE / etc. into one UNAUTHORIZED code; the
 * human-readable `reason` carries the real cause, so we drop the redundant
 * `CODE: ` prefix for display.
 */
export function ChatTileError(props: {
  readonly details: { readonly reason: string };
  readonly onRetry: () => void;
}): ReactNode {
  const detail = props.details.reason.replace(/^[A-Z_]+:\s*/, "");
  return (
    <div
      data-testid="chat-tile-error"
      className="flex w-full flex-1 items-center justify-center px-6 py-8"
    >
      <div className="flex w-full max-w-md flex-col items-center gap-3 rounded-md border border-canvas-border/70 bg-canvas p-4 text-center">
        <div className="flex items-center gap-2 text-ui-sm font-medium text-foreground">
          <AlertTriangle className="size-4 text-destructive" aria-hidden />
          <span>This chat could not be opened.</span>
        </div>
        <p className="text-ui-sm text-muted-foreground">{detail}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={props.onRetry}
        >
          Retry
        </Button>
      </div>
    </div>
  );
}

export function ChatRuntimeConfigurationBlock(props: {
  readonly availability: Exclude<
    ChatRuntimeAvailability,
    { readonly kind: "available" }
  >;
  readonly retrying: boolean;
  readonly onRetry: () => Promise<unknown>;
}): ReactNode {
  const { availability, onRetry, retrying } = props;
  const retryRuntime = useCallback(async () => {
    await onRetry();
  }, [onRetry]);
  const retry = useRefreshSpinner({
    onRefresh: retryRuntime,
    externalRefreshing: retrying,
    timeoutMs: CHAT_RUNTIME_RETRY_TIMEOUT_MS,
  });

  if (availability.kind === "loading") {
    return (
      <div
        data-testid="chat-runtime-config-block"
        className="flex w-full flex-1 items-center justify-center px-6 py-8"
      >
        <div className="flex items-center gap-2 text-ui-sm text-muted-foreground">
          <MutedAgentSpinner />
          <span>Loading chat</span>
        </div>
      </div>
    );
  }

  const detail =
    availability.kind === "error"
      ? availability.message
      : "The host could not load the required chat.";

  return (
    <div
      data-testid="chat-runtime-config-block"
      className="flex w-full flex-1 items-center justify-center px-6 py-8"
    >
      <div className="flex w-full max-w-md flex-col items-center gap-3 rounded-md border border-canvas-border/70 bg-canvas p-4 text-center">
        <div className="flex items-center gap-2 text-ui-sm font-medium text-foreground">
          <AlertTriangle className="size-4 text-destructive" aria-hidden />
          <span>Chat could not be loaded.</span>
        </div>
        <p className="text-ui-sm text-muted-foreground">{detail}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={retry.refreshing}
          onClick={retry.trigger}
        >
          <RefreshCw
            className={cn("size-3.5", retry.refreshing && "animate-spin")}
            aria-hidden
          />
          Retry
        </Button>
      </div>
    </div>
  );
}

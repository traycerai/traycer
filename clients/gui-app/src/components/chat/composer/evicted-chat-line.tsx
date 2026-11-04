import type { MouseEvent, ReactNode } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useEpicSessionHostId } from "@/hooks/epic/use-epic-session-host-id";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import type { EvictedChatLineKind } from "@/hooks/chats/use-evicted-chat-send";
import { modifiersFromMouseEvent } from "@/lib/canvas/tile-open/intent";
import { useEpicLiveArtifactTitle } from "@/lib/epic-selectors";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import {
  makePublishedChatTileRef,
  PUBLISHED_CHAT_TILE_FALLBACK_NAME,
} from "@/stores/epics/canvas/tile-schema/published-chat-tile";

export const EVICTED_CHAT_HYDRATING_LINE =
  "Bringing this chat back to this computer…";
export const EVICTED_CHAT_UNREACHABLE_LINE =
  "This chat is stored in the cloud. Reconnect to continue it.";
export const EVICTED_CHAT_HEAD_MOVED_LINE =
  "This chat was continued elsewhere.";
export const EVICTED_CHAT_OPEN_LATEST = "Open the latest copy.";

/**
 * Above a chat's composer while its host brings back a chat it dropped the
 * records of, or after it could not (`useEvictedChatSend`). Nothing when
 * `line` is `null`.
 */
export function EvictedChatLine(props: {
  readonly line: EvictedChatLineKind | null;
  readonly epicId: string;
  readonly chatId: string;
  /** The chat's own host: the tab's host. */
  readonly ownerHostId: string;
  /** The chat's owner, from its record; `null` until the record is read. */
  readonly ownerUserId: string | null;
  readonly tabId: string;
}): ReactNode {
  if (props.line === "hydrating") {
    return (
      <p
        role="status"
        className="mb-2 flex min-w-0 items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-ui-sm text-foreground"
        data-testid="evicted-chat-hydrating"
      >
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
        <span className="min-w-0">{EVICTED_CHAT_HYDRATING_LINE}</span>
      </p>
    );
  }
  if (props.line === "unreachable") {
    return (
      <p
        role="status"
        className="mb-2 min-w-0 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-ui-sm text-warning-foreground"
        data-testid="evicted-chat-unreachable"
      >
        {EVICTED_CHAT_UNREACHABLE_LINE}
      </p>
    );
  }
  if (props.line === "head-moved") {
    return (
      <EvictedChatHeadMovedLine
        epicId={props.epicId}
        chatId={props.chatId}
        ownerHostId={props.ownerHostId}
        ownerUserId={props.ownerUserId}
        tabId={props.tabId}
      />
    );
  }
  return null;
}

function EvictedChatHeadMovedLine(props: {
  readonly epicId: string;
  readonly chatId: string;
  readonly ownerHostId: string;
  readonly ownerUserId: string | null;
  readonly tabId: string;
}): ReactNode {
  const { openTile } = useEpicTileNavigation();
  const { ownerUserId } = props;
  const title = useEpicLiveArtifactTitle(props.chatId);
  const readingHostId = useEpicSessionHostId() ?? UNKNOWN_HOST_PLACEHOLDER;
  const open = (event: MouseEvent<HTMLButtonElement>): void => {
    if (ownerUserId === null) return;
    openTile({
      node: makePublishedChatTileRef({
        taskId: props.epicId,
        chatId: props.chatId,
        ownerUserId,
        ownerHostId: props.ownerHostId,
        name: title ?? PUBLISHED_CHAT_TILE_FALLBACK_NAME,
        hostId: readingHostId,
      }),
      target: { tabId: props.tabId },
      gesture: "single",
      modifiers: modifiersFromMouseEvent(event),
      placement: null,
      dedupe: true,
      source: "direct_ui",
    });
  };
  return (
    <p
      role="status"
      className="mb-2 flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1 rounded-md border border-border/60 px-3 py-2 text-ui-sm text-foreground"
      data-testid="evicted-chat-head-moved"
    >
      <span className="min-w-0">{EVICTED_CHAT_HEAD_MOVED_LINE}</span>
      <Button
        type="button"
        variant="link"
        size="inline"
        disabled={ownerUserId === null}
        data-testid="evicted-chat-open-latest"
        onClick={open}
      >
        {EVICTED_CHAT_OPEN_LATEST}
      </Button>
    </p>
  );
}

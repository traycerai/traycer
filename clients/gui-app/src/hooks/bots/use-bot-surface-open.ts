import type { EpicArtifactKind } from "@traycer/protocol/common/registry";
import { useTracyTranscriptOrigin } from "@/components/bots/tracy-transcript-origin-context";
import { activateTabIntent, resourceEpicTabIntent } from "@/lib/tab-navigation";
import { fromTracyTranscript } from "@/lib/tab-navigation/intents";
import {
  artifactReadIsCurrent,
  type ArtifactReadLifetime,
} from "@/lib/artifacts/artifact-read-lifetime";
import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { v4 as uuidv4 } from "uuid";
import type { BotSurfaceReference } from "@traycer/protocol/persistence/epic/messages";
import type { BotInputNeeded } from "@traycer/protocol/host/bot/schemas";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { tileIntent } from "@/lib/canvas/tile-open/intent";
import { routeNotificationForHost } from "@/lib/notifications/payload";
import {
  useChatTranscriptJumpStore,
  type ChatTranscriptJumpTarget,
} from "@/stores/chats/chat-transcript-jump-store";
import { makeBrowserSessionTileRef } from "@/stores/epics/canvas/tile-schema/browser-tile";
import { makeOpenableNodeRef } from "@/stores/epics/canvas/types";

/**
 * Open on a bot's surface card: where a notification of the
 * same surface opens it - the question's block or the approval's row in the
 * task's chat on its machine, the browser tile on its machine - and the
 * artifact uses the separate admitted-target action below. Like Home's focus
 * actions it compares the surface's machine with the window's effective
 * host, the host a hostless task tab opens on: a question or an approval on
 * another machine opens a chat tile bound to that machine in the task's tab
 * (the tab keeps its own host), and lands on the block or the row there; a
 * parked page opens its browser tile on its machine the same way, or with no
 * page known, the chat that parked it on its machine.
 * `title` names a tile opened fresh until the chat's own name arrives.
 */
export function useBotSurfaceOpen(
  surface: Exclude<BotSurfaceReference, { kind: "artifact" }>,
  open: BotInputNeeded | null,
  title: string,
): () => void {
  const navigate = useNavigate();
  const effectiveHostId = useEffectiveHostId();
  const { openTile } = useEpicTileNavigation();
  const requestJump = useChatTranscriptJumpStore((state) => state.requestJump);
  const elsewhere =
    effectiveHostId !== null && surface.hostId !== effectiveHostId;
  /** The chat's tile bound to the surface's machine, in the task's tab. */
  const openChatThere = (chatId: string): void => {
    openTile(
      tileIntent(
        makeOpenableNodeRef({
          id: chatId,
          instanceId: uuidv4(),
          type: "chat",
          name: title,
          hostId: surface.hostId,
        }),
        { epicId: surface.epicId },
        "explicit",
        "direct_ui",
      ),
      "user",
    );
  };
  return () => {
    const context = { originHostId: surface.hostId, effectiveHostId };
    const now = Date.now();
    const gate = gateOf(surface);
    if (gate !== null && elsewhere) {
      openChatThere(gate.chatId);
      requestJump(surface.hostId, gate.chatId, gate.target);
      return;
    }
    switch (surface.kind) {
      case "question":
        routeNotificationForHost(
          navigate,
          {
            kind: "interview",
            epicId: surface.epicId,
            chatId: surface.chatId,
            interviewBlockId: surface.blockId,
          },
          now,
          context,
        );
        return;
      case "approval":
        routeNotificationForHost(
          navigate,
          {
            kind: "approval",
            epicId: surface.epicId,
            chatId: surface.chatId,
            approvalId: surface.approvalId,
            sessionId: undefined,
            artifactId: undefined,
          },
          now,
          context,
        );
        return;
      case "browser": {
        const tabId = browserTabOf(surface, open);
        if (tabId === null && elsewhere && surface.chatId !== null) {
          openChatThere(surface.chatId);
          return;
        }
        if (tabId === null) {
          routeNotificationForHost(
            navigate,
            { kind: "epic", epicId: surface.epicId },
            now,
            context,
          );
          return;
        }
        openTile(
          tileIntent(
            makeBrowserSessionTileRef({
              hostId: surface.hostId,
              sessionId: surface.sessionId,
              tabId,
            }),
            { epicId: surface.epicId },
            "explicit",
            "direct_ui",
          ),
          "user",
        );
        return;
      }
    }
  };
}

/** The parked page's tab: the post's, else the open park's; `null` when neither says. */
function browserTabOf(
  surface: Extract<BotSurfaceReference, { kind: "browser" }>,
  open: BotInputNeeded | null,
): string | null {
  if (surface.tabId !== null) return surface.tabId;
  return open?.surface.kind === "browser" ? open.surface.tabId : null;
}

/** A question's block or an approval's row, in its chat; `null` for any other surface. */
function gateOf(surface: BotSurfaceReference): {
  readonly chatId: string;
  readonly target: ChatTranscriptJumpTarget;
} | null {
  switch (surface.kind) {
    case "question":
      return {
        chatId: surface.chatId,
        target: { kind: "block", blockId: surface.blockId },
      };
    case "approval":
      return {
        chatId: surface.chatId,
        target: { kind: "approval", approvalId: surface.approvalId },
      };
    case "browser":
    case "artifact":
      return null;
  }
}

export interface BotArtifactOpenTarget {
  readonly hostId: string;
  readonly epicId: string;
  readonly artifactId: string;
  readonly title: string;
  readonly kind: EpicArtifactKind;
  readonly lifetime: ArtifactReadLifetime;
}

/** The admitted tile on its serving host, with a return to this Tracy transcript. */
export function useBotArtifactOpen(
  target: BotArtifactOpenTarget | null,
): (() => void) | null {
  const navigate = useNavigate();
  const origin = useTracyTranscriptOrigin();
  const open = useCallback(() => {
    if (
      target === null ||
      origin === null ||
      !artifactReadIsCurrent(target.lifetime)
    )
      return;
    activateTabIntent(
      navigate,
      fromTracyTranscript(
        resourceEpicTabIntent({
          epicId: target.epicId,
          tabId: null,
          name: undefined,
          focus: {
            focusedAt: undefined,
            focusArtifactId: target.artifactId,
            focusThreadId: undefined,
            migrationSource: undefined,
          },
          preparation: {
            kind: "open-tile",
            node: {
              id: target.artifactId,
              instanceId: uuidv4(),
              type: target.kind,
              name: target.title,
              hostId: target.hostId,
            },
            gesture: "explicit",
          },
          includeNestedFocus: true,
        }),
        origin,
      ),
      undefined,
    );
  }, [navigate, origin, target]);
  return target === null || origin === null ? null : open;
}

import { use } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { v4 as uuidv4 } from "uuid";
import type { BotSurfaceReference } from "@traycer/protocol/persistence/epic/messages";
import type { BotInputNeeded } from "@traycer/protocol/host/bot/schemas";
import { artifactLinkPathRootAgnostic } from "@traycer/protocol/common/artifact-path";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { tileIntent } from "@/lib/canvas/tile-open/intent";
import { routeNotificationForHost } from "@/lib/notifications/payload";
import { MarkdownLinkContext } from "@/markdown/links/markdown-link-context";
import {
  useChatTranscriptJumpStore,
  type ChatTranscriptJumpTarget,
} from "@/stores/chats/chat-transcript-jump-store";
import { makeBrowserSessionTileRef } from "@/stores/epics/canvas/tile-schema/browser-tile";
import { makeOpenableNodeRef } from "@/stores/epics/canvas/types";

/**
 * Open on a bot's surface card (Tracy Bots T89): where a notification of the
 * same surface opens it - the question's block or the approval's row in the
 * task's chat on its machine, the browser tile on its machine - and the
 * artifact in its task through the channel's link policy. Like Home's focus
 * actions it compares the surface's machine with the window's effective
 * host, the host a hostless task tab opens on: a question or an approval on
 * another machine opens a chat tile bound to that machine in the task's tab
 * (the tab keeps its own host), and lands on the block or the row there; a
 * parked page opens its browser tile on its machine the same way.
 * `title` names a tile opened fresh until the chat's own name arrives.
 */
export function useBotSurfaceOpen(
  surface: BotSurfaceReference,
  open: BotInputNeeded | null,
  title: string,
): () => void {
  const navigate = useNavigate();
  const effectiveHostId = useEffectiveHostId();
  const { openTile } = useEpicTileNavigation();
  const requestJump = useChatTranscriptJumpStore((state) => state.requestJump);
  const linkPolicy = use(MarkdownLinkContext);
  return () => {
    const context = { originHostId: surface.hostId, effectiveHostId };
    const now = Date.now();
    const gate = gateOf(surface);
    if (
      gate !== null &&
      effectiveHostId !== null &&
      surface.hostId !== effectiveHostId
    ) {
      openTile(
        tileIntent(
          makeOpenableNodeRef({
            id: gate.chatId,
            instanceId: uuidv4(),
            type: "chat",
            name: title,
            hostId: surface.hostId,
          }),
          { epicId: surface.epicId },
          "explicit",
          "direct_ui",
        ),
      );
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
        const tabId =
          surface.tabId ??
          (open?.surface.kind === "browser" ? open.surface.tabId : null);
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
        );
        return;
      }
      case "artifact": {
        const opened =
          linkPolicy?.openFileLink({
            path: artifactLinkPath(surface.epicId, surface.artifactPath),
            line: null,
            col: null,
            isDirectory: false,
          }) ?? false;
        if (!opened) toast("Couldn't open link");
        return;
      }
    }
  };
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

/** The artifact's path as a link to it names it, inside its task's artifacts. */
function artifactLinkPath(epicId: string, artifactPath: string): string {
  if (artifactLinkPathRootAgnostic(artifactPath, epicId) !== null) {
    return artifactPath;
  }
  return `epics/${epicId}/artifacts/${artifactPath.replace(/^[\\/]+/u, "")}`;
}

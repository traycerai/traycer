import { use } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import type { BotSurfaceReference } from "@traycer/protocol/persistence/epic/messages";
import type { BotInputNeeded } from "@traycer/protocol/host/bot/schemas";
import { artifactLinkPathRootAgnostic } from "@traycer/protocol/common/artifact-path";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { routeNotificationForHost } from "@/lib/notifications/payload";
import { MarkdownLinkContext } from "@/markdown/links/markdown-link-context";

/**
 * Open on a bot's surface card (Tracy Bots T89): where a notification of the
 * same surface opens it - the question's block or the approval's row in the
 * task's chat on its machine, the browser tile on its machine - and the
 * artifact in its task through the channel's link policy. Like Home's focus
 * actions it compares the surface's machine with the window's effective
 * host, the host a hostless task tab opens on.
 */
export function useBotSurfaceOpen(
  surface: BotSurfaceReference,
  open: BotInputNeeded | null,
): () => void {
  const navigate = useNavigate();
  const effectiveHostId = useEffectiveHostId();
  const linkPolicy = use(MarkdownLinkContext);
  return () => {
    const context = { originHostId: surface.hostId, effectiveHostId };
    const now = Date.now();
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
        routeNotificationForHost(
          navigate,
          tabId === null
            ? { kind: "epic", epicId: surface.epicId }
            : {
                kind: "browserSession",
                epicId: surface.epicId,
                sessionId: surface.sessionId,
                tabId,
              },
          now,
          context,
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

/** The artifact's path as a link to it names it, inside its task's artifacts. */
function artifactLinkPath(epicId: string, artifactPath: string): string {
  if (artifactLinkPathRootAgnostic(artifactPath, epicId) !== null) {
    return artifactPath;
  }
  return `epics/${epicId}/artifacts/${artifactPath.replace(/^[\\/]+/u, "")}`;
}

import { useCallback, useMemo } from "react";
import type { TaskHostPrincipal } from "@traycer/protocol/host/task-host-summary";
import type { ComposerHostNoticeState } from "@/components/home/composer/composer-host-notice";
import {
  composerMirrorLineText,
  mirrorLineOtherHostName,
  type ComposerMirrorLine,
} from "@/components/home/composer/composer-mirror-line-model";
import { useRegisteredHosts } from "@/hooks/auth/use-registered-hosts-query";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useTaskHostGroups } from "@/hooks/epic/use-task-host-groups";
import { useTaskHostsView } from "@/hooks/epic/use-task-hosts-view";
import {
  composerMirrorLineSeen,
  useComposerMirrorLineSeenStore,
} from "@/stores/epics/composer-mirror-line-seen-store";

/**
 * The mirror line: starting an agent on a host whose owner differs from a host
 * already working in the task says, once per task, that the two cannot work
 * with each other. Owners come from the task's host rows, and the other host
 * is named as the Hosts section names it; a start host that is not one of them
 * yet is its registry owner's when that is a team, and otherwise the person's
 * own.
 */
export function useComposerMirrorLine(
  epicId: string,
  resolvedHostId: string | null,
): ComposerMirrorLine {
  const view = useTaskHostsView(epicId);
  const viewerUserId = useCloudChatViewerId();
  const registry = useRegisteredHosts().data ?? null;
  const seen = useComposerMirrorLineSeenStore((s) => s.seen);
  const markSeenFor = useComposerMirrorLineSeenStore((s) => s.markSeen);
  const hosts = view.kind === "hosts" ? view.hosts : null;
  const groups = useTaskHostGroups(epicId, hosts);
  const name = useMemo(() => {
    if (hosts === null || resolvedHostId === null) return null;
    if (viewerUserId.length === 0) return null;
    const owner =
      registry?.hosts.find((item) => item.hostId === resolvedHostId)?.owner ??
      null;
    const fallback: TaskHostPrincipal =
      owner !== null && owner.kind === "team"
        ? { kind: "team", id: owner.id }
        : { kind: "user", id: viewerUserId };
    return mirrorLineOtherHostName({
      groups,
      hosts,
      startHostId: resolvedHostId,
      startPrincipalFallback: fallback,
    });
  }, [groups, hosts, registry, resolvedHostId, viewerUserId]);
  const alreadySeen = composerMirrorLineSeen(seen, viewerUserId, epicId);
  const notice = useMemo<ComposerHostNoticeState | null>(
    () =>
      name === null || alreadySeen
        ? null
        : { kind: "mirror", message: composerMirrorLineText(name) },
    [alreadySeen, name],
  );
  const markSeen = useCallback((): void => {
    if (viewerUserId.length === 0) return;
    markSeenFor(viewerUserId, epicId);
  }, [epicId, markSeenFor, viewerUserId]);
  return { notice, markSeen };
}

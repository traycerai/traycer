import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  useCloudChatHasCloudAuthorization,
  useCloudChatViewerId,
} from "@/hooks/chats/use-cloud-chat-queries";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import {
  useEpicCollaboratorsQuery,
  type UseEpicCollaboratorsQueryResult,
} from "@/hooks/epics/use-epic-collaborators-query";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";
import {
  teamHostDisclosureSeen,
  useTeamHostDisclosureSeenStore,
} from "@/stores/hosts/team-host-disclosure-seen-store";
import {
  taskHasReadersOutsideTeam,
  teamHostDisclosureSentences,
  teamHostOutsideReadersLine,
} from "./team-host-disclosure-model";

/**
 * The first tab a person opens on a team host: what running there means, once
 * per person per host, until they dismiss it. When the task has readers
 * outside the team it says so too. Laid over the top of the tile rather than
 * above it, so showing or dismissing it never resizes or remounts the tile's
 * body.
 */
export function TeamHostDisclosure(props: {
  readonly hostId: string;
  readonly teamId: string;
  readonly teamName: string;
}): ReactNode {
  const viewerUserId = useCloudChatViewerId();
  const seen = useTeamHostDisclosureSeenStore((s) => s.seen);
  const markSeen = useTeamHostDisclosureSeenStore((s) => s.markSeen);
  // The frame wraps tiles outside an epic session too; there is no task
  // there, so no readers to name.
  const epicId = useMaybeOpenEpicHandle()?.epicId ?? "";
  const client = useEpicSessionHostClient();
  const cloudAuthorized = useCloudChatHasCloudAuthorization();
  const collaborators = useEpicCollaboratorsQuery(epicId, {
    client,
    enabled: cloudAuthorized && epicId.length > 0,
    poll: false,
    staleTime: undefined,
  });
  if (viewerUserId.length === 0) return null;
  if (teamHostDisclosureSeen(seen, viewerUserId, props.hostId)) return null;
  const outside = readersOutsideTeam({
    hasTask: epicId.length > 0,
    cloudAuthorized,
    collaborators,
    viewerUserId,
    teamId: props.teamId,
  });
  // The card waits for the reader list rather than showing first and growing
  // a line later.
  if (outside === "loading") return null;
  const sentences = teamHostDisclosureSentences(props.teamName);
  return (
    <div
      role="status"
      data-testid="team-host-disclosure"
      className="absolute inset-x-2 top-2 z-20 flex max-w-full min-w-0 items-start gap-2 rounded-md border border-border bg-popover px-3 py-2 text-ui-sm shadow-md"
    >
      <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col gap-1 text-foreground">
        {sentences.map((sentence) => (
          <p key={sentence} className="m-0">
            {sentence}
          </p>
        ))}
        {outside ? (
          <p className="m-0" data-testid="team-host-disclosure-outside">
            {teamHostOutsideReadersLine(props.teamName)}
          </p>
        ) : null}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="shrink-0"
        data-testid="team-host-disclosure-dismiss"
        onClick={() => markSeen(viewerUserId, props.hostId)}
      >
        Got it
      </Button>
    </div>
  );
}

/**
 * Whether the open task has readers outside the team. A list the person
 * cannot read (no cloud authorization, or the read failed or never ran) is
 * not "nobody outside": it counts as outside readers.
 */
function readersOutsideTeam(input: {
  readonly hasTask: boolean;
  readonly cloudAuthorized: boolean;
  readonly collaborators: UseEpicCollaboratorsQueryResult;
  readonly viewerUserId: string;
  readonly teamId: string;
}): boolean | "loading" {
  if (!input.hasTask) return false;
  if (!input.cloudAuthorized || input.collaborators.isError) return true;
  const data = input.collaborators.data;
  if (data !== undefined) {
    return taskHasReadersOutsideTeam({
      viewerUserId: input.viewerUserId,
      teamId: input.teamId,
      collaborators: data,
    });
  }
  return input.collaborators.isLoading ? "loading" : true;
}

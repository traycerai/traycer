import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import {
  useEpicLaneCommentThreads,
  useEpicLaneCommentThreadsDroppedAt,
} from "@/hooks/comments/use-lane-comment-threads";
import { revealCommentThreadAnchor } from "@/lib/comments/comment-editor-registry";
import { useEpicArtifact } from "@/lib/epic-selectors";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useArtifactAnchorPositions } from "@/stores/comments/anchor-positions-store";
import { useCommentThreadsStore } from "@/stores/comments/comment-threads-store";
import { CommentSidebar } from "./comment-sidebar";

export interface CommentSidebarPanelProps {
  readonly epicId: string;
  readonly activeArtifactId: string;
}

/**
 * The comments body with its data wiring attached: the artifact record and its
 * kind, the Epic session's host client, the live anchor positions and the
 * signed-in user. `CommentSidebar` itself takes all of that as props so it stays
 * mountable anywhere; this is the one place that resolves it, so the desktop
 * left panel and the mobile switcher sheet mount the same surface with the same
 * host scope rather than two wirings that can drift.
 */
export function CommentSidebarPanel(props: CommentSidebarPanelProps) {
  const { epicId, activeArtifactId } = props;
  const artifactRecord = useEpicArtifact(activeArtifactId);
  // The sidebar is a sibling of the canvas, deliberately outside every
  // `<TabHostProvider>`, so its host is the Epic SESSION's - not the app-wide
  // one, which re-points under it while this Epic keeps rendering (D15).
  const hostClient = useEpicSessionHostClient();
  // The state lane's comment records, resolved here for the same reason the
  // host client is: `CommentSidebar` reads no ambient context of its own.
  const laneThreads = useEpicLaneCommentThreads(activeArtifactId);
  // Resolved beside the rows, not inside `CommentSidebar`: the ambient reads
  // belong to this wiring layer, which is what keeps the panel mountable on
  // the mobile switcher, outside any epic session.
  const laneDroppedAt = useEpicLaneCommentThreadsDroppedAt();
  const setFlashThread = useCommentThreadsStore((s) => s.setFlashThread);
  const anchorPositions = useArtifactAnchorPositions(epicId, activeArtifactId);
  const currentUserId = useAuthStore((state) => state.profile?.userId ?? null);

  const artifactKind =
    artifactRecord !== null && "kind" in artifactRecord
      ? artifactRecord.kind
      : null;

  if (artifactRecord === null || artifactKind === null) {
    return null;
  }

  return (
    <CommentSidebar
      epicId={epicId}
      hostClient={hostClient}
      artifactType={artifactKind}
      artifactId={activeArtifactId}
      laneThreads={laneThreads}
      laneDroppedAt={laneDroppedAt}
      anchorPositions={anchorPositions}
      currentUserId={currentUserId}
      canModerate={false}
      onActivateThread={(threadId) => {
        setFlashThread(epicId, threadId);
        revealCommentThreadAnchor(epicId, activeArtifactId, threadId);
      }}
    />
  );
}

import { useMemo } from "react";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useEpicCommentRoomAvailability } from "@/lib/epic-selectors";
import { useEpicCommentThreadsForClient } from "./use-epic-comment-threads";
import {
  resolveArtifactCommentThreads,
  useEpicLaneCommentThreads,
  useEpicLaneCommentThreadsDroppedAt,
} from "./use-lane-comment-threads";

export function useFrameCommentThreads(
  epicId: string,
  artifactId: string,
  artifactType: "canvas" | "html",
) {
  const client = useTabHostClient();
  const laneThreads = useEpicLaneCommentThreads(artifactId);
  const laneDroppedAt = useEpicLaneCommentThreadsDroppedAt();
  const availability = useEpicCommentRoomAvailability();
  const query = useEpicCommentThreadsForClient({
    client,
    epicId,
    artifactId,
    artifactType,
    options: { enabled: availability.kind === "available", laneDroppedAt },
  });
  return useMemo(
    () =>
      resolveArtifactCommentThreads({
        laneThreads,
        laneDroppedAt,
        pollThreads: query.data?.threads ?? null,
        pollUpdatedAt: query.dataUpdatedAt === 0 ? null : query.dataUpdatedAt,
      }).threads,
    [laneThreads, laneDroppedAt, query.data, query.dataUpdatedAt],
  );
}

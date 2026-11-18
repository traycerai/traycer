import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useHostNegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";
import { useEpicCommentRoomAvailability } from "@/lib/epic-selectors";

export function useFrameCommentsEnabled(): boolean {
  const client = useTabHostClient();
  const version = useHostNegotiatedMethodVersion(
    client,
    "epic.createCommentThread",
  );
  const availability = useEpicCommentRoomAvailability();
  return (
    availability.kind === "available" &&
    version !== null &&
    version !== false &&
    version.major === 1 &&
    version.minor >= 2
  );
}

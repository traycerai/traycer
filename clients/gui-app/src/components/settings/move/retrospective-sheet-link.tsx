import type { ReactElement } from "react";
import { Button } from "@/components/ui/button";
import { useHostDirectoryEntryForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useRetrospectiveSheetStore } from "@/stores/settings/retrospective-sheet-store";

const UNNAMED = "this computer";

/**
 * Review: opens the retrospective sheet for the host the link names, the
 * same sheet the show-once opens, so whichever opens it first records it
 * shown.
 */
export function RetrospectiveSheetReview(props: {
  readonly hostId: string;
}): ReactElement {
  const { hostId } = props;
  const label = useHostDirectoryEntryForHostId(hostId)?.label.trim() ?? "";
  const openSheet = useRetrospectiveSheetStore((state) => state.openSheet);
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      className="self-start"
      data-testid="bot-announcement-review"
      onClick={() =>
        openSheet({ hostId, hostName: label.length > 0 ? label : UNNAMED })
      }
    >
      Review
    </Button>
  );
}

import { Trash2 } from "lucide-react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useDeletedArtifactsAvailable } from "@/hooks/epic/use-deleted-artifacts-available";
import { useEpicSessionHostId } from "@/hooks/epic/use-epic-session-host-id";
import { useEpicOpenDeletedArtifacts } from "./use-epic-open-deleted-artifacts";

export function DeletedArtifactsOpenMenuItem(props: {
  readonly epicId: string;
}) {
  const hostId = useEpicSessionHostId();
  const available = useDeletedArtifactsAvailable(hostId);
  const openDeletedArtifacts = useEpicOpenDeletedArtifacts(
    props.epicId,
    hostId,
  );

  if (!available) return null;
  return (
    <DropdownMenuItem
      onSelect={openDeletedArtifacts}
      data-testid="epic-sidebar-more-open-deleted-artifacts"
    >
      <Trash2 className="size-4" />
      Deleted artifacts
    </DropdownMenuItem>
  );
}

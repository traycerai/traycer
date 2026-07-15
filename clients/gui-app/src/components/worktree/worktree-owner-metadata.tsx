import { useState, type ReactElement, type ReactNode } from "react";
import type { WorktreeBindingOwnerKind } from "@traycer/protocol/host/worktree-schemas";
import { HoverPreviewCard } from "@/components/ui/hover-preview-card";
import { OwnerWorkspaceMetadataContent } from "@/components/worktree/worktree-pr-metadata";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useWorktreeOwnerMetadata } from "@/hooks/worktree/use-worktree-owner-metadata-query";

export function WorktreeOwnerMetadataTooltip(props: {
  readonly trigger: ReactElement;
  readonly hostId: string;
  readonly epicId: string;
  readonly ownerId: string;
  readonly ownerKind: WorktreeBindingOwnerKind;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const client = useHostClientForHostId(props.hostId);
  const metadata = useWorktreeOwnerMetadata({
    client,
    epicId: props.epicId,
    ownerId: props.ownerId,
    ownerKind: props.ownerKind,
    binding: undefined,
    enabled: open,
  });
  return (
    <HoverPreviewCard
      content={
        <span
          className="block w-[min(92vw,24rem)]"
          data-testid={`chat-navigator-worktree-hover-${props.ownerId}`}
        >
          <OwnerWorkspaceMetadataContent
            binding={metadata.binding}
            worktrees={metadata.worktrees}
            pending={metadata.isPending}
            error={metadata.error !== null}
          />
        </span>
      }
      side="right"
      sideOffset={4}
      align="start"
      open={open}
      onOpenChange={setOpen}
    >
      {props.trigger}
    </HoverPreviewCard>
  );
}

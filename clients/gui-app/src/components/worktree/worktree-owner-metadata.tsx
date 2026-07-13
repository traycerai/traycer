import { useState, type ReactElement, type ReactNode } from "react";
import type { WorktreeBindingOwnerKind } from "@traycer/protocol/host/worktree-schemas";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { OwnerWorkspaceMetadataContent } from "@/components/worktree/worktree-pr-metadata";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useWorktreeOwnerMetadata } from "@/hooks/worktree/use-worktree-owner-metadata-query";

export function WorktreeOwnerMetadataHoverCard(props: {
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
    <HoverCard
      open={open}
      onOpenChange={setOpen}
      openDelay={350}
      closeDelay={120}
    >
      <HoverCardTrigger asChild>{props.trigger}</HoverCardTrigger>
      <HoverCardContent
        side="right"
        align="start"
        className="w-[min(92vw,24rem)] rounded-md bg-foreground p-0 text-background"
        data-testid={`chat-navigator-worktree-hover-${props.ownerId}`}
      >
        <OwnerWorkspaceMetadataContent
          binding={metadata.binding}
          worktrees={metadata.worktrees}
          pending={metadata.isPending}
          error={metadata.error !== null}
        />
      </HoverCardContent>
    </HoverCard>
  );
}

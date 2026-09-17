import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";

import { HostRestartSessions } from "@/components/host/host-restart-sessions";

interface RestartHostConfirmDialogProps {
  readonly hostId: string | null;
  readonly open: boolean;
  readonly isPending: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: () => void;
}

export function RestartHostConfirmDialog(props: RestartHostConfirmDialogProps) {
  return (
    <ConfirmDestructiveDialog
      blockedReason={null}
      open={props.open}
      onOpenChange={props.onOpenChange}
      title="Restart host?"
      description="Restarting will stop in-progress agents, end any running terminal sessions, and cancel in-flight requests against this host."
      cascadeSummary={null}
      actionLabel="Restart host"
      isPending={props.isPending}
      onConfirm={props.onConfirm}
    >
      {props.open && props.hostId !== null ? (
        <HostRestartSessions
          hostId={props.hostId}
          disabled={props.isPending}
          onNavigate={() => props.onOpenChange(false)}
        />
      ) : null}
    </ConfirmDestructiveDialog>
  );
}

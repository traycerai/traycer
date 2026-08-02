import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";

interface RestartHostConfirmDialogProps {
  readonly open: boolean;
  readonly isPending: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: () => void;
}

export function RestartHostConfirmDialog(props: RestartHostConfirmDialogProps) {
  return (
    <ConfirmDestructiveDialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title="Restart host?"
      description="Restarting will stop in-progress agents, end any running terminal sessions, and cancel in-flight requests against this host."
      cascadeSummary={null}
      actionLabel="Restart host"
      isPending={props.isPending}
      onConfirm={props.onConfirm}
    />
  );
}

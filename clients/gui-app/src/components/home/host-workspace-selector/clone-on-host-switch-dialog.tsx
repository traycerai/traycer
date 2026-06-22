import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface CloneOnHostSwitchDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly targetHostLabel: string;
  readonly onConfirm: () => void;
}

/** Confirm dialog before cloning a chat onto a different host. */
export function CloneOnHostSwitchDialog(props: CloneOnHostSwitchDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        data-testid="clone-on-host-switch-dialog"
      >
        <DialogHeader>
          <DialogTitle>Open this chat on {props.targetHostLabel}?</DialogTitle>
          <DialogDescription>
            A new chat is created on {props.targetHostLabel}. The current chat
            stays where it is - chat tabs are bound to a host for life.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => props.onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            data-testid="clone-on-host-switch-confirm"
            onClick={props.onConfirm}
          >
            Open on new host
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

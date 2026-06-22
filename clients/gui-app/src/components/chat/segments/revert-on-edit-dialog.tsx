import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RevertArtifactsCheckbox } from "./revert-artifacts-checkbox";

interface RevertOnEditDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRevert: (revertArtifacts: boolean) => void;
  readonly onDontRevert: () => void;
  readonly artifactCount: number;
}

/**
 * Shown when the owner submits an edit to a previous message that has file
 * edits below it. Revert restores those files to before the edited message
 * (and clears later messages); Don't revert keeps the files as-is. Enter
 * confirms Revert, Shift+Enter confirms Don't revert, Esc cancels - matching
 * the keyboard hints in the footer. Each action closes the dialog
 * synchronously (the composer/message list reflects the result), so there is
 * no in-dialog pending state.
 */
export function RevertOnEditDialog(props: RevertOnEditDialogProps) {
  return (
    <RevertOnEditDialogContent
      key={props.open ? "open" : "closed"}
      {...props}
    />
  );
}

function RevertOnEditDialogContent(props: RevertOnEditDialogProps) {
  const { artifactCount, onDontRevert, onOpenChange, onRevert, open } = props;
  const [revertArtifacts, setRevertArtifacts] = useState(true);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-full min-w-0 gap-0 overflow-hidden p-0"
        style={{ maxWidth: "min(92vw, 34rem)" }}
        showCloseButton={false}
        data-testid="revert-on-edit-dialog"
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          if (event.shiftKey) {
            onDontRevert();
            return;
          }
          onRevert(revertArtifacts);
        }}
      >
        <DialogHeader className="space-y-1 px-6 pt-6 pb-2">
          <DialogTitle className="text-base font-semibold">
            Submit from a previous message?
          </DialogTitle>
          <DialogDescription>
            Submitting from a previous message will revert file changes to
            before this message and clear the messages after this one.
          </DialogDescription>
        </DialogHeader>

        {artifactCount > 0 ? (
          <div className="px-6 pt-1 pb-2">
            <RevertArtifactsCheckbox
              count={artifactCount}
              checked={revertArtifacts}
              onCheckedChange={setRevertArtifacts}
              disabled={false}
            />
          </div>
        ) : null}

        <DialogFooter className="mx-0 mb-0 mt-2 gap-2 rounded-b-xl border-t border-border/40 bg-muted/10 px-6 py-4">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel <span className="text-muted-foreground/70">(esc)</span>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onDontRevert}
            data-testid="revert-on-edit-keep"
          >
            Don't revert
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => onRevert(revertArtifacts)}
            data-testid="revert-on-edit-confirm"
          >
            Revert
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

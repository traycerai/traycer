import { useState, type SyntheticEvent } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

/**
 * Rename dialog for a switcher row. Desktop renames inline in the tree row,
 * which has no touch analog, so mobile drives the same canonical rename
 * mutations from a minimal dialog (mirrors the P1.3 epic-rename dialog shape).
 * The caller's `onSubmit` fires the matching mutation; the dialog closes on
 * submit and the new name lands via the projection.
 */
export function SwitcherRenameDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly initialValue: string;
  readonly nodeId: string;
  readonly onSubmit: (value: string) => void;
}) {
  const { open, onOpenChange, title, initialValue, nodeId, onSubmit } = props;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(92vw,28rem)] max-w-[min(92vw,28rem)]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {/* Radix unmounts closed content, so the form re-seeds from the current
            name on every open without an effect. */}
        {open ? (
          <SwitcherRenameForm
            initialValue={initialValue}
            nodeId={nodeId}
            onSubmit={onSubmit}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function SwitcherRenameForm(props: {
  readonly initialValue: string;
  readonly nodeId: string;
  readonly onSubmit: (value: string) => void;
}) {
  const { initialValue, nodeId, onSubmit } = props;
  const [value, setValue] = useState(initialValue);
  const trimmed = value.trim();
  const canSubmit = trimmed.length > 0 && trimmed !== initialValue;

  const handleSubmit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    onSubmit(trimmed);
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <Input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        aria-label="New name"
        data-testid={`switcher-rename-input-${nodeId}`}
      />
      <DialogFooter>
        <Button
          type="submit"
          disabled={!canSubmit}
          data-testid={`switcher-rename-save-${nodeId}`}
        >
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}

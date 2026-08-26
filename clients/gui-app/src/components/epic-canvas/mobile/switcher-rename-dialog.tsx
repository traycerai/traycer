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
      <DialogContent
        // Capped and split into header / scroller / footer like every other
        // dialog that holds a text field: a soft keyboard shrinks the layout
        // viewport in both mobile shells, so `dvh` resolves against the
        // uncovered strip and Save stays above the keyboard rather than under
        // it.
        className="grid max-h-[min(86dvh,calc(100dvh-2rem))] w-[min(92vw,28rem)] max-w-[min(92vw,28rem)] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0"
        data-testid="switcher-rename-dialog"
      >
        <DialogHeader className="px-4 pt-4 pr-12 pb-2">
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
    <form
      onSubmit={handleSubmit}
      className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto]"
    >
      <div
        className="min-h-0 overflow-y-auto px-4 pb-4"
        data-testid="switcher-rename-scroller"
      >
        <Input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          aria-label="New name"
          data-testid={`switcher-rename-input-${nodeId}`}
        />
      </div>
      {/* `mx-0 mb-0`: the footer's own negative margins bleed it into a `p-4`
          content, and this one is `p-0`. */}
      <DialogFooter className="mx-0 mb-0 px-4 py-3">
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

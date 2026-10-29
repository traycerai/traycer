import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import "@/index.css";

/**
 * Hit-test fixture: the Drafts dialog's "Deleted" toast with an "Undo" action,
 * raised over a Radix modal Dialog that a click outside DISMISSES.
 *
 * The dialog is the Drafts dialog's shape (`onOpenChange` closes it, nothing
 * prevents outside interaction), so a click that misses the toast and lands on
 * the overlay closes it. jsdom cannot see that: it never consults
 * `pointer-events`.
 */
export function ToastUndoOverModalFixture(): React.ReactElement {
  const [dialogOpen, setDialogOpen] = useState(true);
  const [undoClicks, setUndoClicks] = useState(0);

  useEffect(() => {
    const probeWindow = window as Window & {
      __probeRaiseDeleted?: () => void;
      __probeRaiseStack?: (count: number) => void;
    };
    probeWindow.__probeRaiseDeleted = () => {
      toast("Deleted", {
        duration: Infinity,
        action: {
          label: "Undo",
          onClick: () => {
            setUndoClicks((count) => count + 1);
          },
        },
      });
    };
    probeWindow.__probeRaiseStack = (count: number) => {
      for (let index = 0; index < count; index += 1) {
        toast(`Stacked ${String(index)}`, { duration: Infinity });
      }
    };
  }, []);

  return (
    <div data-probe-root>
      <div
        id="probe-state"
        data-undo-clicks={String(undoClicks)}
        data-dialog-open={String(dialogOpen)}
      />
      <Toaster position="bottom-right" />
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent data-testid="probe-dialog">
          <DialogHeader>
            <DialogTitle>Drafts</DialogTitle>
          </DialogHeader>
          <input data-probe-input aria-label="Search drafts" />
        </DialogContent>
      </Dialog>
    </div>
  );
}

const container = document.querySelector("#root");
if (container === null) throw new Error("probe root missing");
createRoot(container).render(<ToastUndoOverModalFixture />);

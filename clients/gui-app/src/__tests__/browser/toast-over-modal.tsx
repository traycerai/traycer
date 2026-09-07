import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import "@/index.css";

/**
 * Hit-test: is a Sonner toast button clickable while a Radix modal Dialog is open? jsdom never consults `pointer-events`.
 */
export function ToastOverModalFixture(): React.ReactElement {
  const [dialogOpen, setDialogOpen] = useState(true);
  const [actionClicks, setActionClicks] = useState(0);
  const [closeClicks, setCloseClicks] = useState(0);

  useEffect(() => {
    // Control: modal gone without a click. Closing by click is not under test.
    const probeWindow = window as Window & {
      __probeCloseDialog?: () => void;
    };
    probeWindow.__probeCloseDialog = () => {
      setDialogOpen(false);
    };
  }, []);

  useEffect(() => {
    toast(
      <div data-probe-toast-content>
        <span>Update available</span>
        <button
          type="button"
          data-probe-action
          onClick={() => {
            setActionClicks((count) => count + 1);
          }}
        >
          Download
        </button>
      </div>,
      { id: "probe-update-toast", description: null, duration: Infinity },
    );
  }, []);

  return (
    <div data-probe-root>
      <div
        id="probe-state"
        data-action-clicks={String(actionClicks)}
        data-close-clicks={String(closeClicks)}
        data-dialog-open={String(dialogOpen)}
      />
      <button
        type="button"
        data-probe-close-counter
        onClick={() => {
          setCloseClicks((count) => count + 1);
        }}
      />
      <Toaster position="bottom-right" />
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent
          data-testid="probe-dialog"
          // Without this, the first miss is an outside pointer-down that
          // dismisses the dialog and later readings have no modal.
          onEscapeKeyDown={(event) => {
            event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            event.preventDefault();
          }}
          onInteractOutside={(event) => {
            event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>Saving - please wait</DialogTitle>
            <DialogDescription>
              Stands in for any Radix modal dialog: the quit intercept and the
              window host modal are both `modal` roots.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              data-probe-dismiss
              onClick={() => {
                setDialogOpen(false);
              }}
            >
              Close the dialog
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const container = document.querySelector("#root");
if (container === null) throw new Error("probe root missing");
createRoot(container).render(<ToastOverModalFixture />);

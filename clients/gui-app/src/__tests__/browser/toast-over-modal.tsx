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
 * Hit-test fixture: is a Sonner toast's button clickable while a Radix `modal`
 * Dialog is open?
 *
 * jsdom cannot answer this - `fireEvent.click` dispatches straight at the node
 * and never consults `pointer-events`, so a jsdom test would report "clickable"
 * whatever the truth is. Radix's modal Dialog sets `pointer-events: none` on
 * `document.body` and re-enables it only on the layer node itself, so the
 * question is whether anything in the toaster subtree re-enables it.
 *
 * The toast mirrors `app-update-toast-controller`'s `available` variant: a
 * content node carrying an action button, `duration: Infinity`, plus Sonner's
 * own close button (our `Toaster` defaults `closeButton` to true), which is the
 * only dismissal that variant has.
 */
export function ToastOverModalFixture(): React.ReactElement {
  const [dialogOpen, setDialogOpen] = useState(true);
  const [actionClicks, setActionClicks] = useState(0);
  const [closeClicks, setCloseClicks] = useState(0);

  useEffect(() => {
    // The control arm needs the modal gone without depending on a click to get
    // there - what the control has to prove is that a real CDP click on the
    // TOAST registers once nothing is locking the body, so the dialog-closing
    // gesture must not be part of what is under test.
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
          // Mirrors `window-host-modal.tsx:68`. Load-bearing for the
          // measurement, not decoration: without it the first probe click -
          // which lands outside the dialog because the toast cannot receive
          // it - is itself an outside pointer-down that dismisses the dialog,
          // and every later reading is then taken with no modal open.
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

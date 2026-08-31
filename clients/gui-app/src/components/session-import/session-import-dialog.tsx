import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SessionImportWizard } from "@/components/session-import/session-import-wizard";

/**
 * The wizard as a Settings dialog. Closing it does not stop an import that has
 * already started (spec §5) - the run belongs to the app-wide controller, and
 * this dialog is only a window onto it.
 */
export function SessionImportDialog(props: { readonly onClose: () => void }) {
  const { onClose } = props;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        data-testid="session-import-dialog"
        className="flex h-[min(80dvh,calc(100dvh-2rem))] w-[min(92vw,48rem)] flex-col gap-4 sm:max-w-[min(92vw,48rem)]"
      >
        <DialogHeader>
          <DialogTitle>Import your work</DialogTitle>
          <DialogDescription>
            Bring work you already started in Claude Code, Codex, or OpenCode
            into Traycer as tasks.
          </DialogDescription>
        </DialogHeader>
        {/* Bled to the dialog's edges so the wizard's pinned header and footer
            rules run the full width and the footer sits flush in the corner -
            the dialog's chrome, not a panel floating inside its padding. */}
        <div className="-mx-4 -mb-4 flex min-h-0 flex-1 flex-col">
          <SessionImportWizard
            surface="dialog"
            // Submit means go: the dialog gets out of the way and the app-wide
            // progress toast takes over. Reopening while the run is live shows
            // the inline progress view - this closes a surface, never a run.
            onImportStarted={onClose}
            secondaryAction={{ label: "Close", onSelect: onClose }}
            registerSubmit={null}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

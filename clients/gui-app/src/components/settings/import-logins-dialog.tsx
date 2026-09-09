import type { ReactNode } from "react";
import { useIsMutating } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ImportLoginsFlow } from "@/components/settings/import-logins-flow";
import type { ImportLoginsFrame } from "@/components/settings/import-logins-frame";
import { browserMutationKeys } from "@/lib/query-keys";
import type { BrowserViewBridge } from "@traycer-clients/shared/platform/browser-view";

/**
 * Settings › Browser › Saved logins › "Import logins from another browser":
 * the headless {@link ImportLoginsFlow} in a dialog. The steps, their copy and
 * every explainer live in the flow; this wrapper owns only the window - when
 * it may close, and what a step's chrome renders as.
 *
 * Closing is refused while an import is in flight: the desktop is mid-write
 * (and may be showing a Keychain prompt), and the Done step is where the
 * outcome will land. The in-flight state is read off the mutation cache
 * rather than owned here, because the mutation is the flow's; the key is the
 * one `useLoginImportRun` registers under.
 */
export function ImportLoginsDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly browserView: BrowserViewBridge;
}): ReactNode {
  const pending =
    useIsMutating({ mutationKey: browserMutationKeys.importLogins() }) > 0;
  const close = (): void => {
    if (pending) return;
    props.onOpenChange(false);
  };
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        showCloseButton={!pending}
        className="w-[min(92vw,34rem)] sm:max-w-lg"
        data-testid="import-logins-dialog"
      >
        <ImportLoginsFlow
          browserView={props.browserView}
          enabled={props.open}
          frame={DIALOG_FRAME}
          onFinished={close}
        />
      </DialogContent>
    </Dialog>
  );
}

/** The dialog's own parts, which only render inside a `Dialog`. */
const DIALOG_FRAME: ImportLoginsFrame = {
  Header: DialogHeader,
  Title: DialogTitle,
  Description: DialogDescription,
  Footer: DialogFooter,
};

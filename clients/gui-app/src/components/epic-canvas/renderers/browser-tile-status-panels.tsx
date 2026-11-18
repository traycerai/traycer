import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { BrowserViewCertificateErrorChange } from "@traycer-clients/shared/platform/browser-view";

export function BrowserTileCertificateInterstitial(props: {
  readonly certificateError: BrowserViewCertificateErrorChange | null;
  readonly onProceed: () => void;
  readonly proceeding: boolean;
}) {
  const certificateError = props.certificateError;
  if (certificateError === null) return null;
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/95 px-4 text-foreground">
      <div className="flex w-[min(92vw,34rem)] flex-col gap-4 rounded-md border border-destructive/30 bg-popover p-5 shadow-lg">
        <div className="flex items-start gap-3">
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-destructive" />
          <div className="min-w-0">
            <div className="text-ui-base font-semibold">
              Certificate warning for {certificateError.hostname}
            </div>
            <div className="mt-1 text-ui-sm text-muted-foreground">
              {certificateError.error}
            </div>
          </div>
        </div>
        <dl className="grid gap-2 text-ui-xs text-muted-foreground">
          <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2">
            <dt>Subject</dt>
            <dd className="truncate text-foreground">
              {certificateError.subject}
            </dd>
          </div>
          <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2">
            <dt>Issuer</dt>
            <dd className="truncate text-foreground">
              {certificateError.issuer}
            </dd>
          </div>
          <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2">
            <dt>SHA-256</dt>
            <dd className="break-all font-mono text-foreground">
              {certificateError.fingerprint}
            </dd>
          </div>
        </dl>
        <div className="flex justify-end">
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={props.proceeding}
            onClick={props.onProceed}
          >
            Proceed for this origin
          </Button>
        </div>
      </div>
    </div>
  );
}

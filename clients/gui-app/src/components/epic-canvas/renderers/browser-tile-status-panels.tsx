import { AlertTriangle, ShieldAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type {
  BrowserViewCertificateErrorChange,
  BrowserViewDownloadChange,
} from "@traycer-clients/shared/platform/browser-view";
import { cn } from "@/lib/utils";

export function BrowserTileDownloadStrip(props: {
  readonly downloads: readonly BrowserViewDownloadChange[];
  readonly onCancel: (downloadId: string) => void;
}) {
  const visibleDownloads = props.downloads.slice(-3);
  if (visibleDownloads.length === 0) return null;
  return (
    <div
      data-browser-overlay="browser-downloads"
      className="pointer-events-auto absolute bottom-3 left-3 z-20 flex w-[min(92%,30rem)] flex-col gap-2"
    >
      {visibleDownloads.map((download) => (
        <BrowserDownloadRow
          key={download.downloadId}
          download={download}
          onCancel={props.onCancel}
        />
      ))}
    </div>
  );
}

export function BrowserTileCertificateInterstitial(props: {
  readonly certificateError: BrowserViewCertificateErrorChange | null;
  readonly onProceed: () => void;
  readonly proceeding: boolean;
}) {
  const certificateError = props.certificateError;
  if (certificateError === null) return null;
  return (
    <div
      data-browser-overlay="browser-certificate-error"
      className="absolute inset-0 z-20 flex items-center justify-center bg-background/95 px-4 text-foreground"
    >
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

function BrowserDownloadRow(props: {
  readonly download: BrowserViewDownloadChange;
  readonly onCancel: (downloadId: string) => void;
}) {
  const download = props.download;
  const percent = downloadPercent(download);
  const terminal =
    download.state === "completed" ||
    download.state === "cancelled" ||
    download.state === "interrupted";
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 shadow-md">
      <div className="flex min-w-0 items-start gap-2">
        <AlertTriangle
          className={cn(
            "mt-0.5 size-4 shrink-0 text-muted-foreground",
            download.dangerType !== null &&
              "text-amber-600 dark:text-amber-400",
            download.state === "interrupted" && "text-destructive",
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-ui-sm font-medium">
            {download.filename}
          </div>
          <div className="mt-0.5 text-ui-xs text-muted-foreground">
            {downloadLabel(download)}
          </div>
          {terminal || percent === null ? null : (
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-foreground/8">
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${percent}%` }}
              />
            </div>
          )}
        </div>
        {download.canCancel ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Cancel ${download.filename}`}
            onClick={() => props.onCancel(download.downloadId)}
          >
            <X className="size-4" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function downloadPercent(download: BrowserViewDownloadChange): number | null {
  if (download.totalBytes <= 0) return null;
  return Math.max(
    0,
    Math.min(
      100,
      Math.round((download.receivedBytes / download.totalBytes) * 100),
    ),
  );
}

function downloadLabel(download: BrowserViewDownloadChange): string {
  if (download.state === "prompting") return "Waiting for save location";
  if (download.state === "completed") return "Download complete";
  if (download.state === "cancelled") return "Download cancelled";
  if (download.state === "interrupted") return "Download interrupted";
  const sizeLabel = downloadSizeLabel(download);
  if (download.dangerType !== null) {
    return `${sizeLabel} · ${download.dangerType} confirmed`;
  }
  return sizeLabel;
}

function downloadSizeLabel(download: BrowserViewDownloadChange): string {
  if (download.totalBytes <= 0) return bytesLabel(download.receivedBytes);
  return `${bytesLabel(download.receivedBytes)} of ${bytesLabel(download.totalBytes)}`;
}

function bytesLabel(value: number): string {
  if (value < 1024) return `${value} B`;
  const kib = value / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KB`;
  const mib = kib / 1024;
  if (mib < 1024) return `${mib.toFixed(1)} MB`;
  return `${(mib / 1024).toFixed(1)} GB`;
}

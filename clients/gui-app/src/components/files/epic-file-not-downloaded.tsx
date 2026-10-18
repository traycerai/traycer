import type { ReactNode } from "react";
import { CloudDownload, Download } from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import type { EpicFileCopy } from "@/hooks/files/use-epic-file-copy";
import { formatByteSize } from "@/lib/format-byte-size";
import { cn } from "@/lib/utils";

export interface EpicFileNotDownloadedProps {
  /** What the file is, in a sentence: "video", "PDF", "image". */
  readonly noun: string;
  /** `null` when the files lane has not said how big it is. */
  readonly byteLength: number | null;
  /** The copy onto the tile's host - see `useEpicFileCopy`. */
  readonly copy: EpicFileCopy;
}

function progressPercent(received: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((received / total) * 100));
}

/** The line under the heading: what to do, or that it is underway. */
function notDownloadedDetail(noun: string, copying: boolean): string {
  return copying
    ? "Downloading to this device…"
    : `Download this ${noun} to view it here.`;
}

/**
 * A file too big for the eager mirror, not on this device yet (Viewers,
 * "Large file not downloaded yet"): the size, one Download action, and once the
 * host is copying it, its progress with Cancel.
 *
 * Stateless about the transfer itself: the progress is what the files lane
 * reports for this host, so a copy started from another window shows the same
 * progress here. Where the lane cannot speak for the host the bar is
 * indeterminate until the bytes land.
 */
export function EpicFileNotDownloaded(
  props: EpicFileNotDownloadedProps,
): ReactNode {
  const size =
    props.byteLength === null ? null : formatByteSize(props.byteLength);
  const { copy } = props;
  const progress = copy.progress;
  return (
    <div
      role="status"
      data-testid="epic-file-not-downloaded"
      className="flex size-full flex-col items-center justify-center gap-3 p-6 text-center"
    >
      <span className="flex size-9 items-center justify-center rounded-lg border border-canvas-border/40 bg-foreground/5 text-muted-foreground">
        <CloudDownload className="size-4" aria-hidden />
      </span>
      <div>
        <p className="text-ui-sm font-medium text-foreground">
          Not on this device yet
        </p>
        <p className="text-ui-sm text-muted-foreground">
          {notDownloadedDetail(props.noun, copy.copying)}
        </p>
      </div>
      {copy.copying ? (
        <div className="flex w-full max-w-64 flex-col gap-1.5">
          <div
            role="progressbar"
            aria-label="Download progress"
            aria-valuemin={0}
            aria-valuemax={progress?.total}
            aria-valuenow={progress?.received}
            className="h-1 w-full overflow-hidden rounded-full bg-foreground/10"
          >
            <div
              className={cn(
                "h-full bg-primary",
                progress === null && "w-1/3 animate-pulse",
              )}
              style={
                progress === null
                  ? undefined
                  : {
                      width: `${progressPercent(progress.received, progress.total)}%`,
                    }
              }
            />
          </div>
          <p className="text-ui-xs text-muted-foreground tabular-nums">
            {progress === null
              ? null
              : `${formatByteSize(progress.received)} of ${formatByteSize(progress.total)} · `}
            <Button
              variant="link"
              size="inline-xs"
              disabled={copy.cancelPending}
              onClick={copy.cancel}
            >
              Cancel
            </Button>
          </p>
        </div>
      ) : (
        <Button
          variant="default"
          disabled={copy.startPending}
          onClick={copy.start}
        >
          <Download aria-hidden />
          {size === null ? "Download" : `Download ${size}`}
          {copy.startPending ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          ) : null}
        </Button>
      )}
    </div>
  );
}

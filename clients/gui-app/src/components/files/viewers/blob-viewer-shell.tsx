import type { ReactNode } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";
import { EpicFileNotDownloaded } from "@/components/files/epic-file-not-downloaded";
import { ViewerToolbar } from "@/components/files/viewers/viewer-toolbar";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useEpicFileBlobQuery } from "@/hooks/files/use-epic-file-blob-query";
import { useEpicFileCopy } from "@/hooks/files/use-epic-file-copy";
import { useEpicFileRecord } from "@/hooks/files/use-epic-file-record";
import {
  epicFileUnavailableMessage,
  epicFileUnavailableRetries,
  type EpicFileAddress,
} from "@/hooks/files/use-epic-file-text-query";
import { formatByteSize } from "@/lib/format-byte-size";

export interface BlobViewerShellProps {
  readonly hostId: string;
  readonly address: EpicFileAddress;
  /** What the file is, for the not-downloaded sentence: "image", "PDF". */
  readonly noun: string;
  /** The most this viewer holds in memory; a bigger file offers Download only. */
  readonly maxBytes: number;
  /**
   * What to add after "Too large to preview here" when the file is over the
   * cap (a video says it plays once the upload lands); `null` adds nothing.
   */
  readonly tooLargeDetail: string | null;
  /** The toolbar's left side while there is no file to describe yet. */
  readonly caption: string;
  /** The tile's actions, which ride whichever toolbar is showing. */
  readonly actions: ReactNode;
  readonly children: (blob: Blob) => ReactNode;
}

/**
 * Everything a viewer that needs the whole file as a Blob shares: the read, its
 * loading and error states, the not-downloaded state with Download, progress and
 * Cancel, and the over-the-cap notice - each under a plain toolbar carrying the
 * tile's actions, so Download and the version menu never disappear. The viewer
 * supplies what to do with a Blob in hand, its own toolbar included.
 */
export function BlobViewerShell(props: BlobViewerShellProps): ReactNode {
  const { hostId, address } = props;
  const query = useEpicFileBlobQuery(hostId, address, props.maxBytes);

  function body(): ReactNode {
    if (query.isPending) {
      return (
        <div className="flex size-full items-center justify-center">
          <AgentSpinningDots
            className={undefined}
            testId="epic-file-loading"
            variant={undefined}
          />
        </div>
      );
    }
    const retry = (
      <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
        <RotateCw aria-hidden />
        Retry
      </Button>
    );
    if (query.isError) {
      return <ShellNotice title="Couldn't load this file." action={retry} />;
    }
    const result = query.data;
    if (result.kind === "unavailable" && result.reason === "not-downloaded") {
      return (
        <BlobNotDownloaded
          hostId={hostId}
          address={address}
          noun={props.noun}
        />
      );
    }
    if (result.kind === "unavailable") {
      return (
        <ShellNotice
          title={epicFileUnavailableMessage(result.reason)}
          action={epicFileUnavailableRetries(result.reason) ? retry : null}
        />
      );
    }
    if (result.kind === "too-large") {
      // The toolbar's Download is the way past the cap.
      return (
        <ShellNotice
          title={tooLargeTitle(result.totalBytes, props.tooLargeDetail)}
          action={null}
        />
      );
    }
    return null;
  }

  if (query.data?.kind === "blob") return props.children(query.data.blob);
  return (
    <div className="flex size-full min-h-0 flex-col">
      <ViewerToolbar caption={props.caption} actions={props.actions} />
      <div className="min-h-0 flex-1">{body()}</div>
    </div>
  );
}

function BlobNotDownloaded(props: {
  readonly hostId: string;
  readonly address: EpicFileAddress;
  readonly noun: string;
}): ReactNode {
  const copy = useEpicFileCopy(props.hostId, props.address, null);
  const record = useEpicFileRecord(props.address.path);
  return (
    <EpicFileNotDownloaded
      noun={props.noun}
      byteLength={record?.entry.byteLength ?? null}
      copy={copy}
    />
  );
}

function tooLargeTitle(totalBytes: number, detail: string | null): string {
  const base = `Too large to preview here (${formatByteSize(totalBytes)}).`;
  return detail === null ? base : `${base} ${detail}`;
}

function ShellNotice(props: {
  readonly title: string;
  readonly action: ReactNode;
}): ReactNode {
  return (
    <div
      role="status"
      className="flex size-full flex-col items-center justify-center gap-3 p-6 text-center text-ui-sm text-muted-foreground"
    >
      <AlertTriangle className="size-5" aria-hidden />
      <p>{props.title}</p>
      {props.action}
    </div>
  );
}

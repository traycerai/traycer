import { useState, type ReactNode } from "react";
import { AlertTriangle, Download, FileCode, RotateCw } from "lucide-react";
import { SandboxFrame } from "@/components/sandbox/sandbox-frame";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useEpicFileFetch } from "@/hooks/files/use-epic-file-mutations";
import {
  epicFileUnavailableMessage,
  useEpicFileTextQuery,
  type EpicFileAddress,
} from "@/hooks/files/use-epic-file-text-query";
import type { SandboxSize, SandboxStatus } from "@/lib/sandbox/bridge-host";
import type { SandboxPermission } from "@/lib/sandbox/sandbox-url";
import { cn } from "@/lib/utils";

/** The stamp's floor, and the tallest page a preview ever captures. */
const MIN_PAGE_HEIGHT_PX = 80;
const MAX_PAGE_HEIGHT_PX = 4000;
const NO_PERMISSIONS: readonly SandboxPermission[] = [];

export interface HtmlViewerProps {
  readonly hostId: string;
  readonly address: EpicFileAddress;
  readonly title: string;
  /**
   * Inline (a page row): the height to hold until the page reports its own.
   * `null` fills the container (the epic-file tile).
   */
  readonly initialHeight: number | null;
  readonly onOpenInBrowser: () => void;
  readonly openInBrowserPending: boolean;
}

function ignoreTeardown(): void {}

function clampPageHeight(height: number): number {
  return Math.min(MAX_PAGE_HEIGHT_PX, Math.max(MIN_PAGE_HEIGHT_PX, height));
}

/**
 * An HTML epic file - an agent page - in the shared sandbox frame (D12), with
 * the network policy the host answered for this caller and row. Owns the
 * page's states: loading (PageStates 3), not on this device (5) and crashed
 * (7).
 *
 * A new mount is a new document, so a row that scrolls back on screen loads
 * its page again (D10); the tile keeps one mounted for long work.
 */
export function HtmlViewer(props: HtmlViewerProps) {
  const { hostId, address, title, initialHeight } = props;
  const query = useEpicFileTextQuery(hostId, address);
  const fetchFile = useEpicFileFetch(hostId, address);
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null);
  const [crashed, setCrashed] = useState(false);
  const [generation, setGeneration] = useState(0);

  if (query.isPending) {
    return <PageSkeleton height={initialHeight} />;
  }
  if (query.isError) {
    return (
      <PageNotice
        icon={<FileCode aria-hidden />}
        title={title}
        detail="Couldn't load this page."
        actions={<RetryButton onRetry={() => void query.refetch()} />}
      />
    );
  }
  const response = query.data;
  if (response.kind === "unavailable" && response.reason === "not-downloaded") {
    // Too big for the eager mirror: nothing copies it until someone asks, so
    // Retry alone would wait forever (PageStates 5).
    const copying = fetchFile.data?.kind === "downloading";
    return (
      <PageNotice
        icon={<FileCode aria-hidden />}
        title={title}
        detail={
          copying
            ? "Copying it to this device. It shows here when it lands."
            : epicFileUnavailableMessage(response.reason)
        }
        actions={
          copying ? null : (
            <Button
              variant="outline"
              size="sm"
              disabled={fetchFile.isPending}
              onClick={() => fetchFile.mutate()}
            >
              <Download aria-hidden />
              Download
              {fetchFile.isPending ? (
                <AgentSpinningDots
                  className={undefined}
                  testId={undefined}
                  variant={undefined}
                />
              ) : null}
            </Button>
          )
        }
      />
    );
  }
  if (response.kind === "unavailable") {
    return (
      <PageNotice
        icon={<FileCode aria-hidden />}
        title={title}
        detail={epicFileUnavailableMessage(response.reason)}
        actions={<RetryButton onRetry={() => void query.refetch()} />}
      />
    );
  }
  if (response.kind !== "text") {
    return (
      <PageNotice
        icon={<FileCode aria-hidden />}
        title={title}
        detail="This file has no page to show."
        actions={null}
      />
    );
  }
  if (crashed) {
    return (
      <PageNotice
        icon={<AlertTriangle aria-hidden />}
        title="This page stopped responding"
        detail="Reload it, or open it in the browser to see the console."
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setCrashed(false);
                setMeasuredHeight(null);
                setGeneration((value) => value + 1);
              }}
            >
              Reload
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={props.openInBrowserPending}
              onClick={props.onOpenInBrowser}
            >
              Open in browser
              {props.openInBrowserPending ? (
                <AgentSpinningDots
                  className={undefined}
                  testId={undefined}
                  variant={undefined}
                />
              ) : null}
            </Button>
          </>
        }
      />
    );
  }

  const handleSize = (size: SandboxSize): void => {
    if (initialHeight === null || size.height === null) return;
    setMeasuredHeight(clampPageHeight(size.height));
  };
  const handleStatus = (status: SandboxStatus): void => {
    if (status === "crashed") setCrashed(true);
  };

  return (
    <SandboxFrame
      key={generation}
      html={response.text}
      kind="page"
      title={title}
      networkPolicy={response.networkPolicy}
      appCsp={null}
      permissions={NO_PERMISSIONS}
      appRequests={null}
      className=""
      height={initialHeight === null ? null : (measuredHeight ?? initialHeight)}
      onSize={handleSize}
      onStatus={handleStatus}
      onRequestTeardown={ignoreTeardown}
      displayMode="inline"
      onBridge={null}
      ref={null}
    />
  );
}

/** PageStates 3: the page's rough shape, at the height the stamp promised. */
function PageSkeleton(props: { readonly height: number | null }) {
  return (
    <div
      aria-hidden
      data-testid="page-skeleton"
      className={cn(
        "flex w-full flex-col gap-3 overflow-hidden pt-1",
        props.height === null && "h-full p-6",
      )}
      style={{ height: props.height ?? undefined }}
    >
      <div className="grid grid-cols-4 gap-3">
        <Skeleton className="h-14 opacity-70" />
        <Skeleton className="h-14 opacity-70" />
        <Skeleton className="h-14 opacity-70" />
        <Skeleton className="h-14 opacity-70" />
      </div>
      <Skeleton className="h-3 w-2/5 opacity-60" />
      <Skeleton className="h-3 w-7/10 opacity-50" />
      <Skeleton className="h-3 w-11/20 opacity-40" />
    </div>
  );
}

/** PageStates 5 and 7: a one-line box standing in for the page. */
function PageNotice(props: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly detail: string;
  readonly actions: ReactNode;
}) {
  return (
    <div
      role="status"
      className="flex w-full items-center gap-2.5 rounded-md border border-canvas-border/40 bg-foreground/5 px-3 py-2 text-ui-sm [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground"
    >
      {props.icon}
      <div className="min-w-0 flex-1">
        <div className="truncate">{props.title}</div>
        <div className="text-ui-xs text-muted-foreground">{props.detail}</div>
      </div>
      {props.actions}
    </div>
  );
}

function RetryButton(props: { readonly onRetry: () => void }) {
  return (
    <Button variant="outline" size="sm" onClick={props.onRetry}>
      <RotateCw aria-hidden />
      Retry
    </Button>
  );
}

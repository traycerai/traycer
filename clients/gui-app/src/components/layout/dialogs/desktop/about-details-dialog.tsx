import { useEffect, useState, type ReactNode } from "react";
import { Check, Copy, ExternalLink, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { createReportIssueContext } from "@/lib/report-issue-context";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { DesktopSupportSnapshot } from "@/lib/windows/types";
import type { AboutDetailsDialogProps } from "./types";

export function AboutDetailsDialog(props: AboutDetailsDialogProps): ReactNode {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <AboutDetailsDialogContent
        key={props.open ? "open" : "closed"}
        open={props.open}
        support={props.support}
        openExternalLink={props.openExternalLink}
      />
    </Dialog>
  );
}

interface AboutDetailsDialogContentProps {
  readonly open: boolean;
  readonly support: import("@/lib/windows/types").DesktopSupportBridge | null;
  readonly openExternalLink: (url: string) => Promise<void>;
}

function AboutDetailsDialogContent(
  props: AboutDetailsDialogContentProps,
): ReactNode {
  const snapshot = useSupportSnapshot(props.open, props.support);
  const [linkError, setLinkError] = useState<string | null>(null);

  const openLink = (url: string): void => {
    setLinkError(null);
    void props.openExternalLink(url).catch(() => {
      setLinkError("Could not open the selected link.");
    });
  };

  let snapshotContent: ReactNode;
  if (snapshot.status === "ready") {
    snapshotContent = (
      <>
        <DetailsGrid snapshot={snapshot.snapshot} />
        <SupportLinks snapshot={snapshot.snapshot} openLink={openLink} />
      </>
    );
  } else if (snapshot.status === "unavailable") {
    snapshotContent = (
      <div className="flex items-center gap-2 text-ui-sm text-muted-foreground">
        <span>{snapshot.message}</span>
        <ReportIssueAction
          context={createReportIssueContext({
            title: "Couldn't load desktop details",
            message: null,
            code: null,
            source: "About Traycer",
          })}
          presentation="link"
          className="h-auto p-0 text-current"
        />
      </div>
    );
  } else {
    snapshotContent = (
      <p className="text-ui-sm text-muted-foreground">{snapshot.message}</p>
    );
  }

  return (
    <DialogContent className="sm:max-w-xl">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Info className="size-4" />
          About Traycer
        </DialogTitle>
        <DialogDescription className="sr-only">
          Desktop runtime and diagnostics details.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-3">{snapshotContent}</div>
      {linkError === null ? null : (
        <div
          className="flex items-center gap-2 text-ui-sm text-destructive"
          role="alert"
        >
          <span>{linkError}</span>
          <ReportIssueAction
            context={createReportIssueContext({
              title: "Couldn't open the link",
              message: null,
              code: null,
              source: "About Traycer",
            })}
            presentation="link"
            className="h-auto p-0 text-current"
          />
        </div>
      )}
      <DialogFooter showCloseButton>
        {snapshot.status === "ready" ? (
          <CopyDetailsButton snapshot={snapshot.snapshot} />
        ) : null}
      </DialogFooter>
    </DialogContent>
  );
}

type SupportSnapshotState =
  | { readonly status: "loading"; readonly message: string }
  | { readonly status: "unavailable"; readonly message: string }
  | { readonly status: "ready"; readonly snapshot: DesktopSupportSnapshot };

interface SupportSnapshotResource {
  readonly support: import("@/lib/windows/types").DesktopSupportBridge;
  readonly snapshot: SupportSnapshotState;
}

function useSupportSnapshot(
  open: boolean,
  support: import("@/lib/windows/types").DesktopSupportBridge | null,
): SupportSnapshotState {
  const [resource, setResource] = useState<SupportSnapshotResource | null>(
    null,
  );

  useEffect(() => {
    if (!open || support === null) {
      return;
    }
    let cancelled = false;
    void support.getSnapshot().then(
      (next) => {
        if (!cancelled) {
          setResource({
            support,
            snapshot: { status: "ready", snapshot: next },
          });
        }
      },
      () => {
        if (!cancelled) {
          setResource({
            support,
            snapshot: {
              status: "unavailable",
              message: "Could not load desktop details.",
            },
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, support]);

  if (!open) {
    return { status: "loading", message: "Loading details..." };
  }
  if (support === null) {
    return {
      status: "unavailable",
      message: "Desktop support bridge unavailable.",
    };
  }
  if (resource?.support === support) {
    return resource.snapshot;
  }
  return { status: "loading", message: "Loading details..." };
}

interface DetailsGridProps {
  readonly snapshot: DesktopSupportSnapshot;
}

/**
 * Copies the whole details grid as `Label: value` lines - the shape a user is
 * asked to paste into a support thread or bug report.
 */
function CopyDetailsButton(props: {
  readonly snapshot: DesktopSupportSnapshot;
}): ReactNode {
  const { copied, copy } = useClipboardCopy({
    resetMs: 1500,
    onSuccess: null,
    onError: null,
  });

  return (
    <Button
      type="button"
      variant="outline"
      aria-label={copied ? "Copied details" : "Copy details"}
      onClick={() =>
        copy(
          buildDetailRows(props.snapshot)
            .map(([label, value]) => `${label}: ${value}`)
            .join("\n"),
        )
      }
    >
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      Copy Details
    </Button>
  );
}

function buildDetailRows(
  snapshot: DesktopSupportSnapshot,
): readonly (readonly [string, string])[] {
  return [
    ["Version", snapshot.appVersion],
    ["Signed In", formatSignedInUser(snapshot)],
    ["Support", snapshot.supportEmail],
    ["Platform", `${snapshot.platform} ${snapshot.arch}`],
    ["Electron", snapshot.versions.electron],
    ["Chrome", snapshot.versions.chrome],
    ["Node", snapshot.versions.node],
    [
      "Host",
      snapshot.host.status === "ready"
        ? `${snapshot.host.version ?? "unknown"} (pid ${
            snapshot.host.pid ?? "unknown"
          })`
        : "starting",
    ],
  ];
}

function DetailsGrid(props: DetailsGridProps): ReactNode {
  return (
    <dl className="grid gap-2">
      {buildDetailRows(props.snapshot).map(([label, value]) => (
        <div key={label} className="grid grid-cols-[7rem_1fr] gap-3">
          <dt className="text-ui-sm text-muted-foreground">{label}</dt>
          <dd className="min-w-0 truncate text-ui-sm">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

interface SupportLinksProps {
  readonly snapshot: DesktopSupportSnapshot;
  readonly openLink: (url: string) => void;
}

function SupportLinks(props: SupportLinksProps): ReactNode {
  return (
    <div className="flex flex-wrap gap-2 pt-1">
      {props.snapshot.links.map((entry) => (
        <Button
          key={entry.id}
          type="button"
          variant="outline"
          size="sm"
          onClick={() => props.openLink(entry.url)}
        >
          <ExternalLink />
          {entry.label}
        </Button>
      ))}
    </div>
  );
}

function formatSignedInUser(snapshot: DesktopSupportSnapshot): string {
  if (snapshot.user.status !== "signed-in") {
    return snapshot.user.status === "signing-in" ? "Signing in" : "Signed out";
  }
  if (snapshot.user.userName !== null && snapshot.user.email !== null) {
    return `${snapshot.user.userName} <${snapshot.user.email}>`;
  }
  return snapshot.user.email ?? snapshot.user.userName ?? "Signed in";
}

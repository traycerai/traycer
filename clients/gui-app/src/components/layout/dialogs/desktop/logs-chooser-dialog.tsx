import { useEffect, useReducer, useState, type ReactNode } from "react";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyTextButton } from "@/components/copy-text-button";
import { StartTruncatedText } from "@/components/ui/start-truncated-text";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  DesktopSupportBridge,
  DesktopSupportLogDescriptor,
  DesktopSupportLogTailResult,
  DesktopSupportLogTarget,
  DesktopSupportSnapshot,
} from "@/lib/windows/types";
import type { DesktopSupportDialogProps } from "./types";

const SUPPORT_LOG_TAIL_LINES = 100;

export function LogsChooserDialog(props: DesktopSupportDialogProps): ReactNode {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <LogsChooserDialogContent
        key={props.open ? "open" : "closed"}
        open={props.open}
        support={props.support}
      />
    </Dialog>
  );
}

interface LogsChooserDialogContentProps {
  readonly open: boolean;
  readonly support: DesktopSupportBridge | null;
}

interface RevealState {
  readonly pendingTarget: DesktopSupportLogTarget | null;
  readonly error: string | null;
}

type RevealAction =
  | {
      readonly type: "start";
      readonly target: DesktopSupportLogTarget;
    }
  | { readonly type: "finish" }
  | { readonly type: "error"; readonly message: string };

function revealReducer(_state: RevealState, action: RevealAction): RevealState {
  if (action.type === "start") {
    return { pendingTarget: action.target, error: null };
  }
  if (action.type === "finish") {
    return { pendingTarget: null, error: null };
  }
  return { pendingTarget: null, error: action.message };
}

function LogsChooserDialogContent(
  props: LogsChooserDialogContentProps,
): ReactNode {
  const snapshot = useSupportSnapshot(props.open, props.support);
  const [revealState, dispatchReveal] = useReducer(revealReducer, {
    pendingTarget: null,
    error: null,
  });

  const revealLog = (target: DesktopSupportLogTarget): void => {
    if (props.support === null) {
      dispatchReveal({
        type: "error",
        message: "Desktop support bridge unavailable.",
      });
      return;
    }
    dispatchReveal({ type: "start", target });
    void props.support.revealLog(target).then(
      () => {
        dispatchReveal({ type: "finish" });
      },
      () => {
        dispatchReveal({
          type: "error",
          message: "Could not reveal the selected log.",
        });
      },
    );
  };

  return (
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <FolderOpen className="size-4" />
          Open Logs
        </DialogTitle>
        <DialogDescription className="sr-only">
          Desktop and host diagnostics.
        </DialogDescription>
      </DialogHeader>
      {snapshot.status === "ready" ? (
        <div className="grid gap-2">
          {snapshot.snapshot.logs.map((entry) => (
            <LogEntryPanel
              key={entry.target}
              entry={entry}
              support={props.support}
              revealDisabled={revealState.pendingTarget !== null}
              revealPending={revealState.pendingTarget === entry.target}
              onReveal={() => revealLog(entry.target)}
            />
          ))}
        </div>
      ) : (
        <p className="text-ui-sm text-muted-foreground">{snapshot.message}</p>
      )}
      {revealState.error === null ? null : (
        <p className="text-ui-sm text-destructive" role="alert">
          {revealState.error}
        </p>
      )}
      <DialogFooter showCloseButton />
    </DialogContent>
  );
}

type SupportSnapshotState =
  | { readonly status: "loading"; readonly message: string }
  | { readonly status: "unavailable"; readonly message: string }
  | { readonly status: "ready"; readonly snapshot: DesktopSupportSnapshot };

interface SupportSnapshotResource {
  readonly support: DesktopSupportBridge;
  readonly snapshot: SupportSnapshotState;
}

function useSupportSnapshot(
  open: boolean,
  support: DesktopSupportBridge | null,
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

type LogTailState =
  | { readonly status: "idle"; readonly message: string }
  | { readonly status: "loading"; readonly message: string }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly result: DesktopSupportLogTailResult };

interface LogEntryPanelProps {
  readonly entry: DesktopSupportLogDescriptor;
  readonly support: DesktopSupportBridge | null;
  readonly revealDisabled: boolean;
  readonly revealPending: boolean;
  readonly onReveal: () => void;
}

function LogEntryPanel(props: LogEntryPanelProps): ReactNode {
  const [open, setOpen] = useState(false);
  const tail = useLogTail(open, props.support, props.entry.target);
  const Icon = open ? ChevronUp : ChevronDown;

  return (
    <div className="grid gap-2 rounded-lg border border-border/70 p-3">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="grid min-w-0 flex-1 gap-1 text-left"
        >
          <span className="inline-flex min-w-0 items-center gap-2 text-ui-sm font-medium">
            <Icon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{props.entry.label}</span>
          </span>
          <StartTruncatedText className="block min-w-0 font-mono text-code-xs text-muted-foreground">
            {props.entry.path}
          </StartTruncatedText>
        </button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={props.revealDisabled}
          onClick={props.onReveal}
          className="shrink-0"
        >
          <FolderOpen />
          {props.revealPending ? "Opening..." : "Reveal"}
        </Button>
      </div>
      {open ? <LogTailView state={tail} /> : null}
    </div>
  );
}

function useLogTail(
  open: boolean,
  support: DesktopSupportBridge | null,
  target: DesktopSupportLogTarget,
): LogTailState {
  const { data, isError, isFetching } = useQuery({
    ...desktopSupportLogTailQueryOptions(support, target),
    enabled: open && support !== null,
  });

  if (!open) return { status: "idle", message: "Expand to load log output." };
  if (support === null) {
    return { status: "error", message: "Desktop support bridge unavailable." };
  }
  if (data !== undefined) return { status: "ready", result: data };
  if (isError)
    return { status: "error", message: "Could not load log output." };
  if (isFetching) {
    return { status: "loading", message: "Loading log output..." };
  }
  return { status: "idle", message: "Expand to load log output." };
}

function desktopSupportLogTailQueryOptions(
  support: DesktopSupportBridge | null,
  target: DesktopSupportLogTarget,
) {
  return queryOptions({
    queryKey: ["desktop-support-log-tail", support, target],
    queryFn: () => {
      if (support === null) {
        return Promise.reject(new Error("Desktop support bridge unavailable."));
      }
      return support.tailLog({ target, tailLines: SUPPORT_LOG_TAIL_LINES });
    },
  });
}

function LogTailView(props: { readonly state: LogTailState }): ReactNode {
  if (props.state.status === "ready") {
    const content = props.state.result.lines.join("\n");
    if (content.length === 0) {
      return (
        <p className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-center text-ui-xs text-muted-foreground">
          Log file is empty.
        </p>
      );
    }
    return (
      <div className="grid gap-1">
        <div className="flex items-center justify-between gap-2">
          {props.state.result.truncated ? (
            <p className="text-ui-xs text-muted-foreground">
              Showing last {SUPPORT_LOG_TAIL_LINES} lines.
            </p>
          ) : (
            <span aria-hidden />
          )}
          <CopyTextButton
            value={content}
            label={null}
            ariaLabel="Copy log output"
            disabled={false}
          />
        </div>
        <pre className="max-h-72 w-full overflow-auto rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-left font-mono text-code-xs text-muted-foreground">
          {content}
        </pre>
      </div>
    );
  }

  return (
    <p className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-center text-ui-xs text-muted-foreground">
      {props.state.message}
    </p>
  );
}

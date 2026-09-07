import { use, useState, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { HostScopeConnecting } from "@/components/settings/host-scope/host-scope-gate";
import { scopedHostReadiness } from "@/components/settings/host-scope/scoped-host-readiness";
import {
  useHostScopeFor,
  type HostScope,
} from "@/components/settings/host-scope/use-host-scope";
import { useScopedHostBinding } from "@/components/settings/host-scope/use-scoped-host-binding";
import { useScopedStreamBinding } from "@/components/settings/host-scope/use-scoped-stream-binding";
import { SessionImportWizard } from "@/components/session-import/session-import-wizard";
import { useSessionImportScan } from "@/components/session-import/use-session-import-scan";
import { useSessionImportAvailableFor } from "@/hooks/session-import/use-session-import-available";
import { useRegisteredHostsPollLiveness } from "@/hooks/auth/use-registered-hosts-query";
import { HostRuntimeContext, useHostBinding } from "@/lib/host";
import {
  StreamRuntimeContext,
  useStreamRuntimeBinding,
} from "@/lib/host/stream-runtime-context";
import { useSessionImportRun } from "@/stores/session-import/session-import-run-store";

/**
 * The import dialog is bound to the host its entry point named for its lifetime.
 * Both unary and stream runtimes must address that host, including while an
 * import continues after this dialog closes.
 */
export function SessionImportDialog(props: {
  readonly onClose: () => void;
  /** Settings names its host; announcement entry captures the ambient host. */
  readonly initialHostId: string | null;
}) {
  const ambientStreamBinding = use(StreamRuntimeContext);
  const [scopedHostId, setScopedHostId] = useState<string | null>(
    () => props.initialHostId ?? ambientStreamBinding?.hostId ?? null,
  );
  useRegisteredHostsPollLiveness();
  const scope = useHostScopeFor({ scopedHostId, setScopedHostId });
  const scopedBinding = useScopedHostBinding(scope);
  const ambientBinding = useHostBinding();
  const scopedStreamBinding = useScopedStreamBinding(scope);
  return (
    <HostRuntimeContext.Provider value={scopedBinding ?? ambientBinding}>
      <StreamRuntimeContext.Provider
        value={scopedStreamBinding ?? ambientStreamBinding}
      >
        <SessionImportDialogBody
          scope={scope}
          hasExplicitPick
          onClose={props.onClose}
        />
      </StreamRuntimeContext.Provider>
    </HostRuntimeContext.Provider>
  );
}

/**
 * Everything beneath the re-providers, so that every hook here reads the
 * PICKED host's transports rather than the ambient ones.
 */
function SessionImportDialogBody(props: {
  readonly scope: HostScope;
  readonly hasExplicitPick: boolean;
  readonly onClose: () => void;
}): ReactNode {
  const { scope, hasExplicitPick, onClose } = props;
  // Read INSIDE the providers, so it is the transport the wizard actually
  // uses. `useScopedStreamBinding` fills its binding in an effect, so the
  // scope can say `ready` for host B while this still names host A - the
  // wizard must not scan, list or submit through that gap.
  const streamBinding = useStreamRuntimeBinding();
  const streamHostId = streamBinding?.hostId ?? null;
  const readiness = scopedHostReadiness({
    scope,
    hasExplicitPick,
    streamOnPickedHost:
      streamBinding !== null && streamBinding.hostId === scope.hostId,
  });
  const hostReady = readiness === "ready";
  // Asked of the client the scan and the import would actually RUN on: a host
  // that predates session import negotiates the methods away, and without
  // this the dialog would offer a wizard the picked machine cannot serve.
  // `null` client answers "supported"; the readiness gate withholds the
  // wizard in that case anyway.
  const scanSupported = useSessionImportAvailableFor(
    streamBinding?.wsStreamClient ?? null,
  );
  // The scan lives as long as the dialog is open, pauses while a run owns the
  // screen (the wizard retires a finished run on mount, which is what brings
  // the scan back for a second visit), and never runs through the pick gap
  // above - a scan through it would list the wrong machine's sessions.
  const runIdle = useSessionImportRun(streamHostId).status === "idle";
  const scan = useSessionImportScan(runIdle && hostReady && scanSupported);
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
        {/* The pinned filters and footer share the dialog's full width. */}
        <div className="-mx-4 -mb-4 flex min-h-0 flex-1 flex-col">
          {hostReady && scanSupported ? (
            <SessionImportWizard
              surface="dialog"
              scan={scan}
              // Submit means go: the dialog gets out of the way and the
              // app-wide progress toast takes over. Reopening while the run is
              // live shows the inline progress view - this closes a surface,
              // never a run.
              onImportStarted={onClose}
              onTaskOpened={onClose}
              onBeforeTaskOpen={null}
              secondaryAction={{ label: "Close", onSelect: onClose }}
            />
          ) : (
            <SessionImportHostNotice
              scope={scope}
              connecting={readiness === "connecting"}
              refusal={
                hostReady ? `${scope.hostLabel} can't import sessions` : null
              }
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Explain why the entry point's host cannot currently serve the wizard.
 */
function SessionImportHostNotice(props: {
  readonly scope: HostScope;
  readonly connecting: boolean;
  /**
   * A refusal only this dialog can state - "this host is too old to scan" -
   * or `null` for the scope's own states. Set only once the host is otherwise
   * usable, since a host with no client has negotiated nothing to refuse with.
   */
  readonly refusal: string | null;
}): ReactNode {
  const { scope, connecting, refusal } = props;
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      {connecting ? (
        <HostScopeConnecting hostName={scope.hostLabel} />
      ) : (
        <div
          role="status"
          data-testid="session-import-host-unavailable"
          className="flex max-w-[40ch] flex-col items-center gap-2 text-center"
        >
          <p className="text-ui-sm font-medium text-foreground">
            {refusal ??
              (scope.status === "vanished"
                ? `${scope.hostLabel} is no longer connected`
                : `Can't reach ${scope.hostLabel}`)}
          </p>
          <p className="text-ui-sm text-muted-foreground">
            {refusal === null
              ? "Close this wizard and reconnect this host to carry on."
              : "Update this host to import your work."}
          </p>
        </div>
      )}
    </div>
  );
}

import { use, useMemo, useState, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { HostSwitcher } from "@/components/settings/host-scope/host-switcher";
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
 * The wizard as a dialog, with its own host picker. Closing it does not stop
 * an import that has already started (spec §5) - the run belongs to the
 * app-wide controller, and this dialog is only a window onto it.
 *
 * The sessions listed and the run started here belong to ONE machine, and
 * that machine is the one thing about this dialog a person may want to
 * change - the same picker the resources popover and the onboarding tour
 * head their card with. The pick lives in this dialog's own state: it is a
 * choice about this import, and must not leak into Settings' scope or outlive
 * the dialog.
 *
 * Both runtimes are re-provided, and both are needed: the scan and every run
 * started from the wizard ride the STREAM (`StreamRuntimeContext`), while the
 * wizard's unary lookups go through `HostRuntimeContext`. Swapping only one is
 * how a surface reads host B's sessions over host A's transport. They wrap
 * the body UNCONDITIONALLY (the pattern `ResourceMonitorPopover` documents):
 * mounting them only once a pick resolves would change the element type at
 * this position and remount the wizard - and drop the rows the user had
 * ticked - the instant a host was chosen.
 *
 * Safe to re-provide here because the dialog contains no composer and
 * therefore no microphone path (see `useScopedHostBinding`).
 */
export function SessionImportDialog(props: {
  readonly onClose: () => void;
  /**
   * The host the dialog opens on, when the surface that opened it names one:
   * Settings' Host Overview passes the host its page is scoped to, so the
   * picker agrees with the page behind it. `null` follows the app's active
   * host, which is what the announcement toast has to offer.
   */
  readonly initialHostId: string | null;
}) {
  const [scopedHostId, setScopedHostId] = useState<string | null>(
    props.initialHostId,
  );
  const scope = useHostScopeFor({ scopedHostId, setScopedHostId });
  const scopedBinding = useScopedHostBinding(scope);
  const ambientBinding = useHostBinding();
  const scopedStreamBinding = useScopedStreamBinding(scope);
  const ambientStreamBinding = use(StreamRuntimeContext);
  return (
    <HostRuntimeContext.Provider value={scopedBinding ?? ambientBinding}>
      <StreamRuntimeContext.Provider
        value={scopedStreamBinding ?? ambientStreamBinding}
      >
        <SessionImportDialogBody
          scope={scope}
          hasExplicitPick={scopedHostId !== null}
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
        {/* Bled to the dialog's edges so the picker strip, the wizard's pinned
            header and the footer rules run the full width and the footer sits
            flush in the corner - the dialog's chrome, not a panel floating
            inside its padding. */}
        <div className="-mx-4 -mb-4 flex min-h-0 flex-1 flex-col">
          <SessionImportHostPickerRow scope={scope} />
          {hostReady && scanSupported ? (
            <SessionImportWizard
              surface="dialog"
              scan={scan}
              // Submit means go: the dialog gets out of the way and the
              // app-wide progress toast takes over. Reopening while the run is
              // live shows the inline progress view - this closes a surface,
              // never a run.
              onImportStarted={onClose}
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
 * The strip that names the machine, the way the resources popover heads its
 * card: full-bleed on purpose, so the picker's list can drop from it at
 * exactly the dialog's width.
 */
function SessionImportHostPickerRow(props: {
  readonly scope: HostScope;
}): ReactNode {
  const { scope } = props;
  // Every host the import cannot reach, with the word its row would carry if
  // the status column were silent. The row's own status word ("offline",
  // "stopped") speaks first when it has one; this only makes the row inert.
  // A refusal rather than the `pin` intent, which would gate the same rows:
  // `pin` also drops the ACTIVE tag and the "currently viewing" mark, and this
  // dialog has exactly the distinction those carry - following this window's
  // host, or looking at another one - the same way the usage popover does.
  const refusalByHostId = useMemo(
    (): ReadonlyMap<string, string> =>
      new Map(
        scope.hosts
          .filter((host) => !host.connectable)
          .map((host) => [host.hostId, "unreachable"]),
      ),
    [scope.hosts],
  );
  // The host rows are served by a NON-polling observer; the Settings sidebar
  // is normally what opts a window into the liveness poll. Opened from the
  // announcement toast this dialog is the only host-list surface on screen,
  // so it carries the same opt-in for as long as it is up.
  useRegisteredHostsPollLiveness();
  return (
    // Ruled on BOTH edges: the popover's strip sits at the top of its card, but
    // this one sits under the dialog's own title and description, so without
    // the top rule the host name reads as a third line of the header instead
    // of the strip that heads the list.
    <div
      className="flex shrink-0 items-center border-y"
      data-testid="session-import-host-picker-row"
    >
      <HostSwitcher
        hosts={scope.hosts}
        selected={scope.host}
        activeHostId={scope.activeHostId}
        onSelect={scope.setHostId}
        refusalByHostId={refusalByHostId}
        inertExceptHostId={null}
        // No trailing "Manage hosts" row: managing hosts is Settings' job, and
        // this dialog may already be open on top of it. It only picks among
        // the machines that exist.
        action={null}
        surface="panel-header"
        intent="view"
        disabled={false}
        isLoading={scope.isLoading}
        listsFailed={scope.listsFailed}
        onRetryLists={scope.retryLists}
        updateViewForHost={null}
      />
    </div>
  );
}

/**
 * Why the dialog is showing nothing rather than showing another machine's
 * work under the name in the strip above it.
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
              ? "Pick another machine above to carry on."
              : "Update it, or pick another machine above."}
          </p>
        </div>
      )}
    </div>
  );
}

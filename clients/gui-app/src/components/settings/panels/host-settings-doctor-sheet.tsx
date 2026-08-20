import { useState } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDoctorIssue } from "@traycer/protocol/host/maintenance/index";
import { HostDoctorCard } from "@/components/settings/panels/host-doctor-card";
import { HostDoctorRpcCard } from "@/components/settings/panels/host-doctor-rpc-card";
import {
  INITIAL_RECURRENCE_STATE,
  type RecurrenceState,
} from "@/components/settings/panels/host-doctor-recurrence";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { OverviewDegradeReason } from "@/components/settings/panels/host-overview-model";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * Which mechanism produces the report.
 *
 * `rpc` is the ordinary path for every reachable host, local or remote: the
 * host shells its OWN CLI, so the report describes the machine the page names.
 * `bridge` runs the CLI on THIS computer, and survives for exactly one caller —
 * the recovery console, where the local host cannot answer an RPC because it is
 * not running. Reaching for the bridge anywhere else would go back to reporting
 * this computer's diagnostics under another host's name.
 */
export type DoctorSheetSource =
  | {
      readonly kind: "bridge";
      /** This machine's host id, fencing the console's own bridge calls. */
      readonly expectedHostId: string;
    }
  | {
      readonly kind: "rpc";
      readonly client: HostClient<HostRpcRegistry> | null;
      readonly hostName: string;
      readonly isLocalMachine: boolean;
      readonly hasLocalBridge: boolean;
      readonly degrade: OverviewDegradeReason | null;
      /**
       * Whether `host.restart` is servable for this host — the capability
       * itself, so `false` for ANY host whose handshake refused it, remote
       * ones included. Routing on refusal is `bridgeRestartRoute`'s job.
       */
      readonly rpcRestartSupported: boolean;
      /**
       * Whether a refused `host.restart` has the page's bridge respawn to
       * stand in — the SAME derived fact the restart confirm's dispatch leg
       * branches on, threaded so the card cannot route to a confirm whose
       * dispatch would disagree. `false` with `rpcRestartSupported` false
       * means no route at all: the fix degrades to its terminal command.
       */
      readonly bridgeRestartRoute: boolean;
      /** Opens the page's restart confirm, whose confirm dispatches the
       * bridge respawn — never a direct dispatch, the respawn always forces. */
      readonly onBridgeRestart: () => void;
      /** True while that restart write is in flight. */
      readonly bridgeRestartPending: boolean;
      /** Whether `diagnostics.logs.tail` is servable for this host. */
      readonly rpcLogsSupported: boolean;
      /** Reads this machine's host log over the CLI bridge. */
      readonly onBridgeLogs: () => Promise<readonly string[]>;
      /** True while that bridge read is in flight. */
      readonly bridgeLogsPending: boolean;
      /** Runs a local-only repair on this computer via the CLI bridge. */
      readonly onLocalFix: (issue: HostDoctorIssue) => void;
      readonly localFixPendingCode: string | null;
    };

interface DoctorSheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly source: DoctorSheetSource;
}

export function DoctorSheet(props: DoctorSheetProps) {
  const { open, onOpenChange, source } = props;
  const [recurrence, setRecurrence] = useState<RecurrenceState>(
    INITIAL_RECURRENCE_STATE,
  );
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-xl" showCloseButton>
        <SheetHeader>
          <SheetTitle>Host doctor</SheetTitle>
          <SheetDescription>
            {source.kind === "rpc"
              ? `Diagnostics ${source.hostName} ran on itself, with one-click fixes where this app can apply them.`
              : "Diagnostics for the host on this computer, with one-click fixes for common issues."}
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-4 pb-4">
          {/* Mounted only while open, in both branches: the report is produced
              by running a process on the host, so it must be a consequence of
              opening this sheet rather than of the panel rendering. */}
          {open ? (
            <DoctorSheetBody
              source={source}
              recurrence={recurrence}
              onRecurrenceChange={setRecurrence}
            />
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function DoctorSheetBody(props: {
  readonly source: DoctorSheetSource;
  readonly recurrence: RecurrenceState;
  readonly onRecurrenceChange: (next: RecurrenceState) => void;
}) {
  const { source } = props;
  if (source.kind === "bridge") {
    return (
      <HostDoctorCard
        expectedHostId={source.expectedHostId}
        recurrenceState={props.recurrence}
        onRecurrenceChange={props.onRecurrenceChange}
      />
    );
  }
  return (
    <HostDoctorRpcCard
      client={source.client}
      hostName={source.hostName}
      isLocalMachine={source.isLocalMachine}
      hasLocalBridge={source.hasLocalBridge}
      degrade={source.degrade}
      rpcRestartSupported={source.rpcRestartSupported}
      bridgeRestartRoute={source.bridgeRestartRoute}
      onBridgeRestart={source.onBridgeRestart}
      bridgeRestartPending={source.bridgeRestartPending}
      rpcLogsSupported={source.rpcLogsSupported}
      onBridgeLogs={source.onBridgeLogs}
      bridgeLogsPending={source.bridgeLogsPending}
      onLocalFix={source.onLocalFix}
      localFixPendingCode={source.localFixPendingCode}
    />
  );
}

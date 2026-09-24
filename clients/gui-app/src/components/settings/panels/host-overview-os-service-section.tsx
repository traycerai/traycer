import { useState, type ReactNode } from "react";
import type { HostBusyBreakdown } from "@traycer/protocol/host/status/index";
import { describeHostBusy } from "@/components/host/host-restart-copy";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { HOST_OVERVIEW } from "@/components/settings/panels/host-overview.definitions";
import { HostOverviewNotice } from "@/components/settings/panels/host-overview-status-card";
import {
  describeOverviewDegrade,
  type OverviewDegradeReason,
} from "@/components/settings/panels/host-overview-model";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SETTINGS_ROW_STACK } from "@/components/settings/settings-row-layout";
import { cn } from "@/lib/utils";
import { useSettingsDensity } from "@/providers/settings-density-context";

/**
 * The OS service registration, restored — and for every host, not just the one
 * on this desk.
 *
 * Re-register and Deregister used to be local-CLI-bridge calls, which is why
 * they vanished when the Overview replaced the bridge page for all hosts:
 * there was no way to ask a remote machine. `host.service.*` is that way. It
 * matters most for a headless box, where the alternative to this section is an
 * SSH session.
 *
 * The two buttons are NOT symmetric and are not presented as such. Registering
 * leaves a supervised host running. Deregistering stops the host and does not
 * bring it back — on a remote machine that is a one-way door out of the UI, so
 * it is destructive-styled and confirmed, with copy that says so plainly.
 *
 * PURELY PRESENTATIONAL, and that is load-bearing rather than tidy. Two callers
 * drive this from genuinely different places — the Overview over
 * `host.service.*`, the recovery console over the local CLI bridge, which is the
 * only one that can answer when there is no host process to ask. Holding the
 * RPC hooks in here would have forced the console to keep its own copy of the
 * section, which is exactly the duplication that let the offline surface drift
 * a full redesign behind the online one.
 */
export interface OsServiceSectionProps {
  readonly hostName: string;
  /** The registration, in a sentence. The ADAPTER decides the wording. */
  readonly description: string;
  /** `<label> · <manifestPath>`, or `null` when the source cannot say. */
  readonly manifestLine: string | null;
  /** Retires the whole section: no description to trust, nothing safe to press. */
  readonly degrade: OverviewDegradeReason | null;
  readonly canRegister: boolean;
  readonly canDeregister: boolean;
  /**
   * Nothing is registered, so there is nothing to remove.
   *
   * Distinct from "we could not find out". An unknown registration leaves
   * Deregister ENABLED on purpose: removing an already-absent service is
   * idempotent, and disabling on unknown state would block the repair on
   * precisely the hosts whose registration is broken enough not to answer.
   */
  readonly nothingToDeregister: boolean;
  readonly registerPending: boolean;
  readonly deregisterPending: boolean;
  readonly busy: boolean;
  /**
   * What the host said is working, `null`/false while unsettled. The register
   * CONFIRM names it: on macOS re-registering bootouts the running job before
   * bootstrapping it again, ending that work without ever consulting the
   * busy-session refusal the restart flow enforces.
   */
  readonly settledBusy: boolean;
  readonly settledBusySessionCount: number | null;
  readonly settledBusyBreakdown: HostBusyBreakdown | null;
  readonly onRegister: () => void;
  readonly onDeregister: () => void;
}

export function OsServiceSection(props: OsServiceSectionProps): ReactNode {
  return (
    <SettingsGroup
      group={HOST_OVERVIEW.definitions.osService}
      showTitle
      tone="default"
      dataTestId="host-overview-service"
      fill={false}
    >
      {/* One gate for the whole group: without a trustworthy description
          there is nothing to act on, and acting on a registration you cannot
          see is how someone deregisters a host they believed was already
          unmanaged. The standard sentence replaces the group's contents; the
          label stays, since "doesn't support this yet" needs a "this". */}
      {props.degrade === null ? (
        <OsServiceRow {...props} />
      ) : (
        <HostOverviewNotice testId="host-overview-service-degraded">
          {describeOverviewDegrade(props.degrade, props.hostName)}
        </HostOverviewNotice>
      )}
    </SettingsGroup>
  );
}

/**
 * The registration in a sentence, the manifest line under it, and the two
 * repair verbs at the row's trailing edge - a settings row's geometry, so the
 * verbs drop under the sentence on a narrow pane rather than squeeze it.
 */
function OsServiceRow(props: OsServiceSectionProps): ReactNode {
  const compact = useSettingsDensity() === "compact";
  const [confirmDeregister, setConfirmDeregister] = useState(false);
  const [confirmRegister, setConfirmRegister] = useState(false);

  const anyPending =
    props.registerPending || props.deregisterPending || props.busy;

  // A confirmation that outlives the state it asked about is a stale
  // question: these dialogs close BEFORE dispatching, so an armed page-wide
  // gate while one is open can only mean some OTHER lifecycle operation
  // (an automatic install, a restart) began after it opened. Its description
  // — session counts included — no longer describes the world, and its
  // confirm button would dispatch into the very operation the gate protects.
  // Close it; the reopen path is a button `anyPending` already disables.
  // Adjust-during-render, not an effect: the close must land in the same
  // commit the gate arms in, not a frame later.
  if (anyPending && (confirmRegister || confirmDeregister)) {
    setConfirmRegister(false);
    setConfirmDeregister(false);
  }

  return (
    <div
      className={cn(
        "flex flex-wrap items-start justify-between gap-x-6 gap-y-2",
        SETTINGS_ROW_STACK.container,
        compact ? "px-4 py-2.5" : "px-5 py-4",
      )}
    >
      <div
        className={cn(
          "flex min-w-[50%] flex-1 flex-col gap-1",
          SETTINGS_ROW_STACK.label,
        )}
      >
        <p
          className="text-ui-sm text-foreground"
          data-testid="host-overview-service-description"
        >
          {props.description}
        </p>
        {props.manifestLine === null ? null : (
          <p
            className="font-mono text-code-xs break-all text-muted-foreground"
            data-testid="host-overview-service-manifest"
          >
            {props.manifestLine}
          </p>
        )}
      </div>
      <div
        className={cn(
          "flex flex-wrap items-center gap-2",
          SETTINGS_ROW_STACK.control,
        )}
      >
        {!props.canRegister ? null : (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={anyPending}
            data-testid="host-overview-service-register"
            // Confirmed, always: on macOS this bootouts the running job before
            // bootstrapping it again - a host restart wearing repair clothes -
            // and it does so WITHOUT the busy-session refusal the restart flow
            // gets, so the dialog is where the open-session fact is put in
            // front of the person about to end them.
            onClick={() => setConfirmRegister(true)}
          >
            {props.registerPending ? (
              <AgentSpinningDots
                className="mr-2 size-3"
                testId={undefined}
                variant={undefined}
              />
            ) : null}
            Re-register
          </Button>
        )}
        {!props.canDeregister ? null : (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={anyPending || props.nothingToDeregister}
            data-testid="host-overview-service-deregister"
            onClick={() => setConfirmDeregister(true)}
          >
            {props.deregisterPending ? (
              <AgentSpinningDots
                className="mr-2 size-3"
                testId={undefined}
                variant={undefined}
              />
            ) : null}
            Deregister
          </Button>
        )}
      </div>
      <ConfirmDestructiveDialog
        blockedReason={null}
        open={confirmRegister}
        onOpenChange={(next) => {
          if (!next) setConfirmRegister(false);
        }}
        title="Re-register this host's OS service?"
        description={describeRegisterConfirm({
          hostName: props.hostName,
          settledBusy: props.settledBusy,
          settledBusySessionCount: props.settledBusySessionCount,
          settledBusyBreakdown: props.settledBusyBreakdown,
        })}
        cascadeSummary={null}
        actionLabel="Re-register"
        isPending={props.registerPending}
        onConfirm={() => {
          setConfirmRegister(false);
          props.onRegister();
        }}
      />
      <ConfirmDestructiveDialog
        blockedReason={null}
        open={confirmDeregister}
        onOpenChange={(next) => {
          if (!next) setConfirmDeregister(false);
        }}
        title="Deregister this host's OS service?"
        description={`This stops ${props.hostName} and removes the registration that starts it again at login. Nothing is uninstalled and no data is deleted — but Traycer cannot start this host again from here, so bringing it back means running 'traycer host service install' on the machine itself.`}
        cascadeSummary={null}
        actionLabel="Deregister"
        isPending={props.deregisterPending}
        onConfirm={() => {
          setConfirmDeregister(false);
          props.onDeregister();
        }}
      />
    </div>
  );
}

/**
 * The register confirm's body, sized to what is known about work on the host.
 * A null helper sentence is NOT idle: a host that has not said it is idle
 * gets the hedged sentence, never a claim that nothing is running.
 */
function describeRegisterConfirm(input: {
  readonly hostName: string;
  readonly settledBusy: boolean;
  readonly settledBusySessionCount: number | null;
  readonly settledBusyBreakdown: HostBusyBreakdown | null;
}): string {
  const restart = `Re-registering restarts ${input.hostName}: its OS service is booted out and registered again.`;
  const copy = describeHostBusy({
    breakdown: input.settledBusyBreakdown,
    busySessionCount: input.settledBusySessionCount,
    busy: input.settledBusy,
  });
  if (copy.sentence === null) {
    return `${restart} Any work running on it right now will be interrupted.`;
  }
  return `${restart} ${copy.sentence}`;
}

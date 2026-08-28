import { useState, type ReactNode } from "react";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import type { HostBusyBreakdown } from "@traycer/protocol/host/status/index";
import { describeHostBusy } from "@/components/host/host-restart-copy";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { HostAutoUpdateRow } from "@/components/settings/host-scope/host-registry-updates";
import type { UpdateHostVersionPolicyMutation } from "@/components/settings/host-scope/use-host-registry-update-mutation";
import { HostOverviewNotice } from "@/components/settings/panels/host-overview-status-card";
import { HostSettingsDisclosure } from "@/components/settings/panels/host-settings-disclosure";
import {
  HostVersionRows,
  type HostVersionRow,
} from "@/components/settings/panels/host-version-rows";
import {
  describeOverviewDegrade,
  type OverviewDegradeReason,
} from "@/components/settings/panels/host-overview-model";

/**
 * Everything about updates a person opens a disclosure to find.
 *
 * This is the surface the Overview restructure lost. The bridge-backed page it
 * replaced kept the auto-update policy, the OS service registration, the
 * release-candidate filter and the full version list behind one collapsed
 * **Advanced** section, and the replacement hoisted the version list into the
 * card body — permanently expanded, eleven rows tall, with no way to put it away
 * — while the other three simply went. The identity card's job is "is there an
 * update, and install it"; everything that is a decision rather than an answer
 * belongs here, closed by default.
 *
 * Lives in the Installation group rather than under the summary row it serves.
 * Both halves of the update story are still one hook instance up at page level,
 * so nothing about that placement can put them out of step — and every control
 * in here is about how this host is SET UP, which is what that group already
 * collects.
 *
 * The one thing deliberately NOT moved in is the drain-gate force ("Apply now —
 * ends N sessions"). It renders only while an update is actually blocked on open
 * sessions, and a control with a deadline must not be behind a collapsed
 * disclosure.
 */
export function HostOverviewAdvancedDisclosure(props: {
  readonly hostName: string;
  /** `null` for a host with no account registry row — then no policy row. */
  readonly registryItem: HostListItem | null;
  readonly policyMutation: UpdateHostVersionPolicyMutation | null;
  /**
   * The OS service section, already resolved by a caller's adapter — or `null`
   * to withhold it entirely.
   *
   * `null` rather than a degrade when there is no route: `OverviewDegradeReason`
   * describes what a REACHABLE host cannot do, and borrowing it for "cannot be
   * reached" would state a capability verdict the handshake never returned. The
   * page already says the host is unreachable, once, on the identity card.
   */
  readonly service: OsServiceSectionProps | null;
  /** The version picker's whole state, owned by the card so both halves agree. */
  readonly versions: VersionPickerProps | null;
}): ReactNode {
  return (
    // No border wrapper. This sits in the Installation group as a sibling of
    // `InstallationDetailsDisclosure`, and `HostSettingsDisclosure` already
    // separates a stack of itself with `border-b … last:border-b-0`.
    //
    // It DID carry a `border-t` wrapper while it was the last band under the
    // update summary row, which separates with a top border instead. That
    // wrapper is actively wrong here twice over: it draws a second line under
    // the sibling's bottom border, and — because `last:` resolves against the
    // wrapper rather than the group — it silently suppressed the bottom border
    // on whichever disclosure preceded it.
    <HostSettingsDisclosure label="Advanced" defaultOpen={false}>
      <div className="flex flex-col gap-6">
        {props.registryItem === null || props.policyMutation === null ? null : (
          <HostAutoUpdateRow
            item={props.registryItem}
            mutation={props.policyMutation}
            className=""
          />
        )}
        {props.service === null ? null : (
          <OsServiceSection {...props.service} />
        )}
        {props.versions === null ? null : <VersionPicker {...props.versions} />}
      </div>
    </HostSettingsDisclosure>
  );
}

export interface VersionPickerProps {
  readonly rows: readonly HostVersionRow[];
  readonly totalCount: number;
  readonly showAll: boolean;
  readonly onToggleShowAll: () => void;
  /**
   * What the catalog actually did — the host's resolved inclusion until the
   * user overrides it, not a preference this checkbox owns.
   */
  readonly includePreReleases: boolean;
  readonly onIncludePreReleasesChange: (value: boolean) => void;
  /**
   * Why the catalog resolved that way, when it is worth saying. Non-null only
   * for a host that derived inclusion from its own installed release
   * candidate; see `describeIncludePreReleasesSource`.
   */
  readonly includePreReleasesExplanation: string | null;
  readonly installingVersion: string | null;
  readonly disabled: boolean;
  readonly onInstall: (version: string) => void;
  /** True before the first check has answered — no list to show yet. */
  readonly awaitingFirstCheck: boolean;
  readonly checking: boolean;
}

/**
 * "Pick a different version" — the list the card body used to hold open.
 *
 * The RC checkbox re-asks the HOST rather than filtering a list already in hand,
 * which is why it is here and not a client-side predicate: `host available`
 * decides what counts as a pre-release, and reimplementing that judgement in the
 * renderer would disagree with the CLI the first time a build id stopped being
 * semver.
 */
function VersionPicker(props: VersionPickerProps): ReactNode {
  return (
    <div
      className="flex flex-col gap-3"
      data-testid="host-overview-version-picker"
    >
      <div className="flex flex-col gap-0.5">
        <div className="font-medium text-foreground">
          Pick a different version
        </div>
        {/* No rolling-back claim: every row OLDER than the installed host is
            deliberately disabled (`supersededReason`), and the CLI would
            short-circuit such an install anyway — advertising rollback here
            misleads exactly the person who opened this picker to escape a bad
            upgrade. */}
        <p className="text-ui-sm text-muted-foreground">
          Install a specific newer host version — useful for stepping up to a
          release candidate or a hotfix ahead of auto-update.
        </p>
      </div>
      <div className="flex items-start gap-2 text-ui-sm text-muted-foreground">
        <Checkbox
          id="host-overview-include-pre-releases"
          aria-label="Include release candidates"
          checked={props.includePreReleases}
          // The page-wide gate too, not only the in-flight check: toggling
          // changes the query key and immediately spawns another
          // `host.update.check` CLI process - against a host that may be
          // restarting, shutting down, or mid-swap while the gate is up.
          disabled={props.checking || props.disabled}
          onCheckedChange={(value) =>
            props.onIncludePreReleasesChange(value === true)
          }
        />
        <label
          htmlFor="host-overview-include-pre-releases"
          className="flex min-w-0 cursor-pointer flex-col gap-0.5 select-none"
        >
          <span className="text-foreground">Include release candidates</span>
          <span>Show RC host versions when choosing a version.</span>
          {/* Provenance, and worded as a fact about the host rather than a
              setting: there is no stored preference behind this state, so copy
              implying one would point at a switch that does not exist. */}
          {props.includePreReleasesExplanation !== null ? (
            <span data-testid="host-overview-include-pre-releases-reason">
              {props.includePreReleasesExplanation}
            </span>
          ) : null}
        </label>
      </div>
      {props.awaitingFirstCheck ? (
        <p className="text-ui-sm text-muted-foreground">
          {props.checking
            ? "Asking this host which versions it can install…"
            : // Not "Check for updates to see…" any more. The list asks by
              // itself now, so reaching this line means the ask came back
              // without one — and pointing at a button that has already run is
              // how the empty state read as the user's fault. The summary row
              // above carries the actual reason.
              "This host didn't return a list of installable versions."}
        </p>
      ) : (
        <HostVersionRows
          rows={props.rows}
          totalCount={props.totalCount}
          showAll={props.showAll}
          onToggleShowAll={props.onToggleShowAll}
          installingVersion={props.installingVersion}
          // `checking` too, not only the page-wide busy: while a filter toggle
          // refetches, `keepPreviousData` keeps the OLD filter's rows on
          // screen — freezing them is what stops an excluded RC from being
          // installable in the gap after unchecking the option.
          disabled={props.disabled || props.checking}
          onInstall={props.onInstall}
        />
      )}
    </div>
  );
}

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

function OsServiceSection(props: OsServiceSectionProps): ReactNode {
  const [confirmDeregister, setConfirmDeregister] = useState(false);
  const [confirmRegister, setConfirmRegister] = useState(false);

  // One gate for the whole section: without a trustworthy description there is
  // nothing to act on, and acting on a registration you cannot see is how
  // someone deregisters a host they believed was already unmanaged.
  if (props.degrade !== null) {
    return (
      <div className="flex flex-col gap-3">
        <OsServiceHeading description={null} />
        <HostOverviewNotice testId="host-overview-service-degraded">
          {describeOverviewDegrade(props.degrade, props.hostName)}
        </HostOverviewNotice>
      </div>
    );
  }

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
    <div className="flex flex-col gap-3">
      <OsServiceHeading description={props.description} />
      {props.manifestLine === null ? null : (
        <p
          className="font-mono text-code-xs break-all text-muted-foreground"
          data-testid="host-overview-service-manifest"
        >
          {props.manifestLine}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
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

function OsServiceHeading(props: {
  readonly description: string | null;
}): ReactNode {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="font-medium text-foreground">OS service</div>
      {props.description === null ? null : (
        <p
          className="text-ui-sm text-muted-foreground"
          data-testid="host-overview-service-description"
        >
          {props.description}
        </p>
      )}
    </div>
  );
}

import { useState, type ReactNode } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import {
  HostVersionRows,
  type HostVersionRow,
} from "@/components/settings/panels/host-version-rows";

export interface VersionPickerProps {
  readonly rows: readonly HostVersionRow[];
  readonly storeFloorNotice: boolean;
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
  readonly onInstall: (version: string, acceptStoreFormatLoss: boolean) => void;
  /** True before the first check has answered — no list to show yet. */
  readonly awaitingFirstCheck: boolean;
  readonly checking: boolean;
}

/**
 * "Pick a different version" — the list the card body used to hold open, and
 * then Installation's Advanced disclosure held shut. It is the Updates tab's
 * now, shown open, where a tab of its own puts it one click from the answer on
 * Status without burying that answer.
 *
 * The RC checkbox re-asks the HOST rather than filtering a list already in hand,
 * which is why it is here and not a client-side predicate: `host available`
 * decides what counts as a pre-release, and reimplementing that judgement in the
 * renderer would disagree with the CLI the first time a build id stopped being
 * semver.
 */
export function VersionPicker(props: VersionPickerProps): ReactNode {
  const [confirmingVersion, setConfirmingVersion] = useState<string | null>(
    null,
  );
  const confirmation = props.rows.find(
    (row) => row.version === confirmingVersion,
  );
  const confirmationBody = confirmation?.storeFormatConfirmation ?? null;
  // A catalog/status refresh can withdraw the offer or finish the survey.
  // Clear the selection immediately so an old confirmation cannot reappear
  // later for a different observation of the same version.
  if (confirmingVersion !== null && confirmationBody === null) {
    setConfirmingVersion(null);
  }
  return (
    <div
      className="flex flex-col gap-3"
      data-testid="host-overview-version-picker"
    >
      <div className="flex flex-col gap-0.5">
        <div className="font-medium text-foreground">
          Pick a different version
        </div>
        <p className="text-ui-sm text-muted-foreground">
          Install a specific host version — upgrade to a release candidate or
          hotfix, or downgrade to an earlier release.
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
      {props.storeFloorNotice ? (
        <p role="status" className="text-ui-sm text-muted-foreground">
          Older versions that can't open this device's chat stores can still be
          installed with Install anyway, at the cost of access to those chats
          until the host is updated again.
        </p>
      ) : null}
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
          onInstall={(version) => props.onInstall(version, false)}
          onInstallAnyway={setConfirmingVersion}
        />
      )}
      <ConfirmDestructiveDialog
        open={confirmingVersion !== null && confirmationBody !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmingVersion(null);
        }}
        title={`Install v${confirmingVersion ?? ""} and lose access to newer chats?`}
        description={confirmationBody ?? ""}
        cascadeSummary={null}
        actionLabel="Install anyway"
        isPending={props.installingVersion !== null}
        blockedReason={
          props.disabled || props.checking
            ? "Wait for this device's current operation to finish."
            : null
        }
        onConfirm={() => {
          if (confirmingVersion === null || confirmationBody === null) return;
          props.onInstall(confirmingVersion, true);
          setConfirmingVersion(null);
        }}
      />
    </div>
  );
}

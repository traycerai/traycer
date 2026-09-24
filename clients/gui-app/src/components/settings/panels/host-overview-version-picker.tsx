import { useState, type ReactNode } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import {
  HostVersionRows,
  type HostVersionRow,
} from "@/components/settings/panels/host-version-rows";
import { cn } from "@/lib/utils";

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
  /** The same forced check used by the Status answer. */
  readonly onCheck: () => void;
  /** One failure state shared with the Status answer. */
  readonly failureDescription: string | null;
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
      className="flex flex-col gap-2"
      data-testid="host-overview-version-picker"
    >
      <div className="font-medium text-foreground">
        Pick a different version
      </div>
      <div className="overflow-hidden rounded-md border border-border/40">
        <div className="flex flex-col gap-3 px-4 py-3">
          <p className="text-ui-sm text-muted-foreground">
            Install a specific host version — upgrade to a release candidate or
            hotfix, or downgrade to an earlier release.
          </p>
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
              <span className="text-foreground">
                Include release candidates
              </span>
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
        </div>
        {props.storeFloorNotice ? (
          <p
            role="status"
            className="border-t border-border/40 px-4 py-3 text-ui-sm text-muted-foreground"
          >
            Older versions that can't open this device's chat stores can still
            be installed with Install anyway, at the cost of access to those
            chats until the host is updated again.
          </p>
        ) : null}
        <VersionPickerList
          picker={props}
          onInstallAnyway={setConfirmingVersion}
        />
      </div>
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

function VersionPickerList(input: {
  readonly picker: VersionPickerProps;
  readonly onInstallAnyway: (version: string) => void;
}): ReactNode {
  const { picker } = input;
  const noListState = picker.checking ? (
    <div className="flex items-center gap-2 text-ui-sm text-muted-foreground">
      <AgentSpinningDots
        className="size-3"
        testId={undefined}
        variant={undefined}
      />
      Asking this host which versions it can install…
    </div>
  ) : (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-ui-sm text-muted-foreground">
        This host didn't return a list of installable versions.
      </p>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={picker.disabled}
        onClick={picker.onCheck}
        data-testid="host-overview-version-check"
      >
        Check now
      </Button>
    </div>
  );
  return (
    <div
      className={cn(
        "flex flex-col gap-3 border-t border-border/40 px-4 py-3",
        // HostVersionRows includes Show all after its list. Keep the
        // refusal against the rows, before that secondary list control.
        !picker.awaitingFirstCheck &&
          picker.rows.length > 0 &&
          "[&>div]:order-2",
      )}
    >
      {picker.awaitingFirstCheck ? (
        noListState
      ) : (
        <HostVersionRows
          rows={picker.rows}
          totalCount={picker.totalCount}
          showAll={picker.showAll}
          onToggleShowAll={picker.onToggleShowAll}
          installingVersion={picker.installingVersion}
          // `checking` too, not only the page-wide busy: while a filter toggle
          // refetches, `keepPreviousData` keeps the OLD filter's rows on
          // screen — freezing them is what stops an excluded RC from being
          // installable in the gap after unchecking the option.
          disabled={picker.disabled || picker.checking}
          onInstall={(version) => picker.onInstall(version, false)}
          onInstallAnyway={input.onInstallAnyway}
        />
      )}
      {picker.awaitingFirstCheck ||
      picker.rows.length === 0 ||
      picker.failureDescription === null ? null : (
        <p
          role="alert"
          className="order-1 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-sm text-destructive-foreground"
          data-testid="host-overview-version-install-refused"
        >
          {picker.failureDescription}
        </p>
      )}
    </div>
  );
}

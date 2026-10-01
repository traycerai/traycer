import { useId, useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
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
  /**
   * THIS machine's host was started in a terminal: what the list says in
   * place of an install, or `null`. The answer card's Update now line
   * (`hostForegroundUpdateLine`) - an explicit version is still an update the
   * CLI refuses over that run, so every row's install is withheld with it.
   */
  readonly foregroundUpdateLine: string | null;
  readonly onInstall: (version: string, acceptStoreFormatLoss: boolean) => void;
  /** True before the first check has answered — no list to show yet. */
  readonly awaitingFirstCheck: boolean;
  readonly checking: boolean;
  /**
   * The forced check behind Check now: it re-asks the ONE shared query, so
   * the list and the answer card above it refresh together.
   */
  readonly onCheck: () => void;
  /** One failure state shared with the answer card. */
  readonly failureDescription: string | null;
}

/**
 * "Pick a different version" — the list the card body used to hold open, and
 * then Installation's Advanced disclosure held shut. It is the Updates tab's
 * now, shown open, under the answer card and the auto-update switch.
 *
 * Its heading carries the page's one Check now. The check asks the host for
 * this very catalog, so the button sits on the list it refreshes; the answer
 * card above reads the same query and moves with it. Hidden, not disabled,
 * while an update is in flight (`checkNowShown`), like the answer card.
 *
 * The RC checkbox re-asks the HOST rather than filtering a list already in hand,
 * which is why it is here and not a client-side predicate: `host available`
 * decides what counts as a pre-release, and reimplementing that judgement in the
 * renderer would disagree with the CLI the first time a build id stopped being
 * semver.
 */
export function VersionPicker(
  props: VersionPickerProps & {
    /** `false` while an update runs, waits or restarts. */
    readonly checkNowShown: boolean;
  },
): ReactNode {
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
      <div className="flex min-h-7 flex-wrap items-center justify-between gap-2">
        <div className="font-medium text-foreground">
          Pick a different version
        </div>
        {props.checkNowShown ? (
          <CheckNowButton
            checking={props.checking}
            disabled={props.disabled}
            onCheck={props.onCheck}
          />
        ) : null}
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
          props.foregroundUpdateLine ??
          (props.disabled || props.checking
            ? "Wait for this device's current operation to finish."
            : null)
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

/**
 * The page's one Check now. The refresh glyph gives way to the spinner while
 * the check runs; the label never changes.
 */
function CheckNowButton(props: {
  readonly checking: boolean;
  readonly disabled: boolean;
  readonly onCheck: () => void;
}): ReactNode {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={props.checking || props.disabled}
      data-testid="host-overview-update-check"
      onClick={props.onCheck}
    >
      {props.checking ? (
        <AgentSpinningDots
          className="size-3.5"
          testId={undefined}
          variant={undefined}
        />
      ) : (
        <RefreshCw data-icon="inline-start" aria-hidden />
      )}
      Check now
    </Button>
  );
}

function VersionPickerList(input: {
  readonly picker: VersionPickerProps;
  readonly onInstallAnyway: (version: string) => void;
}): ReactNode {
  const { picker } = input;
  const foregroundLineId = useId();
  const listShown = !picker.awaitingFirstCheck && picker.rows.length > 0;
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
    // Check now is on the heading directly above; no second copy here.
    <p className="text-ui-sm text-muted-foreground">
      This host didn't return a list of installable versions.
    </p>
  );
  return (
    <div
      className={cn(
        "flex flex-col gap-3 border-t border-border/40 px-4 py-3",
        // HostVersionRows includes Show all after its list. Keep the
        // refusal against the rows, before that secondary list control.
        listShown && "[&>div]:order-2",
      )}
    >
      {listShown && picker.foregroundUpdateLine !== null ? (
        <p
          id={foregroundLineId}
          className="text-ui-sm text-muted-foreground"
          data-testid="host-overview-version-foreground"
        >
          {picker.foregroundUpdateLine}
        </p>
      ) : null}
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
          disabled={
            picker.disabled ||
            picker.checking ||
            picker.foregroundUpdateLine !== null
          }
          describedBy={
            picker.foregroundUpdateLine === null ? null : foregroundLineId
          }
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

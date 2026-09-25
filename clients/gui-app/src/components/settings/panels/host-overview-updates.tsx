/**
 * Docs: see ../SETTINGS.md (Host ▸ Overview ▸ Status ▸ Version card).
 * Update that file whenever this settings surface changes.
 */
import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  describeOverviewDegrade,
  type OverviewDegradeReason,
} from "@/components/settings/panels/host-overview-model";
import {
  PICK_IN_UPDATES,
  type HostOverviewUpdatesSummary,
} from "@/components/settings/panels/host-overview-updates-state";
import {
  HOST_OVERVIEW_VERSION_TAG,
  type HostOverviewVersionTag,
} from "@/components/settings/panels/host-overview-status-model";
import { useHostOverviewSelectTab } from "@/components/settings/panels/host-overview-tab-state";
import { CliFloorRemedyActions } from "@/components/settings/panels/host-overview-cli-floor-remedy-actions";
import { formatHostVersion } from "@/components/settings/host-scope/host-scope-model";
import type { DesktopAppUpdatesBridge } from "@/lib/windows/types";
import { cn } from "@/lib/utils";

/** The update answer and its controls, as the page resolved them. */
export interface HostOverviewVersionAnswer {
  readonly summary: HostOverviewUpdatesSummary;
  readonly degrade: OverviewDegradeReason | null;
  readonly desktopBridge: DesktopAppUpdatesBridge | null;
  readonly onInstallationHelp: () => void;
}

/**
 * Status ▸ Version card: the running version, one tag, the update answer and
 * at most two buttons.
 *
 * The buttons (Update now, Check now) show only while nothing is in flight.
 * While an update runs, waits or restarts the card shows its version and tag
 * and nothing to press - HIDDEN, not disabled, so the tab never shows a
 * button that cannot be pressed. They come back when the update finishes or
 * fails. The answer sentence goes with them, because the catalog's answer
 * mid-update ("v1.5.1 is available.") contradicts the update card above it.
 * Activation debt's answer stays ("v1.5.1 is installed — restart host to
 * finish."), since it is about the wait itself.
 *
 * The CLI-tools fix replaces Update now, here and only here: the update
 * card's floor sentence points at this card's Show installation help and
 * never carries a fix of its own. It is NOT held to the in-flight rule, and
 * its sentence stays with it. It is a fix for the tools, not a control over
 * the update in flight; a park can be waiting on exactly it; and the page
 * rechecks the catalog every 30 s for as long as a floor applies
 * (`useHostOverviewUpdates`' recheck), which is only honest while the fix
 * that recheck is for is on screen.
 */
export function HostOverviewVersionCard(props: {
  /** The running version, as the header's health line states it. */
  readonly version: string | null;
  readonly tag: HostOverviewVersionTag | null;
  /**
   * The answer; `null` while the host can't be reached or is still
   * connecting, when the card is its version, its tag and the caption.
   */
  readonly answer: HostOverviewVersionAnswer | null;
  /** An update is running, waiting or restarting. */
  readonly inFlight: boolean;
  /**
   * The auto-update caption, or `null` for none. The page withholds it when
   * the account does not know this host, when updates are not manageable
   * here, and while an update is in flight on a reachable host.
   */
  readonly autoUpdate: "on" | "off" | null;
}): ReactNode {
  const version = formatHostVersion(props.version);
  const tag = props.tag === null ? null : HOST_OVERVIEW_VERSION_TAG[props.tag];
  return (
    <section
      aria-label="Version"
      className="flex flex-col rounded-lg border border-border/60 bg-foreground/3"
      data-testid="host-overview-version-card"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        {/* The size of the host's name: the page's one version, stated as
            prominently as the host it belongs to. */}
        <span
          className="font-mono font-semibold text-foreground text-title-sm"
          data-testid="host-overview-version"
        >
          {version ?? "Unknown version"}
        </span>
        {tag === null ? null : (
          <Badge
            variant={tag.tone}
            data-testid="host-overview-version-tag"
            data-tag={props.tag ?? ""}
          >
            {tag.label}
          </Badge>
        )}
        {props.answer === null || props.answer.degrade !== null ? null : (
          <VersionCardControls
            answer={props.answer}
            inFlight={props.inFlight}
          />
        )}
      </div>
      {props.answer === null ? null : (
        <VersionCardAnswer answer={props.answer} inFlight={props.inFlight} />
      )}
      {props.autoUpdate === null ? null : (
        <AutoUpdateCaption state={props.autoUpdate} />
      )}
    </section>
  );
}

function VersionCardControls(props: {
  readonly answer: HostOverviewVersionAnswer;
  readonly inFlight: boolean;
}): ReactNode {
  const { summary } = props.answer;
  // In flight, only the fix survives; with no fix there is nothing to draw.
  if (props.inFlight && summary.remedy === null) return null;
  return (
    <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
      {summary.remedy !== null ? (
        <CliFloorRemedyActions
          actions={summary.remedy.actions}
          desktopBridge={props.answer.desktopBridge}
          onHelp={props.answer.onInstallationHelp}
        />
      ) : (
        <UpdateNowControl summary={summary} />
      )}
      {props.inFlight ? null : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={summary.checking || summary.busy}
          data-testid="host-overview-update-check"
          onClick={summary.onCheck}
        >
          {summary.checking ? (
            <AgentSpinningDots
              className="mr-2 size-3"
              testId={undefined}
              variant={undefined}
            />
          ) : null}
          Check now
        </Button>
      )}
    </div>
  );
}

/** Update now, only when there is a newer version this host can install. */
function UpdateNowControl(props: {
  readonly summary: HostOverviewUpdatesSummary;
}): ReactNode {
  const { summary } = props;
  if (summary.updatableVersion === null) return null;
  return (
    <Button
      type="button"
      variant="default"
      size="sm"
      disabled={summary.busy || summary.installing || summary.checking}
      data-testid="host-overview-update-now"
      onClick={summary.onUpdateLatest}
    >
      {summary.installing ? (
        <AgentSpinningDots
          className="mr-2 size-3"
          testId={undefined}
          variant={undefined}
        />
      ) : null}
      Update now
    </Button>
  );
}

function VersionCardAnswer(props: {
  readonly answer: HostOverviewVersionAnswer;
  readonly inFlight: boolean;
}): ReactNode {
  const { summary, degrade } = props.answer;
  // Not manageable here: one sentence in place of the buttons.
  if (degrade !== null) {
    return (
      <CardNote
        className="border-t border-border/40 py-2.5 text-muted-foreground"
        testId="host-overview-updates-degraded"
      >
        {describeOverviewDegrade(degrade, summary.hostName)}
      </CardNote>
    );
  }
  const answerShown =
    !props.inFlight ||
    summary.answerKind === "restart-to-finish" ||
    summary.remedy !== null;
  return (
    <div className="flex flex-col" data-testid="host-overview-updates">
      {/* `role="status"`: the check runs on its own now, so this sentence
          changes with no user action to anchor it — a live region is the
          only way a screen-reader user learns a check started or failed. */}
      {answerShown ? (
        <p
          role="status"
          className="border-t border-border/40 px-4 py-2.5 text-ui-sm text-muted-foreground"
        >
          <AnswerSentence summary={summary} />
        </p>
      ) : null}
      {/* The one line a refused or failed attempt adds under the answer. It
          clears on the next try; the answer beside it stays the catalog's.
          NOT held to the in-flight rule: a refused Force update… is answered
          during the very park that counts as in flight, and the dialog that
          asked closes on the refusal expecting this line to say why. A polite
          live region, since the answer's own no longer repeats the failure. */}
      <div aria-live="polite">
        {summary.failureDescription === null ? null : (
          <CardNote
            className={cn(
              "text-destructive",
              answerShown ? "pb-2.5" : "border-t border-border/40 py-2.5",
            )}
            testId="host-overview-update-attempt-failed"
          >
            {summary.failureDescription}
          </CardNote>
        )}
      </div>
    </div>
  );
}

/** One line of the card with the notice glyph: a failure, or "not here". */
function CardNote(props: {
  readonly className: string;
  readonly testId: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div
      className={cn("flex items-start gap-2 px-4 text-ui-xs", props.className)}
      data-testid={props.testId}
    >
      <Info className="mt-px size-3.5 shrink-0" aria-hidden />
      <span className="max-w-[68ch]">{props.children}</span>
    </div>
  );
}

/**
 * The answer, with "Pick it in Updates" drawn as the link to that tab when
 * the sentence carries it. The text stays one string, so the live region reads
 * the same sentence the summary states.
 */
function AnswerSentence(props: {
  readonly summary: HostOverviewUpdatesSummary;
}): ReactNode {
  const selectTab = useHostOverviewSelectTab();
  const text = props.summary.description;
  const at = text.indexOf(PICK_IN_UPDATES);
  if (props.summary.answerKind !== "stranded" || at < 0 || selectTab === null) {
    return text;
  }
  return (
    <>
      {text.slice(0, at)}
      <Button
        type="button"
        variant="link"
        size="inline"
        data-testid="host-overview-pick-in-updates"
        onClick={() => selectTab("updates")}
      >
        {PICK_IN_UPDATES}
      </Button>
      {text.slice(at + PICK_IN_UPDATES.length)}
    </>
  );
}

/**
 * The read-only auto-update caption. The switch is on Updates; "Change in
 * Updates" selects that tab. Account-backed, so it stays while the host can't
 * be reached.
 */
function AutoUpdateCaption(props: { readonly state: "on" | "off" }): ReactNode {
  const selectTab = useHostOverviewSelectTab();
  return (
    <p
      className="border-t border-border/40 px-4 py-2.5 text-ui-xs text-muted-foreground"
      data-testid="host-overview-auto-update-caption"
      data-state={props.state}
    >
      {props.state === "on"
        ? "Auto-update is on — applied at this host's next check-in, only when no sessions are running."
        : "Auto-update is off."}
      {selectTab === null ? null : (
        <>
          {" "}
          <Button
            type="button"
            variant="link"
            size="inline-xs"
            data-testid="host-overview-change-in-updates"
            onClick={() => selectTab("updates")}
          >
            Change in Updates
          </Button>
        </>
      )}
    </p>
  );
}

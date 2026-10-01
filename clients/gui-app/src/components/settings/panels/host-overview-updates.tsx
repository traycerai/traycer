/**
 * Docs: see ../SETTINGS.md (Host ▸ Overview ▸ Updates ▸ Answer card).
 * Update that file whenever this settings surface changes.
 */
import type { ReactNode } from "react";
import {
  CircleAlert,
  CircleArrowUp,
  CircleSlash,
  GitBranch,
  Lock,
  RotateCw,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  describeOverviewDegrade,
  type OverviewDegradeReason,
} from "@/components/settings/panels/host-overview-model";
import type {
  HostOverviewAnswerKind,
  HostOverviewUpdatesSummary,
} from "@/components/settings/panels/host-overview-updates-state";
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
  /**
   * THIS machine's host was started in a terminal: nothing here can finish an
   * update over it, so Update now gives way to this sentence saying what does
   * (`hostForegroundUpdateLine`). `null` otherwise.
   */
  readonly foregroundUpdateLine: string | null;
}

type AnswerCardTone = "info" | "warning" | "neutral" | "destructive";

interface AnswerCardLook {
  readonly tone: AnswerCardTone;
  readonly icon: LucideIcon;
  readonly title: string;
}

/**
 * What each answer looks like as a card, or `null` for the QUIET answers.
 *
 * "Latest" is quiet because the page already says it twice: the version
 * list's installed row wears `latest` beside `installed`, and the header's
 * health line names the version. "Checking" is quiet because Check now, on
 * the version list's heading, spins for exactly that span.
 */
const ANSWER_CARD_LOOK: Record<HostOverviewAnswerKind, AnswerCardLook | null> =
  {
    available: {
      tone: "info",
      icon: CircleArrowUp,
      title: "Update available",
    },
    "needs-cli": {
      tone: "warning",
      icon: SquareTerminal,
      title: "Needs newer CLI tools",
    },
    "restart-to-finish": {
      tone: "warning",
      icon: RotateCw,
      title: "Restart to finish",
    },
    stranded: {
      tone: "info",
      icon: GitBranch,
      title: "Newer version on another release line",
    },
    "not-installable": {
      tone: "neutral",
      icon: CircleSlash,
      title: "Update unavailable for this host",
    },
    unreachable: {
      tone: "neutral",
      icon: CircleAlert,
      title: "Update check failed",
    },
    "check-failed": {
      tone: "neutral",
      icon: CircleAlert,
      title: "Update check failed",
    },
    latest: null,
    checking: null,
  };

const DEGRADE_LOOK: AnswerCardLook = {
  tone: "neutral",
  icon: Lock,
  title: "Updates aren't managed here",
};

/**
 * The card's surface and its icon tile, per tone: the status recipe
 * (`border-<role>/30`, a `/5`-`/15` tint). The neutral arm is
 * `bg-foreground/5`, never `bg-muted`: this card sits on the raised Overview
 * surface, where every preset dark theme collapses `--muted` into the card
 * colour.
 */
const TONE_CLASSES: Record<
  AnswerCardTone,
  { readonly card: string; readonly tile: string }
> = {
  info: {
    card: "border-info/30 bg-linear-to-r from-info/12 to-info/5",
    tile: "bg-info/15 text-info-foreground ring-info/25",
  },
  warning: {
    card: "border-warning/30 bg-linear-to-r from-warning/12 to-warning/5",
    tile: "bg-warning/15 text-warning-foreground ring-warning/25",
  },
  neutral: {
    card: "border-border/60 bg-foreground/5",
    tile: "bg-foreground/8 text-muted-foreground ring-foreground/10",
  },
  destructive: {
    card: "border-destructive/30 bg-destructive/10",
    tile: "bg-destructive/15 text-destructive ring-destructive/25",
  },
};

/**
 * Updates ▸ Answer card: the update answer, only when it has something to
 * say. It leads the Updates tab, above the auto-update switch and the version
 * list, and draws NOTHING for a host that is current or mid-check: the
 * version is the header's, "latest" is the installed row's, and Check now is
 * the version list's.
 *
 * Every other answer is a card: an icon tile, a title, the answer's own
 * sentence under it, and the answer's one control (Update now, or the
 * command-line-tools fix) on the right. An available update reads
 * `v1.4.0 → v1.5.1` in place of "v1.5.1 is available.", which stays the live
 * region's text for a screen reader.
 *
 * While an update runs, waits or restarts the card is withheld: the update
 * card in the notices strip above the tab bar is on screen for exactly that
 * span and is the one place that describes the update. The catalog's answer
 * mid-update ("v1.5.1 is available.") would contradict it, and activation
 * debt's ("v1.5.1 is installed — restart host to finish.") would repeat it.
 *
 * The CLI-tools fix is NOT held to that rule, and its sentence stays with it.
 * It is a fix for the tools, not a control over the update in flight; a park
 * can be waiting on exactly it (the update card's floor sentence points at
 * this card's Show installation help); and the page rechecks the catalog
 * every 30 s for as long as a floor applies (`useHostOverviewUpdates`'
 * recheck), which is only honest while the fix that recheck is for is on
 * screen.
 *
 * Nor is a refused or failed attempt (`failureDescription`): a refused Force
 * update… is answered during the very park that counts as in flight, and the
 * dialog that asked closes on the refusal expecting this card to say why. It
 * is a red footer under whichever answer shows, or - under a quiet answer - a
 * destructive card of its own.
 */
export function HostOverviewAnswerCard(props: {
  /**
   * The running version, as the header's health line states it. Read only
   * for an available update's `from → to` line.
   */
  readonly version: string | null;
  readonly answer: HostOverviewVersionAnswer;
  /** An update is running, waiting or restarting. */
  readonly inFlight: boolean;
}): ReactNode {
  const { summary, degrade } = props.answer;
  // Not manageable here: the version list is withheld, so this card is the
  // page's one statement of why.
  if (degrade !== null) {
    return (
      <AnswerCardFrame
        look={DEGRADE_LOOK}
        kind="degraded"
        body={
          <p
            className="text-muted-foreground text-ui-sm"
            data-testid="host-overview-updates-degraded"
          >
            {describeOverviewDegrade(degrade, summary.hostName)}
          </p>
        }
        actions={null}
        footer={null}
      />
    );
  }

  const look = ANSWER_CARD_LOOK[summary.answerKind];
  // In flight, only the fix survives; a quiet answer never draws.
  if (look === null || (props.inFlight && summary.remedy === null)) {
    return summary.failureDescription === null ? null : (
      <AnswerCardFrame
        look={{
          tone: "destructive",
          icon: CircleAlert,
          title: summary.failureDescription,
        }}
        kind="failed-attempt"
        body={null}
        actions={null}
        footer={null}
      />
    );
  }

  // A check that settled with no catalog has no answer beyond "it failed", so
  // the reason IS the supporting line rather than a footer repeating it.
  const failureIsTheAnswer =
    summary.answerKind === "check-failed" &&
    summary.failureDescription !== null;
  return (
    <AnswerCardFrame
      look={look}
      kind={summary.answerKind}
      body={
        <>
          <AnswerLine
            summary={summary}
            version={props.version}
            text={
              failureIsTheAnswer
                ? summary.failureDescription
                : summary.description
            }
          />
          {summary.remedy === null &&
          summary.updatableVersion !== null &&
          props.answer.foregroundUpdateLine !== null ? (
            // The install would reach the CLI and be refused
            // (`E_HOST_NOT_SERVICE_RUN`), so say what finishes it instead of
            // offering a button that cannot.
            <p
              className="text-muted-foreground text-ui-sm"
              data-testid="host-overview-update-foreground"
            >
              {props.answer.foregroundUpdateLine}
            </p>
          ) : null}
        </>
      }
      actions={answerCardActions(props.answer)}
      footer={failureIsTheAnswer ? null : summary.failureDescription}
    />
  );
}

/**
 * The answer's sentence, as a live region: the check runs on its own, so this
 * changes with no user action to anchor it - a live region is the only way a
 * screen-reader user learns a check failed or an update arrived.
 */
function AnswerLine(props: {
  readonly summary: HostOverviewUpdatesSummary;
  readonly version: string | null;
  readonly text: string;
}): ReactNode {
  const { summary } = props;
  if (summary.answerKind === "available" && summary.updatableVersion !== null) {
    const from = formatHostVersion(props.version);
    return (
      <p
        role="status"
        className="font-mono text-muted-foreground text-code-xs"
        data-testid="host-overview-updates"
      >
        <span aria-hidden>
          {from === null ? null : (
            <>
              {from}
              <span className="mx-1.5 text-info-foreground">→</span>
            </>
          )}
          <span className="font-semibold text-foreground">
            v{summary.updatableVersion}
          </span>
        </span>
        <span className="sr-only">{props.text}</span>
      </p>
    );
  }
  return (
    <p
      role="status"
      className="text-muted-foreground text-ui-sm"
      data-testid="host-overview-updates"
    >
      {props.text}
    </p>
  );
}

/**
 * The card's one control, or `null`: the command-line-tools fix where a
 * floor applies, else Update now when there is a newer version this host can
 * install and no foreground run on this machine to refuse it.
 */
function answerCardActions(answer: HostOverviewVersionAnswer): ReactNode {
  const { summary } = answer;
  if (summary.remedy !== null) {
    return (
      <CliFloorRemedyActions
        actions={summary.remedy.actions}
        desktopBridge={answer.desktopBridge}
        onHelp={answer.onInstallationHelp}
      />
    );
  }
  if (
    summary.updatableVersion === null ||
    answer.foregroundUpdateLine !== null
  ) {
    return null;
  }
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
          className="size-3"
          testId={undefined}
          variant={undefined}
        />
      ) : null}
      Update now
    </Button>
  );
}

/**
 * The card itself: icon tile, title, body, controls and the red footer. A
 * `@container`, so the controls sit under the text on a phone and move to
 * the right edge from `@lg` up - the settings pane is fluid, so its width,
 * not the viewport's, is the one that decides.
 */
function AnswerCardFrame(props: {
  readonly look: AnswerCardLook;
  /** `data-answer`: the answer kind, `degraded` or `failed-attempt`. */
  readonly kind: HostOverviewAnswerKind | "degraded" | "failed-attempt";
  readonly body: ReactNode;
  readonly actions: ReactNode;
  readonly footer: string | null;
}): ReactNode {
  const tone = TONE_CLASSES[props.look.tone];
  const Icon = props.look.icon;
  // A failed-attempt card is its title alone, and that title is news the
  // person did not ask for this moment: announce it the way the version
  // list's own refusal is announced.
  const titleRole = props.kind === "failed-attempt" ? "alert" : undefined;
  return (
    <section
      aria-label={props.kind === "failed-attempt" ? "Update" : props.look.title}
      data-testid="host-overview-answer-card"
      data-answer={props.kind}
      className={cn(
        "@container flex flex-col overflow-hidden rounded-lg border",
        tone.card,
      )}
    >
      <div className="flex items-start gap-3 px-4 py-3">
        <span
          aria-hidden
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-md ring-1 ring-inset",
            tone.tile,
          )}
        >
          <Icon className="size-4" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-2 @lg:flex-row @lg:items-center @lg:gap-4">
          <div
            className={cn(
              "flex min-w-0 flex-1 flex-col gap-0.5",
              // A lone title sits on the tile's centre line, not its top.
              props.body === null && "min-h-8 justify-center",
            )}
          >
            <p
              role={titleRole}
              className={cn(
                "font-medium text-ui-sm",
                props.kind === "failed-attempt"
                  ? "text-destructive"
                  : "text-foreground",
              )}
              data-testid={
                props.kind === "failed-attempt"
                  ? "host-overview-update-attempt-failed"
                  : undefined
              }
            >
              {props.look.title}
            </p>
            {props.body}
          </div>
          {props.actions === null ? null : (
            <div className="flex flex-wrap items-center gap-2 @lg:shrink-0 @lg:justify-end">
              {props.actions}
            </div>
          )}
        </div>
      </div>
      {/* A polite live region that exists whether or not a failure does, so
          one arriving under an answer already on screen is announced. */}
      <div aria-live="polite">
        {props.footer === null ? null : (
          <div
            className="flex items-start gap-2 border-destructive/20 border-t bg-destructive/5 py-2.5 pr-4 pl-15 text-destructive text-ui-xs"
            data-testid="host-overview-update-attempt-failed"
          >
            <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
            <span className="max-w-[68ch]">{props.footer}</span>
          </div>
        )}
      </div>
    </section>
  );
}

import { useRef } from "react";
import { Check, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import {
  CHAT_NAVIGATION_HIGHLIGHT_CLASSNAME,
  useRestartHighlightPulse,
} from "@/components/chat/chat-navigation-highlight";
import { deriveToolInputSummary } from "@/lib/segment-summary";
import { approvalCardText } from "@/components/chat/segments/approval-text";
import { humanActionableApprovals } from "@/components/epic-canvas/renderers/chat-approval-visibility";
import {
  APPROVAL_PAUSED_LINE,
  JUDGE_FIX_IN_SETTINGS_LABEL,
  approvalWaitLine,
  isJudgeUnavailableReason,
  judgeUnavailableHumanLine,
  judgeWaitDisclosure,
} from "@/components/chat/segments/approval-card-disclosure";
import {
  AUTO_JUDGE_ALLOW_FROM_NOW_ON_LABEL,
  autoJudgeTierLine,
  autoModeRuleDisplayName,
  autoModeRuleDraftAction,
  autoModeRuleDraftText,
  type AutoModeRuleDraftWorkspace,
} from "@/lib/auto-mode/auto-mode-rule-copy";
import { useElapsedSeconds } from "@/hooks/use-elapsed-seconds";
import { useSampledNow } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import type {
  ChatApprovalReason,
  ChatApprovalState,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { deriveToolInputDetail } from "@traycer/protocol/host/agent/gui/tool-input-detail";
import type { TabHostSettingsOpts } from "@/stores/tabs/system-overlay-types";

interface ComposerSlotApprovalQueueProps {
  readonly approvals: ReadonlyArray<ChatApprovalState>;
  readonly canAct: boolean;
  readonly onDecision: (approvalId: string, approved: boolean) => void;
  readonly highlightedApprovalId: string | null;
  readonly highlightedGeneration?: number;
  /**
   * What this chat's workspace binding says about where it runs, for the rule
   * "Allow from now on…" drafts. Either part is `null` when unknown.
   */
  readonly ruleDraftWorkspace: AutoModeRuleDraftWorkspace;
  /** Opens Settings; the card's two links land on Permissions tabs. */
  readonly onOpenSettings: (opts: TabHostSettingsOpts) => void;
}

/**
 * Copy for each judge stage, keyed by `ChatApprovalState.reviewing`.
 *
 * Two stages, two very different waits: the fast pass answers within seconds,
 * the deep one reads the conversation and may run for minutes, so the line
 * says which one is running rather than one generic "Reviewing…" for both.
 * "Auto mode" rather than "the judge": this is the mode the user chose, and the
 * same shield as its icon, so the wait is recognisably that mode at work.
 */
const JUDGE_REVIEWING_LABEL: Record<
  NonNullable<ChatApprovalState["reviewing"]>,
  string
> = {
  checking: "Auto mode is checking",
  reviewing: "Auto mode is reading the conversation",
};

/**
 * Single canonical surface for ALL pending approvals - one row when there
 * is one, N rows when many. Replaces the prior split where a single
 * approval lived in the composer slot and ≥2 spilled inline. Keeps the
 * action surface consistent regardless of queue depth.
 *
 * Under the `auto` permission mode a row can be here without being a question:
 * an approval a judge is still deciding rides the same list carrying
 * `reviewing`, and renders its stage with no buttons (plan decision 19 - there
 * is no human override while the judge runs; the stage-2 cap bounds the wait).
 * The bulk actions therefore act on - and count - only the rows a human can
 * actually answer, so "Approve all" can never resolve a call the judge is still
 * thinking about.
 */
export function ComposerSlotApprovalQueue(
  props: ComposerSlotApprovalQueueProps,
) {
  const { approvals, canAct, onDecision } = props;
  const count = approvals.length;
  if (count === 0) return null;
  const actionable = humanActionableApprovals(approvals);
  const showBulk = actionable.length >= 2;
  // Nothing is needed from the user while every row is still with the judge, so
  // the heading does not claim otherwise. It flips to "Approval needed" the
  // moment one row is actually answerable - including the same card's other
  // rows, which is the common case in a queue of several calls.
  const awaitingJudgeOnly = actionable.length === 0;
  // While every row is with the judge the HEADER is the wait line: the quiet
  // card is one line naming the stage, then the commands. It describes the
  // first judged row, which is the one running - the judge's per-chat queue
  // admits one call at a time - and that row does not repeat it.
  const headerApproval = awaitingJudgeOnly
    ? (approvals.find((approval) => approval.reviewing !== null) ?? null)
    : null;
  const headerStage = headerApproval?.reviewing ?? null;
  return (
    // The chrome follows the same flag as the heading, and that is the whole
    // fix for the post-retirement flicker: once an allowed command retires its
    // own card, EVERY judged command puts a row on screen for the ~5 s stage-1
    // spawn. A five-second muted line saying what the pause is for is good
    // feedback; a five-second bordered, primary-tinted alert with an uppercase
    // overline saying the same thing is what makes a working feature feel like
    // it is malfunctioning. The alarm is in the chrome, not in the row's
    // existence - so the full alert returns the instant any row becomes
    // answerable, which this flag already tracks. No timer and no hold: a
    // threshold delay would open a race where a retire arriving during the
    // hold lets the card appear AFTER the allow.
    <div
      className={cn(
        "flex flex-col gap-2 rounded-md border px-3 py-2.5 text-ui-sm",
        awaitingJudgeOnly
          ? "border-border/60"
          : "border-primary/40 bg-primary/5",
      )}
      data-testid="approval-prompt"
      data-chrome={awaitingJudgeOnly ? "quiet" : "alert"}
    >
      {headerApproval !== null && headerStage !== null ? (
        <JudgeReviewingLine
          stage={headerStage}
          startedAt={headerApproval.requestedAt}
          placement="header"
        />
      ) : null}
      {awaitingJudgeOnly ? null : (
        <div className="flex items-center gap-2">
          <ShieldAlert className="size-3.5 shrink-0 text-primary" aria-hidden />
          <span className="select-none font-medium uppercase text-overline text-primary">
            Approval needed
          </span>
          {showBulk ? (
            <>
              <span aria-hidden className="text-muted-foreground/40">
                ·
              </span>
              <span className="text-ui-xs text-muted-foreground">
                {actionable.length} pending
              </span>
              <div className="ml-auto flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!canAct}
                  onClick={() => {
                    for (const approval of actionable) {
                      onDecision(approval.approvalId, false);
                    }
                  }}
                >
                  <X className="size-3.5" aria-hidden />
                  Deny all
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="default"
                  disabled={!canAct}
                  onClick={() => {
                    for (const approval of actionable) {
                      onDecision(approval.approvalId, true);
                    }
                  }}
                >
                  <Check className="size-3.5" aria-hidden />
                  Approve all
                </Button>
              </div>
            </>
          ) : null}
        </div>
      )}
      <div className="flex flex-col divide-y divide-border/30">
        {approvals.map((approval) => (
          <ApprovalRow
            key={approval.approvalId}
            approval={approval}
            canAct={canAct}
            onDecision={onDecision}
            navigationHighlighted={
              props.highlightedApprovalId === approval.approvalId
            }
            highlightGeneration={props.highlightedGeneration ?? 0}
            stageInHeader={approval === headerApproval}
            ruleDraftWorkspace={props.ruleDraftWorkspace}
            onOpenSettings={props.onOpenSettings}
          />
        ))}
      </div>
    </div>
  );
}

interface ApprovalRowProps {
  readonly approval: ChatApprovalState;
  readonly canAct: boolean;
  readonly onDecision: (approvalId: string, approved: boolean) => void;
  readonly navigationHighlighted: boolean;
  readonly highlightGeneration: number;
  /** The card's header already shows this row's judge stage. */
  readonly stageInHeader: boolean;
  readonly ruleDraftWorkspace: AutoModeRuleDraftWorkspace;
  readonly onOpenSettings: (opts: TabHostSettingsOpts) => void;
}

function ApprovalRow(props: ApprovalRowProps) {
  const { approval, canAct, onDecision } = props;
  const rowRef = useRef<HTMLDivElement | null>(null);
  useRestartHighlightPulse(
    props.navigationHighlighted,
    props.highlightGeneration,
    rowRef,
  );
  // The derived summary is the action a rule draft narrows to; what the card
  // SHOWS is a display choice made below it (`approvalCardText` drops the cut
  // summary when the headline is the whole command), so the two are kept apart.
  const derivedSummary = deriveToolInputSummary(
    approval.toolName,
    approval.input,
  );
  const { inputSummary, headline } = approvalCardText(
    approval.toolName,
    derivedSummary,
    approval.description,
    deriveToolInputDetail(approval.toolName, approval.input),
  );
  const reviewing = approval.reviewing;
  // The stage line this row shows itself: none while the card's header is
  // already showing it, and none once the judge has handed the row over.
  const rowStage = props.stageInHeader ? null : reviewing;
  return (
    <div
      ref={rowRef}
      data-testid="approval-row"
      data-approval-id={approval.approvalId}
      data-navigation-highlighted={
        props.navigationHighlighted ? "true" : undefined
      }
      data-navigation-highlight-generation={
        props.navigationHighlighted
          ? String(props.highlightGeneration)
          : undefined
      }
      className={cn(
        "flex min-w-0 flex-col gap-1.5 rounded-md py-2 first:pt-0 last:pb-0 transition-[background-color,box-shadow] duration-300",
        props.navigationHighlighted && CHAT_NAVIGATION_HIGHLIGHT_CLASSNAME,
      )}
    >
      {reviewing === null ? (
        <ApprovalWaitLine requestedAt={approval.requestedAt} />
      ) : null}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 font-mono text-code-sm text-foreground/80">
        <span className="shrink-0">{approval.toolName}</span>
        {inputSummary !== null ? (
          <>
            <span aria-hidden className="shrink-0 text-muted-foreground/40">
              ·
            </span>
            <span className="min-w-0 break-words text-muted-foreground">
              {inputSummary}
            </span>
          </>
        ) : null}
      </div>
      {headline === null ? null : (
        // The headline can be the whole command in place of the cut summary,
        // so it wraps a long unbroken token and keeps the command's lines.
        <p className="m-0 min-w-0 whitespace-pre-wrap break-words text-foreground/85">
          {headline}
        </p>
      )}
      {approval.reason !== null ? (
        <JudgeReason
          reason={approval.reason}
          ruleDraftAction={autoModeRuleDraftAction({
            inputSummary: derivedSummary,
            toolName: approval.toolName,
          })}
          ruleDraftWorkspace={props.ruleDraftWorkspace}
          onOpenSettings={props.onOpenSettings}
        />
      ) : null}
      {rowStage !== null ? (
        // No buttons and no override while a judge is deciding (plan decision
        // 19). The state rides the subscribe frame only, and the host retires
        // the row with its own resolution frame on every exit that announced
        // one - the allow, a Stop during stage 2, a failed journal write and
        // the agents-only denial alike.
        <JudgeReviewingLine
          stage={rowStage}
          startedAt={approval.requestedAt}
          placement="row"
        />
      ) : null}
      {reviewing === null ? (
        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!canAct}
            onClick={() => {
              onDecision(approval.approvalId, false);
            }}
          >
            <X className="size-3.5" aria-hidden />
            Deny
          </Button>
          <Button
            type="button"
            size="sm"
            variant="default"
            disabled={!canAct}
            onClick={() => {
              onDecision(approval.approvalId, true);
            }}
          >
            <Check className="size-3.5" aria-hidden />
            Approve
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * How long this card has been waiting on a human, once that is long enough to
 * be worth saying.
 *
 * The card a returning human finds is the point of the attendance rule: a chat
 * a person merely looked away from PARKS rather than being refused, which is
 * the right answer and is not free - the turn is now blocked on somebody who
 * is not there. This is what tells them so when they get back.
 *
 * Its own leaf so the shared 60s clock repaints this line rather than the row
 * around it.
 */
function ApprovalWaitLine(props: { readonly requestedAt: number }) {
  const nowMs = useSampledNow();
  const waited = approvalWaitLine({
    requestedAt: props.requestedAt,
    nowMs,
  });
  if (waited === null) return null;
  return (
    <p
      className="m-0 text-ui-xs text-muted-foreground"
      data-testid="approval-wait-line"
    >
      {waited} {APPROVAL_PAUSED_LINE}
    </p>
  );
}

/**
 * The judging row's stage label and its disclosure ladder.
 *
 * Its own leaf for the same reason as the wait line, and for one more: the
 * per-second tick lives only while a judge is actually running, because this
 * component is mounted only then.
 *
 * **What is inside a live region here is a deliberate, narrow choice.**
 * `role="status"` is implicitly `aria-atomic`, so a status region re-announces
 * its WHOLE subtree on every change to any part of it - and from 15 s up this
 * row changes once a second, forever. A region wrapping the column would
 * therefore read the stage label and the cap sentence aloud on every tick,
 * which is the one thing a waiting user does not need repeated.
 *
 * So the regions are the two things worth announcing exactly when they change:
 * the stage label (the judge moved from `checking` to the next stage) and the
 * cap notice (it appeared). The elapsed counter is left OUT of both - out of
 * the live tree, not out of the a11y tree, so a screen-reader user can still
 * navigate to it and read the seconds on demand. The spinner is outside too:
 * it is `aria-hidden`, but it also rewrites its own text every 80 ms, and a
 * live region has no reason to sit on top of that.
 */
function JudgeReviewingLine(props: {
  readonly stage: NonNullable<ChatApprovalState["reviewing"]>;
  readonly startedAt: number;
  /**
   * `header` is the quiet card's own header: the Auto mode shield leads it.
   * `row` is a row still with the judge on a card that is otherwise asking.
   */
  readonly placement: "header" | "row";
}) {
  const elapsedSeconds = useElapsedSeconds(props.startedAt, 0, null);
  const disclosure = judgeWaitDisclosure(elapsedSeconds);
  return (
    <div
      className="flex min-w-0 flex-col gap-1"
      data-testid="approval-reviewing"
      data-placement={props.placement}
    >
      <div className="flex items-center gap-2 text-ui-xs text-muted-foreground">
        {props.placement === "header" ? (
          <ShieldCheck
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden
            data-testid="approval-reviewing-shield"
          />
        ) : null}
        <span role="status" data-testid="approval-reviewing-stage">
          {JUDGE_REVIEWING_LABEL[props.stage]}
        </span>
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
          tone="muted"
        />
        {disclosure.elapsedLabel !== null ? (
          <>
            <span aria-hidden className="text-muted-foreground/40">
              ·
            </span>
            <span data-testid="approval-reviewing-elapsed">
              {disclosure.elapsedLabel}
            </span>
          </>
        ) : null}
      </div>
      {disclosure.capNotice !== null ? (
        <p
          className="m-0 text-ui-xs text-muted-foreground"
          data-testid="approval-reviewing-cap"
          role="status"
        >
          {disclosure.capNotice}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The judge's verdict on a call it escalated: the rule it matched as a chip,
 * its own reasoning underneath, and one line saying why that sent it to a
 * person.
 *
 * A card that said only "approve this?" after a judge already refused it is
 * strictly worse than one that never ran a judge, because the user cannot tell
 * why they are being asked - so this renders wherever the reason is present,
 * including on a row that is no longer reviewing.
 *
 * The rule is shown in sentence case; the wire keeps the host's exact name.
 * The line under the reason is keyed by the `tier` the host sends, never by a
 * client copy of the rule lists, so a rule that changes tier on a newer host
 * reads correctly here. An older host sends no tier and gets no line.
 *
 * When the reason is an UNAVAILABILITY string rather than the judge's prose,
 * the machine string is kept verbatim and in mono - it is a greppable constant,
 * and a screenshot of one is a diagnosis - and the human sentence is added
 * beneath it, never in its place. Which sentence is the string's own failure
 * family (`judgeUnavailableHumanLine`): a judge that ran and could not decide
 * leaves its reasoning right above this line, so the "couldn't run" sentence
 * would contradict the paragraph the user is reading.
 */
function JudgeReason(props: {
  readonly reason: ChatApprovalReason;
  /**
   * What a drafted "allow" rule is narrowed to, or `null` when the approval
   * names no action at all - and then no rule is offered, since one naming
   * only the category would allow everything in it.
   */
  readonly ruleDraftAction: string | null;
  readonly ruleDraftWorkspace: AutoModeRuleDraftWorkspace;
  readonly onOpenSettings: (opts: TabHostSettingsOpts) => void;
}) {
  const { reason, onOpenSettings, ruleDraftAction } = props;
  const unavailable = isJudgeUnavailableReason(reason.text);
  const ruleName = autoModeRuleDisplayName(reason.rule);
  const tierLine = autoJudgeTierLine(reason.tier);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="inline-flex w-fit max-w-full items-center rounded-full border border-border/60 bg-foreground/5 px-2 py-0.5 text-ui-xs text-foreground/85">
        <span className="min-w-0 truncate">{ruleName}</span>
      </span>
      <p
        className={cn(
          "m-0 whitespace-pre-wrap text-ui-xs text-muted-foreground",
          unavailable && "font-mono",
        )}
      >
        {reason.text}
      </p>
      {unavailable ? (
        <JudgeUnavailableLine
          text={reason.text}
          onOpenSettings={onOpenSettings}
        />
      ) : null}
      {tierLine !== null ? (
        <p
          className="m-0 text-ui-xs text-muted-foreground"
          data-testid="approval-judge-tier-line"
        >
          {tierLine}
          {reason.tier === "soft" && ruleDraftAction !== null ? (
            <>
              {" "}
              <Button
                type="button"
                variant="link"
                size="inline-xs"
                data-testid="approval-allow-from-now-on"
                onClick={() => {
                  onOpenSettings({
                    section: "permissions",
                    tab: "rules",
                    draft: {
                      section: "allow",
                      text: autoModeRuleDraftText({
                        workspace: props.ruleDraftWorkspace,
                        ruleName,
                        action: ruleDraftAction,
                      }),
                    },
                    resetToGeneral: false,
                  });
                }}
              >
                {AUTO_JUDGE_ALLOW_FROM_NOW_ON_LABEL}
              </Button>
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The human sentence under a machine string, with the Judge tab link when a
 * setting is what fixes it.
 */
function JudgeUnavailableLine(props: {
  readonly text: string;
  readonly onOpenSettings: (opts: TabHostSettingsOpts) => void;
}) {
  const line = judgeUnavailableHumanLine(props.text);
  return (
    <p
      className="m-0 text-ui-xs text-muted-foreground"
      data-testid="approval-judge-unavailable-line"
    >
      {line.sentence}
      {line.fixInJudgeSettings ? (
        <>
          {" "}
          <Button
            type="button"
            variant="link"
            size="inline-xs"
            data-testid="approval-fix-in-judge-settings"
            onClick={() => {
              props.onOpenSettings({
                section: "permissions",
                tab: "judge",
                draft: null,
                resetToGeneral: false,
              });
            }}
          >
            {JUDGE_FIX_IN_SETTINGS_LABEL}
          </Button>
          .
        </>
      ) : null}
    </p>
  );
}

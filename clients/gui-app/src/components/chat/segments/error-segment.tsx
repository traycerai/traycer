import { useCallback } from "react";
import { AlertTriangle } from "lucide-react";
import {
  ENV_CREDENTIAL_AUTH_ERROR_CODE,
  QUEUE_PAUSED_AFTER_ERROR_CODE,
} from "@traycer/protocol/host/agent/gui/agent-runtime";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type {
  AgentFailure,
  AgentFailureReason,
} from "@traycer/protocol/persistence/epic/content-blocks";
import { FallbackManualRungActions } from "@/components/chat/fallback/fallback-manual-rungs";
import {
  RoutingSettledCard,
  type RoutingSettledNotice,
} from "@/components/chat/fallback/routing-settled-card";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { Button } from "@/components/ui/button";
import {
  agentFailureHeadline,
  agentFailurePresentation,
  presentationForUntypedCode,
  type AgentFailurePresentation,
} from "@/components/chat/segments/agent-failure-presentation";
import { cn } from "@/lib/utils";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { buildReportIssueDraftContext } from "@/lib/report-issue-draft-context";
import { capturePersistedAgentError } from "@/lib/report-issue-error-capture";
import { useProvidersFocusStore } from "@/stores/settings/providers-focus-store";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";

/**
 * The remedy for an env-credential auth failure, next to the row that names it.
 *
 * The message says which variable authenticated the turn; this is where the user
 * goes to stop it. The destination is the provider's **Env** tab, where an
 * explicit "Unset" row for that variable drops it from the harness spawn without
 * touching the user's shell - the one fix that actually works, and the one no
 * amount of re-signing-in could substitute for.
 *
 * The deep link rides the existing providers-focus intent (the same mechanism
 * the re-auth banner and the "Add API key" CTA use), so this adds no navigation
 * plumbing of its own. Without a known harness the intent is skipped and the
 * user lands on the Providers section root rather than an arbitrary provider's
 * settings - a shorter trip to the right place beats a confident wrong one.
 */
function EnvCredentialSettingsAction({
  harnessId,
}: {
  readonly harnessId: GuiHarnessId | null;
}) {
  const { openSettings } = useSystemTabModalActions();
  const onClick = useCallback(() => {
    if (harnessId !== null) {
      const focus = useProvidersFocusStore.getState();
      focus.setFocusHarnessId(harnessId);
      focus.setFocusTab("env");
    }
    openSettings({
      section: "providers",
      resetToGeneral: false,
      tab: null,
      draft: null,
      hostId: null,
    });
  }, [harnessId, openSettings]);
  return (
    <div className="mt-1 flex">
      <Button size="sm" variant="secondary" onClick={onClick}>
        Manage environment variables
      </Button>
    </div>
  );
}

interface ErrorSegmentProps {
  message: string;
  code: string | null;
  recoverable: boolean;
  findUnitId: string | null;
  /** Harness that ran the turn, so a provider-scoped remedy can deep-link to
   *  the right provider. `null` on legacy rows with no turn metadata. */
  harnessId: GuiHarnessId | null;
  /**
   * The host's typed description of why the turn died, or `null` on a row from
   * before the payload existed (or one no turn produced).
   *
   * What it decides here is how the row presents, and which action leads on
   * the failed-turn card: Switch after a rate limit or billing stop, Retry
   * after anything else, a sign-out included (spec Flow 4).
   */
  failure: AgentFailure | null;
  /**
   * The host turn this row belongs to, or `null` where the row has no turn
   * identity. The manual-rung affordances render only on the row whose turn id
   * matches the one the host named, so a transcript holding three failed
   * attempts offers them once rather than three times.
   */
  turnId: string | null;
  /**
   * The settled routing notice this row absorbs, or `null` - set only on the
   * anchor error of a row the projection paired with a receipt-carrying notice
   * (`ChatMessage.routingSettledNoticeId`). The row then renders the settled
   * card instead of the plain failed-turn card.
   */
  settledNotice: RoutingSettledNotice | null;
  /** The absorbed notice's own find unit, painted by the settled card. */
  settledNoticeFindUnitId: string | null;
}

/**
 * How the row presents, and its headline when it is an interruption.
 *
 * A typed reason decides it; a row with none is red unless its CODE is one the
 * client can vouch for (`presentationForUntypedCode` - a torn-down session is
 * "Session ended", not an error).
 */
function errorRowPresentation(
  reason: AgentFailureReason | null,
  code: string | null,
): {
  readonly presentation: AgentFailurePresentation;
  readonly headline: string | null;
} {
  if (reason === null) {
    const untyped = presentationForUntypedCode(code);
    if (untyped !== null) return untyped;
  }
  return {
    presentation: agentFailurePresentation(reason),
    headline: agentFailureHeadline(reason),
  };
}

/**
 * The row's first line: either the failure's own name, or the ERROR overline.
 *
 * `headline` non-null is the INTERRUPTED row and carries the reason in the same
 * words every other routing surface uses for it - "Rate limit reached" is what
 * the countdown card's chip says, what the per-error settings row is called,
 * and what the transcript notice says afterwards. Sentence case, in the warning
 * foreground, because nothing is broken.
 *
 * `null` keeps what the row always had. The uppercase overline and the raw code
 * chip belong to a turn that genuinely died, where the code is the most useful
 * thing on screen for whoever ends up reading the bug report. On the
 * interrupted row that same chip put `rate_limit` in red monospace as the
 * loudest element on a card about an account being out of quota - a raw reason
 * code in front of a user, which the routing vocabulary bans everywhere else.
 * The report-issue action still captures the code either way.
 */
function ErrorSegmentHeading({
  headline,
  harnessId,
  code,
}: {
  readonly headline: string | null;
  readonly harnessId: GuiHarnessId | null;
  readonly code: string | null;
}) {
  if (headline !== null) {
    return (
      <div className="flex items-center gap-2">
        <span className="font-medium text-warning-foreground">{headline}</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <span className="text-overline font-semibold uppercase text-destructive">
        {harnessId === "codex" ? "Codex turn failed" : "Error"}
      </span>
      {code !== null && code.length > 0 ? (
        <span className="rounded border border-destructive/30 bg-destructive/10 px-1 font-mono text-code-xs text-destructive">
          {code}
        </span>
      ) : null}
    </div>
  );
}

// Static error row. Auth errors (`code: "auth"`) render here like any other
// error - the durable transcript row is what keeps a headless (A2A-triggered)
// auth failure visible after the composer's re-auth banner clears.
//
// The queue-pause notice renders NOTHING. It is an error block by type only -
// "N queued messages were held" - and the Message Queue panel's paused pill
// already says it, with the Resume button beside it (user ruling, 2026-09-26:
// the panel is the one surface for a held queue). A second red card saying
// the same thing in the transcript was the other half of the "two errors for
// one failure" report. Checked before any hook, and a component rather than a
// caller's filter, so every transcript that still carries one - persisted rows
// included - renders it the same way.
export function ErrorSegment(props: ErrorSegmentProps) {
  if (props.code === QUEUE_PAUSED_AFTER_ERROR_CODE) return null;
  return <ErrorSegmentCard {...props} />;
}

function ErrorSegmentCard({
  code,
  findUnitId,
  message,
  recoverable,
  harnessId,
  failure,
  turnId,
  settledNotice,
  settledNoticeFindUnitId,
}: ErrorSegmentProps) {
  // Built at CLICK time, never at render. This row is durable transcript: it
  // mounts whenever the chat is opened, which is one or more commits BEFORE
  // `SupportContextRegistryBridge`'s effects publish that chat's own
  // id/harness/model (chat state arrives through a store subscription, so it
  // trails a route change by two commits). Both `buildReportIssueDraftContext`
  // and `capturePersistedAgentError` snapshot that registry, and the harness
  // id doubles as the fingerprint's `causalProvider` - so building at render
  // would file the report under the PREVIOUSLY open chat and cluster it under
  // the wrong provider. Report time is the only moment the registry is known
  // to describe this row's chat. Deferring also keeps the draft honest when
  // the runtime accumulator replaces a same-blockId error under a MOUNTED row
  // (blockId is this row's React key) - the click reads today's props.
  //
  // The real message/code reach ONLY the private diagnostics branch - the
  // public prefill stays null-bodied because both fields are host/harness-
  // supplied free text and the public context does no redaction (see the
  // hostile transcript-code test).
  const buildReportContext = useCallback(
    () =>
      buildReportIssueDraftContext(
        createReportIssueContext({
          title: "Agent error",
          message: null,
          code: null,
          source: "Chat",
        }),
        capturePersistedAgentError({ message, code, recoverable }),
      ),
    [code, message, recoverable],
  );
  const reportAction = (
    <ReportIssueAction
      context={buildReportContext}
      presentation="icon"
      className="-mt-1 -mr-1 shrink-0"
    />
  );
  const actions =
    turnId === null ? null : <FallbackManualRungActions turnId={turnId} />;
  // Routing tried everything on this turn and settled: ONE card carrying the
  // routing account and this row's actions, where this error was. The notice
  // itself renders nothing beside it (`AssistantMessageBody`).
  if (settledNotice !== null) {
    return (
      <RoutingSettledCard
        notice={settledNotice}
        noticeFindUnitId={settledNoticeFindUnitId}
        errorMessage={message}
        errorCode={code}
        reportAction={reportAction}
        actions={actions}
      />
    );
  }
  // Which of the two rows this is. A provider refusing a turn is not a crash,
  // and rendering it as one - red rule, uppercase ERROR, the raw reason code in
  // a red monospace chip - made the commonest thing that happens to a working
  // setup look like something broke. See `agent-failure-presentation.ts` for
  // why this classification is its own question rather than routing eligibility
  // reused for colour.
  const { presentation, headline } = errorRowPresentation(
    failure?.reason ?? null,
    code,
  );
  const interrupted = presentation === "interrupted";
  return (
    <div
      data-chat-find-unit={findUnitId ?? undefined}
      data-failure-presentation={presentation}
      className={cn(
        "flex w-full flex-col gap-2 rounded-md border px-3 py-2 text-ui-sm",
        // The status recipe (AGENTS.md "Status colors"), one class per role.
        interrupted
          ? "border-warning/30 bg-warning/10"
          : "border-destructive/30 bg-destructive/5",
      )}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle
          className={cn(
            "mt-0.5 size-3.5 shrink-0",
            interrupted ? "text-warning-foreground" : "text-destructive",
          )}
          aria-hidden
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <ErrorSegmentHeading
            headline={interrupted ? headline : null}
            harnessId={harnessId}
            code={code}
          />
          <span className="whitespace-pre-wrap break-words text-foreground/90">
            {message}
          </span>
          {code === ENV_CREDENTIAL_AUTH_ERROR_CODE ? (
            <EnvCredentialSettingsAction harnessId={harnessId} />
          ) : null}
          {actions}
        </div>
        {reportAction}
      </div>
    </div>
  );
}

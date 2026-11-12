import type { ReactNode } from "react";
import { AlertTriangle, ChevronRight, ExternalLink, Link2 } from "lucide-react";
import type {
  ProviderCliState,
  ProviderLoginRefusal,
} from "@traycer/protocol/host/provider-schemas";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import type { ProviderLoginStartCopy } from "@/components/providers/provider-login-start";
import {
  ProviderLoginRefusalAction,
  ProviderLoginRefusalMessage,
} from "@/components/providers/provider-login-refusal";
import { CodePasteField, CodePasteRestartNotice } from "./code-paste-field";
import { SignInCopyIconButton } from "./sign-in-copy-icon-button";
import {
  openBrowserLabel,
  useAutoOpenLoginUrl,
} from "./use-auto-open-login-url";
import { waitingStepCopy } from "./waiting-step-copy";
import type { ProviderProfileLoginFlowCodePaste } from "./use-provider-profile-login-flow";

/** The add-profile dialog's "Sign in" card, before any sign-in has started. */
export function AddProfileSignInCard(props: {
  readonly disabled: boolean;
  readonly onClick: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      aria-label="Sign in"
      className="group flex w-full items-center gap-3 rounded-lg border border-border/60 bg-foreground/3 p-3 text-left transition-colors hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-50"
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground ring-1 ring-border/60 transition-colors group-hover:text-foreground">
        <Link2 className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-ui-sm font-medium text-foreground">
          Sign in
        </span>
        <span className="block text-ui-xs text-muted-foreground">
          Sign in to the account this profile should use.
        </span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}

/** One in-progress line after the browser step, such as "Account signed in". */
export function AddProfileStatusCard(props: {
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-foreground/3 p-3 text-ui-sm text-muted-foreground">
      <MutedAgentSpinner />
      <span>{props.children}</span>
    </div>
  );
}

export function WaitingStepDeviceCode(props: {
  readonly processingCode: boolean;
  readonly userCode: string | null;
}): ReactNode {
  if (props.processingCode || props.userCode === null) return null;
  const { userCode } = props;
  return (
    <div className="flex flex-wrap items-center gap-2 pl-6">
      <code className="rounded-md border border-border/60 bg-foreground/5 px-2.5 py-1 font-mono text-ui tracking-[0.12em] text-foreground">
        {userCode}
      </code>
      <SignInCopyIconButton value={userCode} kind="code" variant="outline" />
    </div>
  );
}

export function WaitingStepUrlActions(props: {
  readonly processingCode: boolean;
  readonly loginUrl: string | null;
  readonly autoOpen: boolean;
  readonly onOpenExternalLink: (url: string) => void;
}): ReactNode {
  if (props.processingCode || props.loginUrl === null) return null;
  const { loginUrl, autoOpen, onOpenExternalLink } = props;
  return (
    <div className="flex flex-wrap items-center gap-2 pl-6">
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => onOpenExternalLink(loginUrl)}
      >
        <ExternalLink className="size-3.5" />
        {openBrowserLabel(autoOpen)}
      </Button>
      <SignInCopyIconButton value={loginUrl} kind="link" variant="outline" />
    </div>
  );
}

function WaitingStepPasteFallback(props: {
  readonly waiting: boolean;
  readonly processingCode: boolean;
  readonly userCode: string | null;
  readonly cancelRequested: boolean;
  readonly codePaste: ProviderProfileLoginFlowCodePaste;
  readonly codeReturn: WaitingStepCodeReturn;
}): ReactNode {
  if (!props.waiting || !props.codePaste.enabled || props.userCode !== null) {
    return null;
  }
  const fallback = props.codeReturn === "automatic";
  return (
    <div className="border-t border-border/50 pt-3">
      {fallback && !props.processingCode ? (
        <div className="mb-2">
          <p className="text-ui-xs font-medium text-foreground">
            Didn&apos;t return automatically?
          </p>
          <p className="mt-0.5 text-ui-xs text-muted-foreground">
            If the browser shows a code, paste it here.
          </p>
        </div>
      ) : null}
      <CodePasteField
        key={props.codePaste.attemptId}
        codePaste={props.codePaste}
        disabled={props.cancelRequested}
        visibleLabel={!fallback}
      />
    </div>
  );
}

/**
 * How a sign-in comes back once the person approves it in the browser:
 * `automatic` when the waiting attempt settles on its own (a pasted code is
 * only the fallback), `paste` when the code the browser shows is the only way
 * back.
 */
export type WaitingStepCodeReturn = "automatic" | "paste";

export function AddProfileWaitingStep({
  loginUrl,
  userCode,
  autoOpenBrowser,
  codeReturn,
  queuePending,
  startingCopy,
  cancelRequested,
  cancelPending,
  cancelDisabled,
  waiting,
  readerCount,
  codePaste,
  onOpenExternalLink,
  onCancel,
}: {
  readonly loginUrl: string | null;
  readonly userCode: string | null;
  /** Whether this window opens the sign-in page itself
   *  (`shouldAutoOpenLoginUrl` for a sign-in run by a provider's own child). */
  readonly autoOpenBrowser: boolean;
  readonly codeReturn: WaitingStepCodeReturn;
  readonly queuePending: boolean;
  /** The flow's `startingCopy`: what a slow start says instead of "Opening
   *  the sign-in page…". */
  readonly startingCopy: ProviderLoginStartCopy | null;
  readonly cancelRequested: boolean;
  readonly cancelPending: boolean;
  readonly cancelDisabled: boolean;
  /** True only once the flow has reached `waiting` (a live profileId/child
   *  exists). The paste field renders only then - during `starting` there
   *  is nothing yet for a submit to reach, and rendering it anyway would
   *  let a user's paste silently lock the field without ever being sent.
   */
  readonly waiting: boolean;
  readonly readerCount?: number;
  readonly codePaste: ProviderProfileLoginFlowCodePaste;
  readonly onOpenExternalLink: (url: string) => void;
  readonly onCancel: () => void;
}): ReactNode {
  const autoOpen = useAutoOpenLoginUrl(
    autoOpenBrowser,
    loginUrl,
    onOpenExternalLink,
  );
  const processingCode = codePaste.phase !== "idle";
  const deviceCode = userCode !== null;
  const { title, guidance } = waitingStepCopy({
    phase: codePaste.phase,
    queuePending,
    startingCopy,
    cancelRequested,
    deviceCode,
    codeReturn,
  });

  return (
    <div className="flex flex-col gap-3" aria-live="polite">
      {codePaste.restartNotice !== null ? (
        <CodePasteRestartNotice message={codePaste.restartNotice} />
      ) : null}
      <div className="flex items-start gap-2.5">
        <MutedAgentSpinner />
        <div className="min-w-0">
          <div className="text-ui-sm font-medium text-foreground">
            {readerCount === undefined
              ? title
              : `Waiting for ${readerCount} ${readerCount === 1 ? "agent" : "agents"} on this profile`}
          </div>
          {readerCount === undefined && guidance !== null ? (
            <p className="mt-0.5 text-ui-xs leading-relaxed text-muted-foreground">
              {guidance}
            </p>
          ) : null}
        </div>
      </div>

      <WaitingStepDeviceCode
        processingCode={processingCode}
        userCode={userCode}
      />
      <WaitingStepUrlActions
        processingCode={processingCode}
        loginUrl={loginUrl}
        autoOpen={autoOpen}
        onOpenExternalLink={onOpenExternalLink}
      />
      <WaitingStepPasteFallback
        waiting={waiting}
        processingCode={processingCode}
        userCode={userCode}
        cancelRequested={cancelRequested}
        codePaste={codePaste}
        codeReturn={codeReturn}
      />

      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          variant="destructive"
          aria-label="Cancel sign-in"
          disabled={cancelRequested || cancelPending || cancelDisabled}
          onClick={onCancel}
        >
          {cancelPending ? <MutedAgentSpinner /> : null}
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function AddProfileFailureStep({
  providerId,
  message,
  refusal,
  source,
  retryLabel,
  onCancel,
  onRetry,
}: {
  readonly providerId: ProviderCliState["providerId"];
  readonly message: string;
  readonly refusal: ProviderLoginRefusal | null;
  /** Where a filed issue says the failure happened. */
  readonly source: string;
  readonly retryLabel: string;
  readonly onCancel: () => void;
  /** Null when another attempt cannot be started from here. */
  readonly onRetry: (() => void) | null;
}): ReactNode {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-ui-sm text-destructive">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        {refusal === null ? (
          <span role="alert">{message}</span>
        ) : (
          <ProviderLoginRefusalMessage
            providerId={providerId}
            refusal={refusal}
          />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <ProviderLoginRefusalAction refusal={refusal} />
        {onRetry === null ? null : (
          <Button type="button" size="sm" variant="secondary" onClick={onRetry}>
            {retryLabel}
          </Button>
        )}
        <ReportIssueAction
          context={createReportIssueContext({
            title: "Provider sign-in failed",
            message: null,
            code: null,
            source,
          })}
          presentation="link"
          className={undefined}
        />
      </div>
    </div>
  );
}

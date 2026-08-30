import { useCallback } from "react";
import { AlertTriangle } from "lucide-react";
import { ENV_CREDENTIAL_AUTH_ERROR_CODE } from "@traycer/protocol/host/agent/gui/agent-runtime";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { Button } from "@/components/ui/button";
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
    openSettings({ section: "providers", resetToGeneral: false });
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
}

// Static error row. Auth errors (`code: "auth"`) render here like any other
// error - the durable transcript row is what keeps a headless (A2A-triggered)
// auth failure visible after the composer's re-auth banner clears.
export function ErrorSegment({
  code,
  findUnitId,
  message,
  recoverable,
  harnessId,
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
  return (
    <div
      data-chat-find-unit={findUnitId ?? undefined}
      className="flex w-full flex-col gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-ui-sm"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle
          className="mt-0.5 size-3.5 shrink-0 text-destructive"
          aria-hidden
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-overline font-semibold uppercase text-destructive">
              Error
            </span>
            {code !== null && code.length > 0 ? (
              <span className="rounded border border-destructive/30 bg-destructive/10 px-1 font-mono text-code-xs text-destructive">
                {code}
              </span>
            ) : null}
          </div>
          <span className="whitespace-pre-wrap break-words text-foreground/90">
            {message}
          </span>
          {code === ENV_CREDENTIAL_AUTH_ERROR_CODE ? (
            <EnvCredentialSettingsAction harnessId={harnessId} />
          ) : null}
        </div>
        <ReportIssueAction
          context={buildReportContext}
          presentation="icon"
          className="-mt-1 -mr-1 shrink-0"
        />
      </div>
    </div>
  );
}

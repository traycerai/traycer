import type { ReactNode } from "react";
import { toast } from "sonner";
import {
  sandboxSupportReference,
  type SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import {
  sandboxSettingsEvidence,
  sandboxSettingsFailed,
  sandboxSettingsStepsLine,
} from "@traycer/protocol/host/sandbox-settings";
import { useSandboxRowSessionReport } from "@/hooks/sandboxes/use-sandbox-session-report";
import { unusedSettingLabel } from "@/components/settings/details/details-unused-setting";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  sandboxConfigurationOf,
  useSandboxConfigurations,
  useSandboxWakeString,
} from "@/hooks/sandboxes/use-sandbox-configurations";
import { useSandboxCosts } from "@/hooks/sandboxes/use-sandbox-costs-query";
import { useSandboxList } from "@/hooks/sandboxes/use-sandbox-list-query";
import { useSandboxOperation } from "@/hooks/sandboxes/use-sandbox-operation";
import { useSandboxSettingsStatus } from "@/hooks/sandboxes/use-sandbox-settings-status";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { useSampledNow } from "@/lib/relative-time";
import {
  sandboxDetailsEntry,
  type SandboxDetailsExport,
} from "@/lib/sandboxes/sandbox-details-provider";
import {
  formatSandboxDate,
  sandboxSessionPills,
  sandboxSessionsLine,
} from "@/lib/sandboxes/sandbox-row-lines";
import {
  SANDBOX_LIST_FAILED,
  sandboxVerbFailureLine,
} from "@/lib/sandboxes/sandbox-strings";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  closeSandboxDetails,
  useSandboxDetailsStore,
} from "@/stores/sandboxes/sandbox-details-store";

/**
 * The Details drawer for one sandbox, opened by `openSandboxDetails` from a
 * Sandboxes row, a failed row, the hover card or a notification. Mounted once
 * at the app root. Cloud-backed: it reads the sandbox list and the cost
 * ledger, so it opens for a host that is offline, and reading it never wakes
 * or spends; an awake sandbox's own host adds its settings delivery. It lists
 * nothing it was not opened for.
 */
export function SandboxDetailsDrawerHost(): ReactNode {
  const sandboxId = useSandboxDetailsStore((s) => s.sandboxId);
  return (
    <Sheet
      open={sandboxId !== null}
      onOpenChange={(open) => {
        if (!open) closeSandboxDetails();
      }}
    >
      <SheetContent
        side="right"
        className="gap-0 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-md"
        data-testid="sandbox-details-drawer"
      >
        {sandboxId === null ? null : (
          <SandboxDetailsBody sandboxId={sandboxId} />
        )}
      </SheetContent>
    </Sheet>
  );
}

function SandboxDetailsBody(props: { readonly sandboxId: string }): ReactNode {
  const list = useSandboxList();
  const summary =
    list.data?.sandboxes.find((row) => row.id === props.sandboxId) ?? null;
  if (summary === null) {
    // A failed read leaves no data either; it says so and offers Retry
    // rather than loading for ever.
    const failed = list.data === undefined && list.isError;
    let description = "This sandbox is no longer listed: it was destroyed.";
    if (failed) description = SANDBOX_LIST_FAILED;
    else if (list.data === undefined) {
      description = "Loading this sandbox's details…";
    }
    return (
      <>
        <SheetHeader>
          <SheetTitle>Details</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        {failed ? (
          <div className="px-4 pb-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={list.isFetching}
              onClick={() => void list.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : null}
        <p className="px-4 text-ui-xs text-muted-foreground">
          {`Support reference ${props.sandboxId}`}
        </p>
      </>
    );
  }
  return <SandboxDetailsSections summary={summary} />;
}

/**
 * The export with this view's last failed operation's raw code: Details
 * shows only its support reference, and the raw code goes here.
 */
function withOperationFailure(
  exported: SandboxDetailsExport,
  code: string | null,
): SandboxDetailsExport {
  if (code === null) return exported;
  return {
    ...exported,
    status: { ...exported.status, "Operation failure code": code },
  };
}

function SandboxDetailsSections(props: {
  readonly summary: SandboxSummary;
}): ReactNode {
  const { summary } = props;
  const operation = useSandboxOperation(summary.id);
  const costs = useSandboxCosts();
  const wake = useSandboxWakeString(summary);
  const viewerUserId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  const configurations = useSandboxConfigurations();
  const now = useSampledNow();
  const entry = sandboxDetailsEntry({
    summary,
    cost:
      costs.data?.sandboxes.find((cost) => cost.sandboxId === summary.id) ??
      null,
    wakeString: wake,
    viewerUserId,
    // Personal only once every team answered: a team row from a server
    // that names no creator is never the viewer's.
    personal:
      configurations.complete &&
      sandboxConfigurationOf(summary, configurations.configurations)?.kind ===
        "personal",
    now,
  });
  const clipboard = useClipboardCopy({
    resetMs: 2000,
    onSuccess: null,
    onError: () => toast.error("Couldn't copy the diagnostics."),
  });
  return (
    <>
      <SheetHeader>
        <SheetTitle className="wrap-anywhere">{summary.displayName}</SheetTitle>
        <SheetDescription>Details</SheetDescription>
      </SheetHeader>
      <section
        aria-label="Status"
        className="flex flex-col gap-2 px-4 pb-4"
        data-testid="sandbox-details-status"
      >
        <h3 className="text-ui-sm font-medium">Status</h3>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-ui-xs">
          {entry.status.map((row) => (
            <div key={row.label} className="contents">
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="wrap-anywhere">{row.value}</dd>
            </div>
          ))}
          {summary.burst && summary.createdByAgentName !== null ? (
            <>
              <dt className="text-muted-foreground">Created by</dt>
              <dd className="wrap-anywhere">{summary.createdByAgentName}</dd>
              {summary.createdByTaskTitle === null ? null : (
                <>
                  <dt className="text-muted-foreground">For task</dt>
                  <dd className="wrap-anywhere">
                    {summary.createdByTaskTitle}
                  </dd>
                </>
              )}
            </>
          ) : null}
        </dl>
      </section>
      <p className="px-4 pb-4 text-ui-xs text-muted-foreground">
        Today’s costs use the UTC day.
      </p>
      <SandboxDetailsSessions summary={summary} now={now} />
      <SandboxSettingsDeliverySection summary={summary} />
      <section
        aria-label="History"
        className="flex flex-col gap-2 border-t border-border/60 px-4 py-4"
        data-testid="sandbox-details-history"
      >
        <h3 className="text-ui-sm font-medium">History</h3>
        <ol className="flex list-none flex-col gap-1 p-0 text-ui-xs">
          {operation?.kind === "failed" ? (
            <li
              className="space-y-1 wrap-anywhere"
              data-testid="sandbox-details-operation-failure"
            >
              <p>
                {sandboxVerbFailureLine(
                  operation.verb,
                  summary.displayName,
                  operation.reference,
                )}
              </p>
              <p>{operation.error.message}</p>
              <p>{`Support reference: ${operation.reference}`}</p>
            </li>
          ) : null}
          {entry.history.map((event) => (
            <li
              key={`${event.at}:${event.label}:${event.value}`}
              className="wrap-anywhere"
            >
              {event.at === null ? (
                event.label
              ) : (
                <>
                  <span className="text-muted-foreground">
                    {formatSandboxDate(event.at, true)}
                  </span>
                  {` · ${event.label}`}
                </>
              )}
              {event.value.length === 0 ? null : ` ${event.value}`}
            </li>
          ))}
        </ol>
      </section>
      <section
        aria-label="Export diagnostics"
        className="flex flex-col items-start gap-2 border-t border-border/60 px-4 py-4"
      >
        <h3 className="text-ui-sm font-medium">Export diagnostics</h3>
        <p className="text-ui-xs text-muted-foreground">
          Status and History as data, with no values, sessions or paths.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="sandbox-details-export"
          onClick={() =>
            clipboard.copy(
              JSON.stringify(
                withOperationFailure(
                  entry.export(),
                  operation?.kind === "failed" ? operation.code : null,
                ),
                null,
                2,
              ),
            )
          }
        >
          {clipboard.copied ? "Copied" : "Copy diagnostics"}
        </Button>
      </section>
    </>
  );
}

/** Session reports stay in Details so the list shows lifecycle facts once. */
function SandboxDetailsSessions(props: {
  readonly summary: SandboxSummary;
  readonly now: number;
}): ReactNode {
  const { report } = useSandboxRowSessionReport(props.summary);
  if (props.summary.state !== "awake") return null;
  return (
    <section
      aria-label="Sessions"
      className="flex flex-col gap-2 border-t border-border/60 px-4 py-4"
    >
      <h3 className="text-ui-sm font-medium">Sessions</h3>
      <p className="text-ui-xs text-muted-foreground wrap-anywhere">
        {sandboxSessionsLine(report, props.now)}
      </p>
      <ul className="flex min-w-0 flex-col gap-1.5 text-ui-xs">
        {sandboxSessionPills(report).map((pill) => (
          <li
            key={pill.key}
            className="flex min-w-0 items-start gap-1.5 wrap-anywhere"
            data-testid="sandbox-details-session-pill"
          >
            {pill.working ? (
              <span
                aria-hidden
                className="mt-1 size-1.5 shrink-0 rounded-full bg-success"
              />
            ) : null}
            <span className="min-w-0">{pill.label}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * What the sandbox's host says of its configuration's settings: what applied
 * and what didn't, then each setting for an agent sandboxes don't run, apart.
 * Read only while the sandbox is awake; reading it never wakes one.
 */
function SandboxSettingsDeliverySection(props: {
  readonly summary: SandboxSummary;
}): ReactNode {
  const status = useSandboxSettingsStatus(props.summary).data;
  if (props.summary.state !== "awake") return null;
  const items = status?.items ?? [];
  const steps = sandboxSettingsStepsLine(
    sandboxSettingsEvidence(items, props.summary.guestConfigured),
  );
  const unused = items.filter((item) => item.status === "not_used");
  // The Support reference row above names a reference only for a mapped
  // failure code; a settings failure without one is SBX-0520.
  const reference =
    (props.summary.guestConfigured === false || sandboxSettingsFailed(items)) &&
    sandboxSupportReference(props.summary.failureCode) === null
      ? "SBX-0520"
      : null;
  if (steps.length === 0 && unused.length === 0) return null;
  return (
    <section
      aria-label="Settings delivery"
      className="flex flex-col gap-2 border-t border-border/60 px-4 py-4"
      data-testid="sandbox-details-settings-delivery"
    >
      <h3 className="text-ui-sm font-medium">Settings delivery</h3>
      {steps.length === 0 ? null : <p className="text-ui-xs">{steps}</p>}
      {reference === null ? null : (
        <p className="text-ui-xs text-muted-foreground">
          {`Support reference: ${reference}`}
        </p>
      )}
      {unused.length === 0 ? null : (
        <ul className="flex list-none flex-col gap-1 p-0 text-ui-xs text-muted-foreground">
          {unused.map((item) => (
            <li key={item.key}>
              {`${unusedSettingLabel(item.key)} · not used on sandboxes`}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

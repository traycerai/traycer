import { useId, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import { KnownHostSessionsList } from "@/components/host/host-restart-sessions";
import {
  HostReportedSessionsList,
  SandboxSessionPillBadge,
} from "@/components/hosts/sandbox-reported-sessions";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  sandboxConfigurationOf,
  useSandboxConfigurations,
  useSandboxWakeString,
} from "@/hooks/sandboxes/use-sandbox-configurations";
import {
  useSandboxDestroyBatch,
  type SandboxBatchOutcome,
  type SandboxBatchResult,
  type SandboxBatchTarget,
} from "@/hooks/sandboxes/use-sandbox-destroy-batch-mutation";
import { useSandboxDestroy } from "@/hooks/sandboxes/use-sandbox-destroy-mutation";
import { useSandboxKeep } from "@/hooks/sandboxes/use-sandbox-keep-mutation";
import { useSandboxPatch } from "@/hooks/sandboxes/use-sandbox-patch-mutation";
import { useSandboxSessionReport } from "@/hooks/sandboxes/use-sandbox-session-report";
import { useSandboxVerb } from "@/hooks/sandboxes/use-sandbox-verb-mutation";
import { useSandboxOperation } from "@/hooks/sandboxes/use-sandbox-operation";
import {
  SANDBOX_SESSIONS_CAPTION,
  sandboxDestroySessionsSentence,
  sandboxRestingPreview,
  sandboxStopDestroySentence,
  sandboxTypedNameReason,
  toastSandboxVerbOutcome,
} from "@/components/hosts/sandbox-confirm-model";
import { useSampledNow } from "@/lib/relative-time";
import {
  SANDBOX_DEFAULT_IDLE_MINUTES,
  SANDBOX_DEFAULT_RESTING_MINUTES,
  configurationCopy,
  formatSandboxDate,
  sandboxIdleRefusal,
  sandboxMemberName,
  sandboxPeriodDraft,
  sandboxPeriodMinutes,
  sandboxRestingRefusal,
  sandboxSessionPills,
  sandboxSessionsLine,
  type SandboxPageConfiguration,
  type SandboxPeriodDraft,
  type SandboxPeriodUnit,
  type SandboxSessionReport,
} from "@/lib/sandboxes/sandbox-row-lines";
import { signedInUserId } from "@/lib/sandboxes/sandbox-account-fence";
import {
  KEEP_THIS_SANDBOX,
  alreadyDestroyedLine,
  configurationLabel,
  keepPreviewLine,
  keptByLine,
  paidByLine,
  startedByLine,
} from "@/lib/sandboxes/sandbox-strings";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * The confirmations Settings › Sandboxes asks before an action that
 * interrupts or ends work (Flow 6): Suspend, Stop, Destroy (typed name) and
 * Keep, each with the host's running-sessions count and its own outcome
 * sentences; and the two small editors over the patch, Rename and Idle
 * settings. Each dialog is self-contained: it reads what it says and runs its
 * own mutation, so a row, the hover card and the sandbox card open the same
 * one by setting `open`.
 */

interface SandboxDialogProps {
  readonly sandbox: SandboxSummary;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/** The configuration a dialog speaks for; Personal before the teams read. */
function useDialogConfiguration(
  sandbox: SandboxSummary,
): SandboxPageConfiguration {
  const { configurations } = useSandboxConfigurations();
  return (
    sandboxConfigurationOf(sandbox, configurations) ?? { kind: "personal" }
  );
}

function useViewerUserId(): string | null {
  return useAuthStore((s) => s.contextMetadata?.userId ?? null);
}

/**
 * The host's running-sessions count, read only while the dialog is open on
 * an awake sandbox: a resting one has no sessions, and a read never wakes it.
 */
function useDialogSessions(
  sandbox: SandboxSummary,
  open: boolean,
): SandboxSessionReport {
  return useSandboxSessionReport(
    sandbox.hostId,
    open && sandbox.state === "awake",
  ).report;
}

/** `your Acme credits` / `Priya's Acme credits` / `your credits`. */
function storageCredits(
  sandbox: SandboxSummary,
  configuration: SandboxPageConfiguration,
  viewerUserId: string | null,
): string {
  if (configuration.kind === "personal") return "your credits";
  const payer =
    sandbox.wakePayer === null
      ? "you"
      : sandboxMemberName(sandbox.wakePayer, viewerUserId);
  return `${payer === "you" ? "your" : `${payer}'s`} ${configuration.teamName} credits`;
}

/**
 * The sessions count line with its pills, the named sessions (the host's
 * own list while live, else the ones this window knows of), and the caption, inside every confirmation that interrupts
 * something. Destroy says the count in its sentence (`countLine: false`). A
 * named session's link closes the dialog it opens from.
 */
export function SandboxSessionsBlock(props: {
  readonly report: SandboxSessionReport;
  readonly countLine: boolean;
  readonly trailing: string | null;
  readonly hostId: string;
  readonly onNavigate: () => void;
}): ReactNode {
  const now = useSampledNow();
  return (
    <div
      className="flex flex-col gap-1 border-t border-border/60 px-5 py-3"
      data-testid="sandbox-confirm-sessions"
    >
      {props.countLine ? (
        <p
          className="flex flex-wrap items-center gap-1.5 text-ui-sm font-medium"
          data-testid="sandbox-confirm-sessions-line"
        >
          {sandboxSessionsLine(props.report, now)}
          {sandboxSessionPills(props.report).map((pill) => (
            <SandboxSessionPillBadge
              key={pill.key}
              pill={pill}
              testId="sandbox-confirm-session-pill"
            />
          ))}
        </p>
      ) : null}
      {props.report.kind === "live" ? (
        <HostReportedSessionsList
          hostId={props.hostId}
          sessions={props.report.sessions}
          onNavigate={props.onNavigate}
        />
      ) : (
        <KnownHostSessionsList
          hostId={props.hostId}
          disabled={false}
          onNavigate={props.onNavigate}
        />
      )}
      <p className="text-ui-xs text-muted-foreground">
        {props.trailing === null
          ? SANDBOX_SESSIONS_CAPTION
          : `${SANDBOX_SESSIONS_CAPTION} ${props.trailing}`}
      </p>
    </div>
  );
}

// ── Suspend and Stop ────────────────────────────────────────────────────────

function VerbConfirmDialog(
  props: SandboxDialogProps & {
    readonly verb: "suspend" | "stop";
    readonly title: string;
    readonly outcome: string;
    readonly told: string | null;
    readonly actionLabel: string;
  },
): ReactNode {
  const verb = useSandboxVerb(props.sandbox.id);
  const operation = useSandboxOperation(props.sandbox.id);
  const pending = operation?.kind === "pending";
  const report = useDialogSessions(props.sandbox, props.open);
  return (
    <Dialog
      open={props.open}
      onOpenChange={pending ? undefined : props.onOpenChange}
    >
      <DialogContent
        layout="banded"
        className="w-full min-w-0"
        style={{ maxWidth: "min(92vw, 30rem)" }}
        showCloseButton={false}
        data-testid={`sandbox-confirm-${props.verb}`}
      >
        <DialogHeader>
          <DialogTitle className="wrap-anywhere">{props.title}</DialogTitle>
          <DialogDescription className="wrap-anywhere">
            {props.outcome}
          </DialogDescription>
        </DialogHeader>
        <SandboxSessionsBlock
          report={report}
          countLine
          trailing={props.told}
          hostId={props.sandbox.hostId}
          onNavigate={() => props.onOpenChange(false)}
        />
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => props.onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={pending}
            data-testid={`sandbox-confirm-${props.verb}-action`}
            onClick={() => {
              props.onOpenChange(false);
              verb.mutate(props.verb, {
                onSuccess: (outcome) => {
                  toastSandboxVerbOutcome(
                    props.verb,
                    outcome,
                    props.sandbox.displayName,
                  );
                },
              });
            }}
          >
            {pending ? (
              <AgentSpinningDots
                className={undefined}
                testId={undefined}
                variant={undefined}
              />
            ) : null}
            {props.actionLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function SandboxSuspendDialog(props: SandboxDialogProps): ReactNode {
  const configuration = useDialogConfiguration(props.sandbox);
  const viewerUserId = useViewerUserId();
  const wake = useSandboxWakeString(props.sandbox);
  const team = configuration.kind === "team";
  const storage = team
    ? `Storage uses ${storageCredits(props.sandbox, configuration, viewerUserId)} until another member wakes it.`
    : `Storage uses ${storageCredits(props.sandbox, configuration, viewerUserId)}.`;
  const outcome = [
    wake === null ? null : `${wake}.`,
    "Agent turns in progress are interrupted and continue from the transcript on resume; a coding CLI signed in on its own is signed out before the pause.",
    storage,
  ]
    .filter((part): part is string => part !== null)
    .join(" ");
  return (
    <VerbConfirmDialog
      {...props}
      verb="suspend"
      title={`Suspend ${props.sandbox.displayName}?`}
      outcome={outcome}
      told={
        team
          ? "They and you are told who suspended it and whether it completed."
          : null
      }
      actionLabel="Suspend"
    />
  );
}

export function SandboxStopDialog(props: SandboxDialogProps): ReactNode {
  const configuration = useDialogConfiguration(props.sandbox);
  const viewerUserId = useViewerUserId();
  const now = useSampledNow();
  const team = configuration.kind === "team";
  const destroyed = sandboxStopDestroySentence(
    props.sandbox.destroyAfterRestingMinutes,
    now,
  );
  return (
    <VerbConfirmDialog
      {...props}
      verb="stop"
      title={`Stop ${props.sandbox.displayName}?`}
      outcome={[
        "Stop ends every process; Start is a cold boot and only shells marked relaunch come back.",
        `The disk is kept at the lower storage rate on ${storageCredits(props.sandbox, configuration, viewerUserId)}.`,
        destroyed,
      ]
        .filter((part): part is string => part !== null)
        .join(" ")}
      told={
        team
          ? "They and you are told who stopped it and whether it completed."
          : null
      }
      actionLabel="Stop"
    />
  );
}

// ── Destroy ─────────────────────────────────────────────────────────────────

export function SandboxDestroyDialog(
  props: SandboxDialogProps & {
    /** Called once the sandbox is gone, for a surface the row leaves. */
    readonly onDestroyed: (() => void) | null;
  },
): ReactNode {
  const [typed, setTyped] = useState("");
  const inputId = useId();
  const destroy = useSandboxDestroy(props.sandbox);
  const operation = useSandboxOperation(props.sandbox.id);
  const configuration = useDialogConfiguration(props.sandbox);
  const report = useDialogSessions(props.sandbox, props.open);
  const team = configuration.kind === "team";
  const name = props.sandbox.displayName;
  const reason = sandboxTypedNameReason(typed, name);
  // A stopped or failed sandbox has no process left to end; one mid-destroy
  // keeps the sentence it opened with.
  const runsNothing =
    props.sandbox.state === "stopped" || props.sandbox.state === "failed";
  return (
    <ConfirmDestructiveDialog
      blockedReason={reason}
      open={props.open}
      onOpenChange={(next) => {
        if (!next) setTyped("");
        props.onOpenChange(next);
      }}
      title={`Destroy ${name}?`}
      description={`${sandboxDestroySessionsSentence(report, team, runsNothing)} The disk is not recoverable; files on it were never synced anywhere. Published chats stay readable.`}
      cascadeSummary={null}
      actionLabel="Destroy"
      isPending={operation?.kind === "pending" && operation.verb === "destroy"}
      onConfirm={() => {
        if (reason !== null) return;
        setTyped("");
        props.onOpenChange(false);
        destroy.mutate(undefined, {
          onSuccess: (gone) => {
            if (gone) {
              toast.success(`Destroyed ${name}`);
              props.onDestroyed?.();
            } else {
              toast.info(`Destroying ${name}…`);
            }
          },
        });
      }}
    >
      {runsNothing ? null : (
        <SandboxSessionsBlock
          report={report}
          countLine={false}
          trailing={team ? "Affected members are told who destroyed it." : null}
          hostId={props.sandbox.hostId}
          onNavigate={() => {
            setTyped("");
            props.onOpenChange(false);
          }}
        />
      )}
      <div className="flex flex-col gap-1.5 px-5 pb-4">
        <Label htmlFor={inputId}>Type the name to confirm</Label>
        <Input
          id={inputId}
          value={typed}
          autoComplete="off"
          placeholder={name}
          data-testid="sandbox-confirm-destroy-typed"
          onChange={(event) => setTyped(event.target.value)}
        />
      </div>
    </ConfirmDestructiveDialog>
  );
}

// ── Keep ────────────────────────────────────────────────────────────────────

const MS_PER_MINUTE = 60_000;

/**
 * Keep this sandbox: adopts an agent sandbox. Previews the result first (the
 * expiry it acquires and the payer it keeps), then keeps it; a keep that
 * loses the race with its own idle destroy says it was already destroyed.
 */
export function SandboxKeepDialog(props: SandboxDialogProps): ReactNode {
  const keep = useSandboxKeep(props.sandbox.id);
  const [lost, setLost] = useState(false);
  const configuration = useDialogConfiguration(props.sandbox);
  const viewerUserId = useViewerUserId();
  const wake = useSandboxWakeString(props.sandbox);
  const now = useSampledNow();
  const name = props.sandbox.displayName;
  const restingDays = SANDBOX_DEFAULT_RESTING_MINUTES / (24 * 60);
  const restsUntil = now + SANDBOX_DEFAULT_RESTING_MINUTES * MS_PER_MINUTE;
  const payer =
    props.sandbox.wakePayer === null
      ? "you"
      : sandboxMemberName(props.sandbox.wakePayer, viewerUserId);
  const who = [
    startedByLine("an agent"),
    keptByLine("you"),
    paidByLine(payer),
  ].join(" · ");
  const idle = [`Suspends after ${SANDBOX_DEFAULT_IDLE_MINUTES} idle min`, wake]
    .filter((part): part is string => part !== null)
    .join(" · ");
  return (
    <Dialog
      open={props.open}
      onOpenChange={(next) => {
        if (keep.isPending) return;
        if (!next) setLost(false);
        props.onOpenChange(next);
      }}
    >
      <DialogContent
        layout="banded"
        className="w-full min-w-0"
        style={{ maxWidth: "min(92vw, 30rem)" }}
        showCloseButton={false}
        data-testid="sandbox-confirm-keep"
      >
        <DialogHeader>
          <DialogTitle className="wrap-anywhere">{`Keep ${name}?`}</DialogTitle>
          <DialogDescription className="wrap-anywhere">
            {keepPreviewLine(restingDays, formatSandboxDate(restsUntil, true))}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1 px-5 py-3 text-ui-sm">
          <p className="text-ui-xs font-medium text-muted-foreground">
            After Keep
          </p>
          <p data-testid="sandbox-confirm-keep-who">{who}</p>
          <p>{idle}</p>
          <p>Listed under Sandboxes you started</p>
          <p className="text-ui-xs text-muted-foreground">
            {`${configurationLabel(configurationCopy(configuration))}'s defaults; change them on the row afterwards. Who started it and who pays are unchanged.`}
          </p>
          {lost ? (
            <p
              className="font-medium text-destructive"
              data-testid="sandbox-confirm-keep-lost"
            >
              {alreadyDestroyedLine(name)}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={keep.isPending}
            onClick={() => {
              setLost(false);
              props.onOpenChange(false);
            }}
          >
            {lost ? "Close" : "Cancel"}
          </Button>
          {lost ? null : (
            <Button
              type="button"
              size="sm"
              disabled={keep.isPending}
              data-testid="sandbox-confirm-keep-action"
              onClick={() => {
                keep.mutate(undefined, {
                  onSuccess: (outcome) => {
                    if (outcome === "gone") {
                      setLost(true);
                      return;
                    }
                    props.onOpenChange(false);
                    toast.success(`Kept ${name}`);
                  },
                });
              }}
            >
              {keep.isPending ? (
                <AgentSpinningDots
                  className={undefined}
                  testId={undefined}
                  variant={undefined}
                />
              ) : null}
              {KEEP_THIS_SANDBOX}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Rename and Idle settings ────────────────────────────────────────────────

/**
 * The frame of the two patch editors. Its form lives inside the dialog's
 * content, which unmounts on close, so each open starts from the row's
 * current values.
 */
function PatchDialogFrame(
  props: SandboxDialogProps & {
    readonly title: string;
    readonly testId: string;
    readonly pending: boolean;
    readonly children: ReactNode;
  },
): ReactNode {
  return (
    <Dialog
      open={props.open}
      onOpenChange={props.pending ? undefined : props.onOpenChange}
    >
      <DialogContent
        layout="banded"
        className="w-full min-w-0"
        style={{ maxWidth: "min(92vw, 28rem)" }}
        showCloseButton={false}
        aria-describedby={undefined}
        data-testid={props.testId}
      >
        <DialogHeader>
          <DialogTitle className="wrap-anywhere">{props.title}</DialogTitle>
        </DialogHeader>
        {props.children}
      </DialogContent>
    </Dialog>
  );
}

function PatchForm(props: {
  readonly testId: string;
  readonly pending: boolean;
  readonly saveDisabled: boolean;
  readonly onCancel: () => void;
  readonly onSave: () => void;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <form
      className="flex flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (!props.saveDisabled && !props.pending) props.onSave();
      }}
    >
      <div className="flex flex-col gap-3 px-5 py-4">{props.children}</div>
      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={props.pending}
          onClick={props.onCancel}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={props.pending || props.saveDisabled}
          data-testid={`${props.testId}-save`}
        >
          {props.pending ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          ) : null}
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Says the row went before the patch landed. */
function toastPatchOutcome(outcome: "saved" | "gone", name: string): void {
  if (outcome === "gone") {
    toast.info(alreadyDestroyedLine(name));
  }
}

export function SandboxRenameDialog(props: SandboxDialogProps): ReactNode {
  const patch = useSandboxPatch(props.sandbox.id);
  return (
    <PatchDialogFrame
      {...props}
      title={`Rename ${props.sandbox.displayName}`}
      testId="sandbox-rename"
      pending={patch.isPending}
    >
      <RenameForm
        sandbox={props.sandbox}
        pending={patch.isPending}
        onCancel={() => props.onOpenChange(false)}
        onSave={(displayName) => {
          patch.mutate(
            {
              displayName,
              idleMinutes: null,
              destroyAfterRestingMinutes: null,
            },
            {
              onSuccess: (outcome) => {
                props.onOpenChange(false);
                toastPatchOutcome(outcome, props.sandbox.displayName);
              },
            },
          );
        }}
      />
    </PatchDialogFrame>
  );
}

function RenameForm(props: {
  readonly sandbox: SandboxSummary;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onSave: (displayName: string) => void;
}): ReactNode {
  const [name, setName] = useState(props.sandbox.displayName);
  const inputId = useId();
  const trimmed = name.trim();
  const invalid = trimmed.length === 0 || trimmed.length > 191;
  return (
    <PatchForm
      testId="sandbox-rename"
      pending={props.pending}
      saveDisabled={invalid || trimmed === props.sandbox.displayName}
      onCancel={props.onCancel}
      onSave={() => props.onSave(trimmed)}
    >
      <Label htmlFor={inputId}>Name</Label>
      <Input
        id={inputId}
        value={name}
        autoComplete="off"
        maxLength={191}
        data-testid="sandbox-rename-input"
        onChange={(event) => setName(event.target.value)}
      />
    </PatchForm>
  );
}

const UNIT_LABEL: Record<SandboxPeriodUnit, string> = {
  minutes: "minutes",
  hours: "hours",
  days: "days",
};

/** A number and a unit, the way every period on these pages is entered. */
export function SandboxPeriodField(props: {
  readonly label: string;
  readonly draft: SandboxPeriodDraft;
  readonly placeholder: string;
  readonly disabled: boolean;
  readonly refusal: string | null;
  readonly testId: string;
  readonly onChange: (draft: SandboxPeriodDraft) => void;
}): ReactNode {
  const inputId = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={inputId}>{props.label}</Label>
      <div className="flex min-w-0 gap-2">
        <Input
          id={inputId}
          inputMode="numeric"
          value={props.draft.value}
          placeholder={props.placeholder}
          disabled={props.disabled}
          aria-invalid={props.refusal !== null}
          data-testid={`${props.testId}-value`}
          onChange={(event) =>
            props.onChange({ ...props.draft, value: event.target.value })
          }
        />
        <Select
          value={props.draft.unit}
          disabled={props.disabled}
          onValueChange={(unit) => {
            if (unit === "minutes" || unit === "hours" || unit === "days") {
              props.onChange({ ...props.draft, unit });
            }
          }}
        >
          <SelectTrigger
            className="w-32 shrink-0"
            aria-label={`${props.label} unit`}
            data-testid={`${props.testId}-unit`}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(UNIT_LABEL) as SandboxPeriodUnit[]).map((unit) => (
              <SelectItem key={unit} value={unit}>
                {UNIT_LABEL[unit]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {props.refusal === null ? null : (
        <p
          className="text-ui-xs text-destructive"
          data-testid={`${props.testId}-refusal`}
        >
          {props.refusal}
        </p>
      )}
    </div>
  );
}

export function SandboxIdleSettingsDialog(
  props: SandboxDialogProps,
): ReactNode {
  const patch = useSandboxPatch(props.sandbox.id);
  return (
    <PatchDialogFrame
      {...props}
      title={`Idle settings for ${props.sandbox.displayName}`}
      testId="sandbox-idle-settings"
      pending={patch.isPending}
    >
      <IdleSettingsForm
        sandbox={props.sandbox}
        pending={patch.isPending}
        onCancel={() => props.onOpenChange(false)}
        onSave={(request) => {
          patch.mutate(
            { displayName: null, ...request },
            {
              onSuccess: (outcome) => {
                props.onOpenChange(false);
                toastPatchOutcome(outcome, props.sandbox.displayName);
              },
            },
          );
        }}
      />
    </PatchDialogFrame>
  );
}

function IdleSettingsForm(props: {
  readonly sandbox: SandboxSummary;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onSave: (request: {
    readonly idleMinutes: number;
    readonly destroyAfterRestingMinutes: number | null;
  }) => void;
}): ReactNode {
  const now = useSampledNow();
  const [idle, setIdle] = useState(() =>
    sandboxPeriodDraft(
      props.sandbox.idleMinutes ?? SANDBOX_DEFAULT_IDLE_MINUTES,
    ),
  );
  const [resting, setResting] = useState(() =>
    sandboxPeriodDraft(props.sandbox.destroyAfterRestingMinutes),
  );
  const idleMinutes = sandboxPeriodMinutes(idle);
  const restingMinutes = sandboxPeriodMinutes(resting);
  const idleRefusal = sandboxIdleRefusal(idleMinutes);
  const restingRefusal = sandboxRestingRefusal(restingMinutes);
  const restingChanged =
    restingMinutes !== props.sandbox.destroyAfterRestingMinutes;
  return (
    <PatchForm
      testId="sandbox-idle-settings"
      pending={props.pending}
      saveDisabled={idleRefusal !== null || restingRefusal !== null}
      onCancel={props.onCancel}
      onSave={() => {
        if (idleMinutes === null || Number.isNaN(idleMinutes)) return;
        props.onSave({
          idleMinutes,
          // `0` is never; `null` leaves the period (and its clock) as it is.
          destroyAfterRestingMinutes: restingChanged
            ? (restingMinutes ?? 0)
            : null,
        });
      }}
    >
      <SandboxPeriodField
        label="Suspend when idle for (at least 2 minutes)"
        draft={idle}
        placeholder="30"
        disabled={props.pending}
        refusal={idleRefusal}
        testId="sandbox-idle-settings-idle"
        onChange={setIdle}
      />
      <p className="text-ui-xs text-muted-foreground">
        Idle means no agent turn in progress, no running shell and no tab
        attached. Agent turns in progress are interrupted and continue from the
        transcript on resume; a coding CLI signed in on its own is signed out
        before the pause.
      </p>
      <SandboxPeriodField
        label="Destroy after resting for (empty: never)"
        draft={resting}
        placeholder="never"
        disabled={props.pending}
        refusal={restingRefusal}
        testId="sandbox-idle-settings-resting"
        onChange={setResting}
      />
      {restingChanged ? (
        <p
          className="text-ui-xs text-muted-foreground"
          data-testid="sandbox-idle-settings-preview"
        >
          {sandboxRestingPreview(restingMinutes, now)}
        </p>
      ) : null}
    </PatchForm>
  );
}

// ── Destroy all idle ────────────────────────────────────────────────────────

const BATCH_OUTCOME_LINE: Record<SandboxBatchOutcome["kind"], string> = {
  destroyed: "destroyed",
  destroying: "destroying",
  gone: "already destroyed",
  skipped: "no longer idle, left as it is",
  failed: "couldn't be destroyed",
};

function batchOutcomeLine(result: SandboxBatchResult): string {
  const line = BATCH_OUTCOME_LINE[result.outcome.kind];
  return result.outcome.kind === "failed"
    ? `${result.name} · ${line}: ${result.outcome.message}`
    : `${result.name} · ${line}`;
}

/**
 * `Destroy all idle`: the enumerated filtered rows, by count and name. The
 * batch is exactly these targets; each reports its own outcome, and a retry
 * never widens the set. Once confirmed, the title, the list and a retry read
 * the confirmed set, not the list, which drops each row as it is destroyed.
 */
export function SandboxDestroyAllIdleDialog(props: {
  readonly targets: readonly SandboxBatchTarget[];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): ReactNode {
  const batch = useSandboxDestroyBatch();
  const results = batch.data ?? null;
  const [confirmed, setConfirmed] = useState<
    readonly SandboxBatchTarget[] | null
  >(null);
  const count = (confirmed ?? props.targets).length;
  return (
    <ConfirmDestructiveDialog
      blockedReason={count === 0 ? "" : null}
      open={props.open}
      dismissableWhilePending
      onOpenChange={(next) => {
        if (!next) {
          batch.reset();
          setConfirmed(null);
        }
        props.onOpenChange(next);
      }}
      title={`Destroy ${count} idle agent ${count === 1 ? "sandbox" : "sandboxes"}?`}
      description="The disk of each is not recoverable; files on them were never synced anywhere. Published chats stay readable."
      cascadeSummary={null}
      actionLabel={results === null ? "Destroy all idle" : "Retry"}
      isPending={batch.isPending}
      // A retry repeats the confirmed set, whatever the list holds since.
      onConfirm={() => {
        const targets = confirmed ?? props.targets;
        setConfirmed(targets);
        batch.mutate({ targets, startedBy: signedInUserId() });
      }}
    >
      <ul
        className="mx-5 mb-4 flex max-h-[30vh] list-none flex-col gap-1 overflow-y-auto p-0 text-ui-sm"
        data-testid="sandbox-destroy-all-idle-targets"
      >
        {results === null
          ? (confirmed ?? props.targets).map((target) => (
              <li key={target.sandboxId} className="wrap-anywhere">
                {target.name}
              </li>
            ))
          : results.map((result) => (
              <li key={result.sandboxId} className="wrap-anywhere">
                {batchOutcomeLine(result)}
              </li>
            ))}
      </ul>
    </ConfirmDestructiveDialog>
  );
}

import { useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { openNewEpicIntent } from "@/lib/commands/actions/new-epic";
import { activateTabIntent } from "@/lib/tab-navigation";
import { toast } from "sonner";
import type {
  SandboxLifecycleVerb,
  SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SandboxDestroyDialog,
  SandboxIdleSettingsDialog,
  SandboxKeepDialog,
  SandboxRenameDialog,
  SandboxStopDialog,
  SandboxSuspendDialog,
} from "@/components/hosts/sandbox-confirm-dialogs";
import { useOpenAutomationTerminal } from "@/components/settings/panels/use-open-automation-terminal";
import { SandboxOperationFailure } from "@/components/hosts/sandbox-operation-failure";
import { SandboxFailedRowActions } from "@/components/hosts/sandbox-failed-row-actions";
import { restingVerb } from "@/components/composer/use-sandbox-staging";
import {
  startStagedTerminal,
  useStagedSandboxRunner,
} from "@/components/composer/use-staged-sandbox-send";
import { toastSandboxVerbOutcome } from "@/components/hosts/sandbox-confirm-model";
import { useComposerSurfaceHostKey } from "@/hooks/host/use-composer-surface-host-pin";
import { useSandboxDestroy } from "@/hooks/sandboxes/use-sandbox-destroy-mutation";
import {
  sandboxOperationShown,
  useSandboxOperation,
  type SandboxRowVerb,
} from "@/hooks/sandboxes/use-sandbox-operation";
import { useSandboxPatch } from "@/hooks/sandboxes/use-sandbox-patch-mutation";
import {
  useSandboxGuestSetupRepairSupported,
  useSandboxRepairGuestConfigurationOnHost,
  useSandboxRepairGuestSetupOnHost,
  useSandboxRetryApplyingSupported,
  useSandboxSettingsOperation,
} from "@/hooks/sandboxes/use-sandbox-repair-guest-configuration-mutation";
import { useSandboxVerb } from "@/hooks/sandboxes/use-sandbox-verb-mutation";
import { useOpenLink } from "@/lib/links/open-link";
import { useSampledNow } from "@/lib/relative-time";
import {
  sandboxAddCreditsUrl,
  sandboxGiveAnotherLabel,
  sandboxRowActionLabel,
  sandboxRowActions,
  type SandboxPageConfiguration,
  type SandboxRowAction,
} from "@/lib/sandboxes/sandbox-row-lines";
import {
  DETAILS,
  alreadyDestroyedLine,
  sandboxVerbPendingLine,
} from "@/lib/sandboxes/sandbox-strings";
import { useRunnerHost } from "@/providers/use-runner-host";
import {
  readStagedSandbox,
  useStagedSandboxStore,
} from "@/stores/composer/staged-sandbox-store";
import { useLandingPanelStore } from "@/stores/home/landing-panel-store";
import { useSurfaceHostSelectionStore } from "@/stores/host/surface-host-selection-store";
import { openSandboxDetails } from "@/stores/sandboxes/sandbox-details-store";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";

type RowDialog = "suspend" | "stop" | "destroy" | "keep" | "rename" | "idle";

const DIALOG_OF: Partial<Record<SandboxRowAction, RowDialog>> = {
  suspend: "suspend",
  stop: "stop",
  destroy: "destroy",
  keep: "keep",
  rename: "rename",
  "idle-settings": "idle",
};

interface SandboxRowActionsProps {
  readonly summary: SandboxSummary;
  readonly configuration: SandboxPageConfiguration;
  readonly unreachable: boolean;
  readonly frozenNeedsOwnCredits: boolean;
  readonly settingsFailed: boolean;
}

/**
 * The row action each confirmation confirms. Rename and Idle settings are
 * editors and stay open through a state change: closing one would drop what
 * was typed.
 */
const CONFIRMS: Partial<Record<RowDialog, SandboxRowAction>> = {
  suspend: "suspend",
  stop: "stop",
  destroy: "destroy",
  keep: "keep",
};

/**
 * The row's open dialog. A confirmation closes once the row stops offering
 * what it confirms, and the row's state line says where the sandbox went.
 * Cleared during render, not masked, so a row that comes back never reopens
 * it.
 */
function useRowDialog(
  offered: (action: SandboxRowAction) => boolean,
): readonly [RowDialog | null, (dialog: RowDialog | null) => void] {
  const [dialog, setDialog] = useState<RowDialog | null>(null);
  const confirming = dialog === null ? undefined : CONFIRMS[dialog];
  if (confirming !== undefined && !offered(confirming)) setDialog(null);
  return [dialog, setDialog];
}

/**
 * One row's actions, by Flow 6's matrix: the primary button, `Give it another
 * <period>` inside the warning lead, `Details` on every row, and the ⋯ menu.
 * Interrupting and ending actions confirm in their dialogs; a wake is one click
 * after the row says who pays.
 */
export function SandboxRowActions(props: SandboxRowActionsProps): ReactNode {
  if (props.summary.state === "failed" && props.summary.kind !== "automation") {
    return (
      <SandboxFailedRowActions
        summary={props.summary}
        configuration={props.configuration}
      />
    );
  }
  return (
    <SandboxLifecycleRowActions
      {...props}
      inlineDetails={
        props.settingsFailed || props.summary.guestConfigured === false
      }
    />
  );
}

function SandboxLifecycleRowActions(
  props: SandboxRowActionsProps & { readonly inlineDetails: boolean },
): ReactNode {
  const { summary, configuration } = props;
  const verb = useSandboxVerb(summary.id);
  const destroy = useSandboxDestroy(summary);
  const operation = useSandboxOperation(summary.id);
  const pendingVerb = operation?.kind === "pending" ? operation.verb : null;
  const patch = useSandboxPatch(summary.id);
  const repair = useSandboxRepairGuestConfigurationOnHost(summary.hostId);
  const repairGuestSetup = useSandboxRepairGuestSetupOnHost(summary.hostId);
  const applyingOperation = useSandboxSettingsOperation(summary.hostId);
  const openLink = useOpenLink();
  const runnerHost = useRunnerHost();
  const openOnLanding = useOpenSandboxOnLanding();
  const openAutomationTerminal = useOpenAutomationTerminal({
    existing: {
      hostId: summary.hostId,
      sandboxId: summary.id,
      awake: summary.state === "awake",
    },
    teamEnvironmentId:
      summary.kind === "automation" && configuration.kind === "team"
        ? summary.environmentId
        : null,
  });
  const now = useSampledNow();
  const actions = sandboxRowActions({
    summary,
    unreachable: props.unreachable,
    frozenNeedsOwnCredits: props.frozenNeedsOwnCredits,
    settingsFailed: props.settingsFailed,
  });
  const primary = useSandboxSettingsPrimaryAction(summary, actions.primary);
  const giveAnother = sandboxGiveAnotherLabel(summary, now);
  const offered = (action: SandboxRowAction): boolean =>
    actions.primary === action || actions.menu.includes(action);
  const [dialog, setDialog] = useRowDialog(offered);
  const shownOperation = sandboxOperationShown(operation, offered);
  const busy =
    pendingVerb !== null ||
    patch.isPending ||
    repair.isPending ||
    repairGuestSetup.isPending ||
    applyingOperation === "pending" ||
    openAutomationTerminal.starting;

  // A team wake no longer asks first: its payer is said where it is picked.
  const wake = (pressed: SandboxLifecycleVerb): void => {
    verb.mutate(pressed, {
      onSuccess: (outcome) =>
        toastSandboxVerbOutcome(pressed, outcome, summary.displayName),
    });
  };
  // The actions that act at once; the rest open their dialog.
  const immediate: Partial<Record<SandboxRowAction, () => void>> = {
    resume: () => wake("resume"),
    start: () => wake("start"),
    // The person chose to pay; the button said so.
    "resume-paying": () => wake("resume"),
    "add-credits": () =>
      void openLink(
        sandboxAddCreditsUrl(runnerHost.signInUrl, configuration),
        "account",
        null,
      ),
    retry: () => openAutomationTerminal.retry(),
    "retry-applying": () => repair.mutate({}),
    "repair-setup": () => repairGuestSetup.mutate({}),
    "open-tab": () =>
      openOnLanding(summary, configuration, { terminal: false }),
    "open-terminal": () =>
      summary.kind === "automation"
        ? openAutomationTerminal.run()
        : openOnLanding(summary, configuration, { terminal: true }),
  };

  const run = (action: SandboxRowAction): void => {
    const opens = DIALOG_OF[action];
    if (opens !== undefined) {
      setDialog(opens);
      return;
    }
    immediate[action]?.();
  };

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      {openAutomationTerminal.failure ? (
        <p role="alert" className="text-ui-xs text-destructive">
          {openAutomationTerminal.failure}
        </p>
      ) : null}
      <SettingsApplyFailure
        operation={applyingOperation}
        name={summary.displayName}
      />
      {giveAnother === null ? null : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          data-testid="sandbox-row-give-another"
          onClick={() =>
            patch.mutate(
              {
                displayName: null,
                idleMinutes: null,
                destroyAfterRestingMinutes: summary.destroyAfterRestingMinutes,
              },
              {
                onSuccess: (outcome) => {
                  if (outcome === "gone") {
                    toast.info(alreadyDestroyedLine(summary.displayName));
                  }
                },
              },
            )
          }
        >
          {patch.isPending ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          ) : null}
          {giveAnother}
        </Button>
      )}
      <SandboxRowPrimaryAction
        primary={primary}
        pendingVerb={pendingVerb}
        configuration={configuration}
        busy={busy}
        dialogOpen={dialog !== null}
        run={run}
      />
      <SandboxRowSettingsFailureActions
        summary={summary}
        configuration={configuration}
        visible={props.inlineDetails}
        menu={actions.menu}
        pendingVerb={pendingVerb}
        busy={busy}
        run={run}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`More actions for ${summary.displayName}`}
            data-testid="sandbox-row-menu"
          >
            <MoreHorizontal className="size-3.5" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" data-testid="sandbox-row-menu-content">
          {actions.menu
            .filter((action) => pendingVerb === null && action !== "destroy")
            .map((action) => (
              <DropdownMenuItem
                key={action}
                disabled={busy}
                data-testid={`sandbox-row-menu-${action}`}
                onSelect={() => run(action)}
              >
                {sandboxRowActionLabel(action, configuration)}
              </DropdownMenuItem>
            ))}
          {props.inlineDetails ? null : (
            <DropdownMenuItem
              data-testid="sandbox-row-menu-details"
              onSelect={() => openSandboxDetails(summary.id)}
            >
              {DETAILS}
            </DropdownMenuItem>
          )}
          {pendingVerb === null && actions.menu.includes("destroy") ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                data-testid="sandbox-row-menu-destroy"
                onSelect={() => run("destroy")}
              >
                {sandboxRowActionLabel("destroy", configuration)}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <SandboxOperationFailure
        sandboxId={summary.id}
        name={summary.displayName}
        configuration={configuration}
        operation={shownOperation}
        busy={busy}
        onRetry={(pressed) => {
          if (pressed === "destroy")
            destroy.mutate(
              operation?.kind === "failed"
                ? operation.destroyRequest
                : undefined,
            );
          else wake(pressed);
        }}
      />
      <SandboxSuspendDialog
        sandbox={summary}
        open={dialog === "suspend"}
        onOpenChange={(open) => setDialog(open ? "suspend" : null)}
      />
      <SandboxStopDialog
        sandbox={summary}
        open={dialog === "stop"}
        onOpenChange={(open) => setDialog(open ? "stop" : null)}
      />
      <SandboxDestroyDialog
        sandbox={summary}
        open={dialog === "destroy"}
        onOpenChange={(open) => setDialog(open ? "destroy" : null)}
        onDestroyed={null}
      />
      <SandboxKeepDialog
        sandbox={summary}
        open={dialog === "keep"}
        onOpenChange={(open) => setDialog(open ? "keep" : null)}
      />
      <SandboxRenameDialog
        sandbox={summary}
        open={dialog === "rename"}
        onOpenChange={(open) => setDialog(open ? "rename" : null)}
      />
      <SandboxIdleSettingsDialog
        sandbox={summary}
        open={dialog === "idle"}
        onOpenChange={(open) => setDialog(open ? "idle" : null)}
      />
    </div>
  );
}

function useSandboxSettingsPrimaryAction(
  summary: SandboxSummary,
  primary: SandboxRowAction | null,
): SandboxRowAction | null {
  const retryApplyingSupported = useSandboxRetryApplyingSupported(
    summary.hostId,
  );
  const repairGuestSetupSupported = useSandboxGuestSetupRepairSupported(
    summary.hostId,
  );
  if (primary !== "retry-applying" || retryApplyingSupported) return primary;
  return summary.guestConfigured === false && repairGuestSetupSupported
    ? "repair-setup"
    : null;
}

function SandboxRowSettingsFailureActions(props: {
  readonly summary: SandboxSummary;
  readonly configuration: SandboxPageConfiguration;
  readonly visible: boolean;
  readonly menu: readonly SandboxRowAction[];
  readonly pendingVerb: SandboxRowVerb | null;
  readonly busy: boolean;
  readonly run: (action: SandboxRowAction) => void;
}): ReactNode {
  const chooseAnother = useChooseAnotherHost();
  if (!props.visible) return null;
  const actions =
    props.pendingVerb === null
      ? props.menu.filter(
          (action) => action === "open-terminal" || action === "stop",
        )
      : [];
  return (
    <>
      {actions.map((action) => (
        <Button
          key={action}
          type="button"
          variant="outline"
          size="sm"
          disabled={props.busy}
          onClick={() => props.run(action)}
        >
          {sandboxRowActionLabel(action, props.configuration)}
        </Button>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={chooseAnother}>
        Choose another host
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => openSandboxDetails(props.summary.id)}
      >
        Details
      </Button>
    </>
  );
}

function SandboxRowPrimaryAction(props: {
  readonly primary: SandboxRowAction | null;
  readonly pendingVerb: SandboxRowVerb | null;
  readonly configuration: SandboxPageConfiguration;
  readonly busy: boolean;
  readonly dialogOpen: boolean;
  readonly run: (action: SandboxRowAction) => void;
}): ReactNode {
  const { primary, pendingVerb } = props;
  if (pendingVerb !== null) {
    return (
      <Button type="button" variant="outline" size="sm" disabled>
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
        <span role="status">{sandboxVerbPendingLine(pendingVerb)}</span>
      </Button>
    );
  }
  if (primary === null) return null;
  return (
    <Button
      type="button"
      variant={primary === "destroy" ? "destructive" : "outline"}
      size="sm"
      disabled={props.busy}
      data-testid={`sandbox-row-${primary}`}
      onClick={() => props.run(primary)}
    >
      {props.busy && !props.dialogOpen ? (
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
      ) : null}
      {sandboxRowActionLabel(primary, props.configuration)}
    </Button>
  );
}

function useChooseAnotherHost(): () => void {
  const surfaceKey = useComposerSurfaceHostKey();
  const navigate = useNavigate();
  const { close } = useSystemTabModalActions();
  return () => {
    useStagedSandboxStore.getState().clear(surfaceKey);
    close();
    activateTabIntent(navigate, openNewEpicIntent(), undefined);
  };
}

/**
 * `Open a tab` and `Open terminal`: points the landing composer (and the
 * terminal panel beside it, which follows the composer's host) at this
 * sandbox and leaves Settings for a new task. A resting sandbox is staged to
 * resume or start, which replaces a New sandbox staged there before, so the
 * next send never creates one instead. `Open a tab` leaves the wake to the
 * first action there. `Open terminal` IS that first action: an awake
 * sandbox's folderless terminal opens at once, and a resting one wakes now,
 * opening its terminal on the handoff with no message sent.
 */
function useOpenSandboxOnLanding(): (
  summary: SandboxSummary,
  configuration: SandboxPageConfiguration,
  intent: { readonly terminal: boolean },
) => void {
  const surfaceKey = useComposerSurfaceHostKey();
  const { close } = useSystemTabModalActions();
  const navigate = useNavigate();
  const runStaged = useStagedSandboxRunner();
  return (summary, configuration, intent) => {
    // Staged as the composer's picker stages it, so a dead lease's pin cannot
    // send to the fallback host; an awake one drops whatever was staged.
    const verb = summary.frozen ? null : restingVerb(summary.state);
    // This ask replaces one an earlier row press left unserved.
    useLandingPanelStore.getState().clearTerminalRequest();
    if (verb === null) {
      useStagedSandboxStore.getState().clear(surfaceKey);
      if (intent.terminal) {
        useLandingPanelStore
          .getState()
          .requestTerminal(surfaceKey, summary.hostId);
      }
    } else {
      // A stage of this sandbox still on its way (a send waking it) is kept,
      // with the send it hands off; one that stopped short starts over.
      const current = readStagedSandbox(surfaceKey);
      const live =
        current !== null &&
        current.target.kind === "existing" &&
        current.target.sandboxId === summary.id &&
        (current.phase === "staged" ||
          (current.phase === "creating" && current.failure === null));
      if (!live) {
        useStagedSandboxStore.getState().stage(surfaceKey, {
          kind: "existing",
          hostId: summary.hostId,
          sandboxId: summary.id,
          name: summary.displayName,
          configuration:
            configuration.kind === "team"
              ? {
                  kind: "team",
                  teamId: configuration.teamId,
                  teamName: configuration.teamName,
                }
              : { kind: "personal" },
          verb,
        });
      }
      if (intent.terminal) {
        // A live or fresh stage takes the ask (`startStagedTerminal`): it
        // starts the wake unless one is on its way.
        startStagedTerminal(surfaceKey, (fresh) =>
          runStaged(surfaceKey, fresh, {
            taskId: null,
            resume: false,
          }),
        );
      }
    }
    useSurfaceHostSelectionStore
      .getState()
      .setSelection(surfaceKey, summary.hostId);
    close();
    // A new task's tab, not only its route: Settings may be a tab of its own.
    activateTabIntent(navigate, openNewEpicIntent(), undefined);
  };
}

function SettingsApplyFailure(props: {
  readonly operation: "pending" | "failed" | null;
  readonly name: string;
}): ReactNode {
  if (props.operation !== "failed") return null;
  return (
    <p role="alert" className="text-ui-xs text-destructive">
      {props.name}'s settings still didn't apply · SBX-0520
    </p>
  );
}

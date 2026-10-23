import { useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import { v4 as uuidv4 } from "uuid";
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
import { toastSandboxVerbOutcome } from "@/components/hosts/sandbox-confirm-model";
import { useComposerSurfaceHostPin } from "@/hooks/host/use-composer-surface-host-pin";
import { useSandboxCreate } from "@/hooks/sandboxes/use-sandbox-create-mutation";
import { useSandboxPatch } from "@/hooks/sandboxes/use-sandbox-patch-mutation";
import { useSandboxRepairGuestConfigurationOnHost } from "@/hooks/sandboxes/use-sandbox-repair-guest-configuration-mutation";
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
import { DETAILS, alreadyDestroyedLine } from "@/lib/sandboxes/sandbox-strings";
import { useRunnerHost } from "@/providers/use-runner-host";
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

/**
 * One row's actions, by Flow 6's matrix: the primary button, `Give it another
 * <period>` inside the warning lead, `Details` on every row, and the ⋯ menu.
 * Interrupting and ending actions confirm in their dialogs; a wake on a team
 * row asks first, as every team wake does.
 */
export function SandboxRowActions(props: {
  readonly summary: SandboxSummary;
  readonly configuration: SandboxPageConfiguration;
  readonly unreachable: boolean;
  readonly frozenNeedsOwnCredits: boolean;
}): ReactNode {
  const { summary, configuration } = props;
  const [dialog, setDialog] = useState<RowDialog | null>(null);
  const verb = useSandboxVerb(summary.id);
  const patch = useSandboxPatch(summary.id);
  const create = useSandboxCreate();
  const repair = useSandboxRepairGuestConfigurationOnHost(summary.hostId);
  const openLink = useOpenLink();
  const runnerHost = useRunnerHost();
  const openOnLanding = useOpenSandboxOnLanding();
  const now = useSampledNow();
  const actions = sandboxRowActions({
    summary,
    unreachable: props.unreachable,
    frozenNeedsOwnCredits: props.frozenNeedsOwnCredits,
  });
  const giveAnother = sandboxGiveAnotherLabel(summary, now);
  const busy =
    verb.isPending || patch.isPending || create.isPending || repair.isPending;

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
    retry: () =>
      create.mutate(
        {
          request: {
            os: summary.os,
            cpus: summary.cpus,
            memoryMb: summary.memoryMb,
            diskMb: summary.diskMb,
            region: summary.region,
            displayName: summary.displayName,
            idleMinutes: summary.idleMinutes,
            burst: false,
            createdByHostId: null,
            createdByAgentId: null,
            environmentId: summary.environmentId,
            destroyAfterRestingMinutes: null,
            createdByTaskId: null,
            clientRequestId: uuidv4(),
          },
          teamName:
            configuration.kind === "team" ? configuration.teamName : null,
        },
        { onSuccess: () => toast.info(`Starting ${summary.displayName}…`) },
      ),
    "retry-applying": () =>
      repair.mutate(
        {},
        {
          onSuccess: (result) => {
            if (!result.guestConfigured) {
              toast.warning(
                `${summary.displayName}'s settings still didn't apply`,
              );
            }
          },
        },
      ),
    "open-tab": () => openOnLanding(summary.hostId),
    "open-terminal": () => openOnLanding(summary.hostId),
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
      {actions.primary === null ? null : (
        <Button
          type="button"
          variant={actions.primary === "destroy" ? "destructive" : "outline"}
          size="sm"
          disabled={busy}
          data-testid={`sandbox-row-${actions.primary}`}
          onClick={() => {
            if (actions.primary !== null) run(actions.primary);
          }}
        >
          {busy && dialog === null ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          ) : null}
          {sandboxRowActionLabel(actions.primary, configuration)}
        </Button>
      )}
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
            .filter((action) => action !== "destroy")
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
          <DropdownMenuItem
            data-testid="sandbox-row-menu-details"
            onSelect={() => openSandboxDetails(summary.id)}
          >
            {DETAILS}
          </DropdownMenuItem>
          {actions.menu.includes("destroy") ? (
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

/**
 * `Open a tab` and `Open terminal`: points the landing composer (and the
 * terminal panel beside it, which follows the composer's host) at this
 * sandbox and leaves Settings for a new task. A resting sandbox wakes on the
 * first action there, never on this.
 */
function useOpenSandboxOnLanding(): (hostId: string) => void {
  const pin = useComposerSurfaceHostPin();
  const { close } = useSystemTabModalActions();
  const router = useRouter();
  return (hostId: string) => {
    pin.setSelection(hostId);
    close();
    void router.navigate({ to: "/" });
  };
}

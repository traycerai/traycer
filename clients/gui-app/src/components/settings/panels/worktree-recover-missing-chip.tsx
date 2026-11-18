import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { cn } from "@/lib/utils";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isHostScopeUsable } from "@/components/settings/host-scope/host-scope-status";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import { resolveAutoCleanupGate } from "@/components/settings/panels/worktree-auto-cleanup-gate";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import { useHostNegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { hostNegotiatedAtLeast } from "@/hooks/workspace/use-host-recovers-missing-folders";
import { trackSettingChanged } from "@/lib/analytics";
import { configMutationKeys } from "@/lib/query-keys";
import type { HostRpcRegistry } from "@/lib/host";

const WORKTREES_GET = "config.worktrees.get";
const WORKTREES_SET = "config.worktrees.set";

const RECOVER_OPTIONS: ReadonlyArray<{
  readonly value: "on" | "off";
  readonly label: string;
  readonly description: string;
}> = [
  {
    value: "on",
    label: "Recover",
    description:
      "When a worktree is gone, the run uses its repository folder. A folder that is gone is removed from the chat.",
  },
  {
    value: "off",
    label: "Stop",
    description: "The run is refused until you fix the folder.",
  },
];

/**
 * Settings ▸ Worktrees ▸ Missing folders - whether this host recovers a run
 * whose bound worktree or folder is gone, beside the host's other two worktree
 * policies.
 *
 * Renders nothing unless the host is reachable and has negotiated the
 * setting: an older host refuses those runs whatever a control here said.
 */
export function WorktreeRecoverMissingChip(props: {
  readonly scope: HostScope;
}): ReactNode {
  const { scope } = props;
  const hostId = scope.hostId;
  const reachability = useHostReachability(hostId ?? "");
  const getVersion = useHostNegotiatedMethodVersion(
    scope.client,
    WORKTREES_GET,
  );
  const setVersion = useHostNegotiatedMethodVersion(
    scope.client,
    WORKTREES_SET,
  );
  // The neighbouring chips' gate ladder: a host seen on 1.1 keeps its
  // negotiated versions while offline or starting, and reading the setting
  // then would report the failure as a broken config file.
  const gate = resolveAutoCleanupGate({
    hostId,
    scopeUsable: isHostScopeUsable(scope.status),
    reachabilityStatus: reachability.status,
    hasClient: scope.client !== null,
    supported:
      getVersion === null || setVersion === null
        ? null
        : hostNegotiatedAtLeast(getVersion, 1) &&
          hostNegotiatedAtLeast(setVersion, 1),
  });
  if (gate !== "ready" || hostId === null) return null;
  // Keyed by host, like its neighbours: a switch between two usable hosts must
  // not carry an open menu across.
  return (
    <RecoverMissingChip
      key={hostId}
      client={scope.client}
      hostLabel={scope.hostLabel}
    />
  );
}

function RecoverMissingChip(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostLabel: string;
}): ReactNode {
  const { client } = props;
  const query = useHostQuery<HostRpcRegistry, "config.worktrees.get">({
    cacheKeyIdentity: undefined,
    client,
    method: WORKTREES_GET,
    params: {},
    options: { enabled: true },
  });
  const setRecover = useHostScopedMutationForClient(client, {
    method: WORKTREES_SET,
    mutationKey: configMutationKeys.worktreesRecoverMissingSet(),
    errorMessage: "Couldn't update the missing folders setting",
    invalidateMethods: [WORKTREES_GET],
  });
  const recover = query.data?.recoverMissing ?? null;
  const value = recoverMenuValue(recover);
  const current =
    RECOVER_OPTIONS.find((option) => option.value === value) ?? null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Missing folders setting"
          data-testid="worktree-recover-missing-chip"
          className={cn(
            "inline-flex min-w-0 max-w-full shrink items-center gap-1.5 rounded-full border border-border/60 px-2.5 py-1 text-ui-xs text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
            "hover:bg-foreground/5 hover:text-foreground",
          )}
        >
          <span className="min-w-0 truncate">
            {current === null
              ? "Missing folders"
              : `Missing folders · ${current.label}`}
          </span>
          {setRecover.isPending ? (
            <AgentSpinningDots
              className={undefined}
              testId="worktree-recover-missing-saving"
              variant={undefined}
              tone="muted"
            />
          ) : (
            <ChevronDown className="size-3 shrink-0" aria-hidden />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-[min(88vw,20rem)]"
        data-testid="worktree-recover-missing-menu"
      >
        <DropdownMenuLabel>Missing folders</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {query.isError ? (
          <p role="alert" className="px-1.5 py-1 text-ui-xs text-destructive">
            Couldn&apos;t read this host&apos;s setting. Repair Traycer&apos;s
            config.json on that computer, or back it up before resetting it,
            then reopen Settings.
          </p>
        ) : (
          <DropdownMenuRadioGroup
            value={value}
            onValueChange={(next) => {
              const match = RECOVER_OPTIONS.find(
                (option) => option.value === next,
              );
              if (match === undefined || match.value === value) return;
              trackSettingChanged("worktrees", "worktreeRecoverMissing");
              setRecover.mutate({
                agentCreate: null,
                recoverMissing: match.value === "on",
              });
            }}
          >
            {RECOVER_OPTIONS.map((option) => (
              <DropdownMenuRadioItem
                key={option.value}
                value={option.value}
                disabled={recover === null || setRecover.isPending}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="text-foreground">{option.label}</span>
                  <span className="text-ui-xs text-pretty text-muted-foreground">
                    {option.description}
                  </span>
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        )}
        <DropdownMenuSeparator />
        <p className="px-1.5 py-1 text-ui-xs text-pretty text-muted-foreground">
          Applies to runs on {props.hostLabel}, from the next one.
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function recoverMenuValue(recover: boolean | null): "on" | "off" | "" {
  if (recover === null) return "";
  return recover ? "on" : "off";
}

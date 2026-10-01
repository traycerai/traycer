import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import type { AgentWorktreeCreatePolicy } from "@traycer/protocol/config/schema";
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
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { isHostScopeUsable } from "@/components/settings/host-scope/host-scope-status";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import {
  resolveAutoCleanupGate,
  type AutoCleanupGate,
} from "@/components/settings/panels/worktree-auto-cleanup-gate";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { trackSettingChanged } from "@/lib/analytics";
import { configMutationKeys } from "@/lib/query-keys";
import type { HostRpcRegistry } from "@/lib/host";

const AGENT_WORKTREES_GET = "config.worktrees.get";
const AGENT_WORKTREES_SET = "config.worktrees.set";

/** Same shell as the automatic-cleanup chip beside it. */
const AGENT_WORKTREES_CHIP_CLASS =
  "inline-flex min-w-0 max-w-full shrink items-center gap-1.5 rounded-full border border-border/60 px-2.5 py-1 text-ui-xs text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

const POLICY_OPTIONS: ReadonlyArray<{
  readonly value: AgentWorktreeCreatePolicy;
  readonly label: string;
  readonly description: string;
}> = [
  {
    value: "allow",
    label: "Allow",
    description: "Agents create worktrees when they need them.",
  },
  {
    value: "ask",
    label: "Ask first",
    description: "An agent asks you in its chat before creating one.",
  },
  {
    value: "never",
    label: "Never",
    description: "Agents keep working in the workspace they were given.",
  },
];

/**
 * Settings ▸ Worktrees ▸ Agent worktrees — what an agent's
 * `traycer_create_worktree` call does on this host, as ONE chip beside
 * Automatic cleanup: the host's two worktree policies, who may create them and
 * who cleans them up, side by side.
 *
 * The host enforces it on every call, so a change governs the next request of
 * an agent already running. It governs agents running on THIS host; worktrees
 * the user creates themselves are not affected.
 *
 * Shares the cleanup chip's gate ladder (scope usable, reachable, handshake
 * advertises both methods): a host too old to enforce the policy shows an inert
 * chip that says so, never a control whose every change fails.
 */
export function WorktreeAgentCreateChip(props: {
  readonly scope: HostScope;
}): ReactNode {
  const { scope } = props;
  const hostId = scope.hostId;
  const reachability = useHostReachability(hostId ?? "");
  // Both methods, because they negotiate independently: a host that could
  // answer the read but not the write would render a menu whose every choice
  // fails. Two statements, not one `&&` - a short-circuited hook call is a
  // rules-of-hooks violation.
  const getSupported = useHostMethodSupport(hostId, AGENT_WORKTREES_GET);
  const setSupported = useHostMethodSupport(hostId, AGENT_WORKTREES_SET);
  const gate = resolveAutoCleanupGate({
    hostId,
    scopeUsable: isHostScopeUsable(scope.status),
    reachabilityStatus: reachability.status,
    hasClient: scope.client !== null,
    supported:
      getSupported === null || setSupported === null
        ? null
        : getSupported && setSupported,
  });

  if (gate === "absent") return null;
  if (gate !== "ready") {
    return (
      <AgentWorktreesUnavailableChip gate={gate} hostLabel={scope.hostLabel} />
    );
  }
  if (hostId === null) return null;
  // Keyed by host, like the cleanup chip: a switch straight from one usable
  // host to another must not carry an open menu across.
  return (
    <AgentWorktreesPolicyChip
      key={hostId}
      client={scope.client}
      hostLabel={scope.hostLabel}
    />
  );
}

/**
 * `aria-disabled` rather than `disabled`, for the cleanup chip's reason: a
 * disabled button takes neither pointer nor focus, so the tooltip explaining
 * what is wrong with the host would be unreachable.
 */
function AgentWorktreesUnavailableChip(props: {
  readonly gate: Exclude<AutoCleanupGate, "absent" | "ready">;
  readonly hostLabel: string;
}): ReactNode {
  return (
    <TooltipWrapper
      label={agentWorktreesUnavailableCopy(props.gate, props.hostLabel)}
      side="bottom"
      sideOffset={undefined}
      align="start"
    >
      <button
        type="button"
        aria-disabled
        aria-label="Agent worktrees setting"
        data-testid="worktree-agent-create-chip"
        data-gate={props.gate}
        className={cn(
          AGENT_WORKTREES_CHIP_CLASS,
          "cursor-not-allowed opacity-60",
        )}
      >
        <span className="min-w-0 truncate">Agent worktrees</span>
      </button>
    </TooltipWrapper>
  );
}

function agentWorktreesUnavailableCopy(
  gate: Exclude<AutoCleanupGate, "absent" | "ready">,
  hostLabel: string,
): string {
  if (gate === "checking") {
    return `Checking whether ${hostLabel} supports the agent worktrees setting…`;
  }
  if (gate === "offline") {
    return `The agent worktrees setting is unavailable while ${hostLabel} is offline.`;
  }
  return `${hostLabel} is running a version without the agent worktrees setting. Update the host to choose whether agents may create worktrees.`;
}

function AgentWorktreesPolicyChip(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostLabel: string;
}): ReactNode {
  const { client } = props;
  const query = useHostQuery<HostRpcRegistry, "config.worktrees.get">({
    cacheKeyIdentity: undefined,
    client,
    method: AGENT_WORKTREES_GET,
    params: {},
    options: { enabled: true },
  });
  const setPolicy = useHostScopedMutationForClient(client, {
    method: AGENT_WORKTREES_SET,
    mutationKey: configMutationKeys.worktreesSet(),
    errorMessage: "Couldn't update the agent worktrees setting",
    invalidateMethods: [AGENT_WORKTREES_GET],
  });
  const policy = query.data?.agentCreate ?? null;
  const current =
    POLICY_OPTIONS.find((option) => option.value === policy) ?? null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Agent worktrees setting"
          data-testid="worktree-agent-create-chip"
          data-policy={policy ?? undefined}
          className={cn(
            AGENT_WORKTREES_CHIP_CLASS,
            "hover:bg-foreground/5 hover:text-foreground",
          )}
        >
          <span className="min-w-0 truncate">
            {current === null
              ? "Agent worktrees"
              : `Agent worktrees · ${current.label}`}
          </span>
          {setPolicy.isPending ? (
            <AgentSpinningDots
              className={undefined}
              testId="worktree-agent-create-saving"
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
        data-testid="worktree-agent-create-menu"
      >
        <DropdownMenuLabel>Agent worktrees</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {query.isError ? (
          <p role="alert" className="px-1.5 py-1 text-ui-xs text-destructive">
            Couldn&apos;t read this host&apos;s setting. Repair
            ~/.traycer/cli/config.json on that machine, or back it up before
            resetting it, then reopen Settings.
          </p>
        ) : (
          <DropdownMenuRadioGroup
            value={policy ?? ""}
            onValueChange={(next) => {
              const match = POLICY_OPTIONS.find(
                (option) => option.value === next,
              );
              if (match === undefined || match.value === policy) return;
              trackSettingChanged("worktrees", "agentWorktreeCreate");
              setPolicy.mutate({ agentCreate: match.value });
            }}
          >
            {POLICY_OPTIONS.map((option) => (
              <DropdownMenuRadioItem
                key={option.value}
                value={option.value}
                disabled={policy === null || setPolicy.isPending}
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
          Applies to agents running on {props.hostLabel}, from their next
          worktree request. Worktrees you create yourself aren&apos;t affected.
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

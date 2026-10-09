import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
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
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { trackSettingChanged } from "@/lib/analytics";
import { configMutationKeys } from "@/lib/query-keys";
import type { HostRpcRegistry } from "@/lib/host";
import { catalogTimeoutOptions } from "@/components/settings/panels/providers-catalog-timeout-options";

const CATALOG_GET = "config.catalog.get";
const CATALOG_SET = "config.catalog.set";

/** Same shell as the Worktrees page's policy chips. */
const CATALOG_TIMEOUT_CHIP_CLASS =
  "inline-flex min-w-0 max-w-full shrink items-center gap-1.5 rounded-full border border-border/60 px-2.5 py-1 text-ui-xs text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * Settings ▸ Providers ▸ Model list timeout — how long the host waits for a
 * provider to list its models (and commands), machine-wide. Stored in the
 * `catalog` block of `~/.traycer/cli/config.json` on the scoped host and read
 * at every catalog probe, so a change applies to the next read without a
 * restart.
 *
 * Sits beside "All providers · Refresh" on the heading row, which mounts only
 * on a usable scope; it also resolves the Worktrees chips' gate itself (scope
 * usable, host reachable, BOTH methods negotiated - they negotiate
 * independently, and a readable-but-unwritable setting would render a menu
 * whose every choice fails). Anything short of `ready` renders nothing: a host
 * too old for the setting simply has no control.
 */
export function ProvidersCatalogTimeoutChip(props: {
  readonly scope: HostScope;
}): ReactNode {
  const { scope } = props;
  const hostId = scope.hostId;
  const reachability = useHostReachability(hostId ?? "");
  // Two statements, not one `&&` - a short-circuited hook call is a
  // rules-of-hooks violation.
  const getSupported = useHostMethodSupport(hostId, CATALOG_GET);
  const setSupported = useHostMethodSupport(hostId, CATALOG_SET);
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
  if (gate !== "ready" || hostId === null) return null;
  // Keyed by host: a switch straight from one usable host to another must not
  // carry an open menu across.
  return (
    <CatalogTimeoutChip
      key={hostId}
      client={scope.client}
      hostLabel={scope.hostLabel}
    />
  );
}

function CatalogTimeoutChip(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostLabel: string;
}): ReactNode {
  const { client } = props;
  const query = useHostQuery<HostRpcRegistry, "config.catalog.get">({
    cacheKeyIdentity: undefined,
    client,
    method: CATALOG_GET,
    params: {},
    options: { enabled: true },
  });
  const setTimeoutSeconds = useHostScopedMutationForClient(client, {
    method: CATALOG_SET,
    mutationKey: configMutationKeys.catalogSet(),
    errorMessage: "Couldn't update the model list timeout",
    invalidateMethods: [CATALOG_GET],
  });
  const state = query.data ?? null;
  const current = state?.probeTimeoutSeconds ?? null;
  const options = catalogTimeoutOptions(state);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Model list timeout setting"
          disabled={setTimeoutSeconds.isPending}
          data-testid="providers-catalog-timeout-chip"
          data-seconds={current ?? undefined}
          className={CATALOG_TIMEOUT_CHIP_CLASS}
        >
          <span className="min-w-0 truncate">
            {current === null
              ? "Model list timeout"
              : `Model list timeout · ${current} s`}
          </span>
          {setTimeoutSeconds.isPending ? (
            <AgentSpinningDots
              className={undefined}
              testId="providers-catalog-timeout-saving"
              variant={undefined}
              tone="muted"
            />
          ) : (
            <ChevronDown className="size-3 shrink-0" aria-hidden />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-[min(88vw,20rem)]"
        data-testid="providers-catalog-timeout-menu"
      >
        <DropdownMenuLabel>Model list timeout</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {query.isError ? (
          <p role="alert" className="px-1.5 py-1 text-ui-xs text-destructive">
            Couldn&apos;t read this host&apos;s setting. Repair
            ~/.traycer/cli/config.json on that machine, or back it up before
            resetting it, then reopen Settings.
          </p>
        ) : (
          <DropdownMenuRadioGroup
            value={current === null ? "" : String(current)}
            onValueChange={(next) => {
              const match = options.find(
                (option) => String(option.seconds) === next,
              );
              if (match === undefined || match.seconds === current) return;
              trackSettingChanged("providers", "catalogProbeTimeout");
              setTimeoutSeconds.mutate({ probeTimeoutSeconds: match.seconds });
            }}
          >
            {options.map((option) => (
              <DropdownMenuRadioItem
                key={option.seconds}
                value={String(option.seconds)}
                disabled={current === null || setTimeoutSeconds.isPending}
              >
                {option.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        )}
        <DropdownMenuSeparator />
        <p className="px-1.5 py-1 text-ui-xs text-pretty text-muted-foreground">
          How long Traycer waits for a provider to list its models: when you
          open the model picker, and when an agent creates another agent. Raise
          it on a slow or heavily loaded machine. Applies to every provider on{" "}
          {props.hostLabel}.
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

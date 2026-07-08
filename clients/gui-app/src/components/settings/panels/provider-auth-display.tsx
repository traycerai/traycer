import type { ReactNode } from "react";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";

export function ProviderAuthBadge({
  state,
}: {
  readonly state: ProviderCliState;
}): ReactNode {
  const auth = state.auth;
  if (
    !state.enabled ||
    (auth.status !== "authenticated" && auth.status !== "configured")
  ) {
    return null;
  }
  if (auth.badgeText === null) return null;

  return (
    <Badge
      variant="outline"
      className="h-4 max-w-full rounded-sm border-border/60 bg-muted/20 px-1.5 text-[10px] font-normal leading-none text-muted-foreground"
    >
      <span className="truncate">{auth.badgeText}</span>
    </Badge>
  );
}

export function ProviderAuthLine({
  state,
}: {
  readonly state: ProviderCliState;
}): ReactNode {
  if (!state.enabled) return null;
  const auth = state.auth;

  if (state.authPending) {
    return (
      <p className="mt-0.5 flex items-center gap-1.5 text-ui-xs text-muted-foreground/80">
        <MutedAgentSpinner />
        Checking account
      </p>
    );
  }

  if (auth.status === "authenticated") {
    if (auth.label === null) return null;
    const line = (
      <p className="mt-0.5 min-w-0 truncate text-ui-xs text-muted-foreground/80">
        {auth.label}
      </p>
    );
    return (
      <TooltipWrapper
        label={auth.detail}
        side="top"
        sideOffset={6}
        align="start"
      >
        {line}
      </TooltipWrapper>
    );
  }

  if (auth.status === "configured") {
    return (
      <p className="mt-0.5 text-ui-xs text-muted-foreground/80">
        Configured, not verified
      </p>
    );
  }

  if (auth.status === "unavailable") {
    return (
      <TooltipWrapper
        label={auth.detail}
        side="top"
        sideOffset={6}
        align="start"
      >
        <p className="mt-0.5 text-ui-xs text-muted-foreground/80">
          Could not check account status
        </p>
      </TooltipWrapper>
    );
  }

  if (auth.status === "unauthenticated") {
    return (
      <p className="mt-0.5 text-ui-xs text-muted-foreground/80">
        Not authenticated
      </p>
    );
  }

  if (state.apiKey.configured) {
    return (
      <p className="mt-0.5 text-ui-xs text-muted-foreground/80">API key set</p>
    );
  }

  return (
    <p className="mt-0.5 text-ui-xs text-muted-foreground/80">
      Account status unavailable
    </p>
  );
}

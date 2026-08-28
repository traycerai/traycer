import type { RoleClaim } from "@traycer/protocol/persistence/epic/role-claims";
import { Tag } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";

interface AgentRoleBadgesProps {
  readonly claims: readonly RoleClaim[];
}

export function AgentRoleHoverContent(props: {
  readonly agentName: string;
  readonly claims: readonly RoleClaim[];
}) {
  return (
    <div
      className="flex max-w-[min(80vw,20rem)] flex-col gap-1.5"
      data-testid="agent-role-hover-content"
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-ui-xs font-medium">Agent roles</span>
        <span className="break-words text-ui-xs text-muted-foreground">
          {props.agentName}
        </span>
      </div>
      <div className="flex flex-col gap-1">
        {props.claims.map((claim) => (
          <div key={claim.claimId} className="flex min-w-0 flex-col gap-0.5">
            <span className="break-words text-ui-xs font-medium">
              {claim.role}
            </span>
            <span className="break-words text-ui-xs text-muted-foreground">
              Scope · {claim.scope}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function AgentRoleBadges(props: AgentRoleBadgesProps) {
  const { claims } = props;
  if (claims.length === 0) return null;
  const singleRole = claims.length === 1 ? claims[0] : null;
  const roleCountLabel =
    singleRole === null
      ? `${claims.length} roles`
      : `Role ${singleRole.role}, scope ${singleRole.scope}`;
  return (
    <TooltipWrapper
      label={roleCountLabel}
      side="top"
      sideOffset={undefined}
      align="center"
    >
      <Badge
        variant="outline"
        className="h-4 shrink-0 gap-0.5 rounded-sm border-current/30 bg-background/60 px-1 text-foreground"
        data-testid="agent-role-badges"
        aria-label={roleCountLabel}
      >
        <Tag className="size-2.5" aria-hidden />
        {singleRole === null ? (
          <span>{claims.length}</span>
        ) : (
          <span className="max-w-[10ch] truncate">{singleRole.role}</span>
        )}
      </Badge>
    </TooltipWrapper>
  );
}

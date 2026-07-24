import type { RoleClaim } from "@traycer/protocol/persistence/epic/role-claims";
import { Badge } from "@/components/ui/badge";

const MAX_VISIBLE_ROLE_BADGES = 2;

interface AgentRoleBadgesProps {
  readonly claims: readonly RoleClaim[];
}

export function AgentRoleBadges(props: AgentRoleBadgesProps) {
  const { claims } = props;
  if (claims.length === 0) return null;
  const visibleClaims = claims.slice(0, MAX_VISIBLE_ROLE_BADGES);
  const overflowClaims = claims.slice(MAX_VISIBLE_ROLE_BADGES);
  return (
    <span
      className="flex max-w-[45%] shrink-0 items-center gap-1"
      data-testid="agent-role-badges"
    >
      {visibleClaims.map((claim) => (
        <Badge
          key={claim.claimId}
          variant="secondary"
          className="h-4 min-w-0 rounded-sm px-1 text-overline"
          title={`${claim.role} — ${claim.scope}`}
          aria-label={`Role ${claim.role}, scope ${claim.scope}`}
        >
          <span className="truncate">{claim.role}</span>
        </Badge>
      ))}
      {overflowClaims.length === 0 ? null : (
        <Badge
          variant="outline"
          className="h-4 rounded-sm px-1 text-overline"
          title={overflowClaims
            .map((claim) => `${claim.role} — ${claim.scope}`)
            .join("\n")}
          aria-label={`${overflowClaims.length} more roles`}
        >
          +{overflowClaims.length}
        </Badge>
      )}
    </span>
  );
}

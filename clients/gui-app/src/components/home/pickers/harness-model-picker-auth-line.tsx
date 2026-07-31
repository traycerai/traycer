import type { ReactNode } from "react";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { Badge } from "@/components/ui/badge";
import { isProviderAmbientSignedOut } from "@/lib/providers/provider-ambient-auth";

/**
 * The ambient account line for the browsed provider - rendered in the slot the
 * profile dropdown occupies for multi-profile providers, so account identity
 * always lives in the same place regardless of profile count.
 *
 * This exists because a single-profile provider can authenticate through a
 * credential the user never handed to it (Copilot silently rides the GitHub
 * CLI's login after its own token is cleared). The probe already names that
 * source (`auth.badgeText`, e.g. "GitHub CLI") and the account
 * (`auth.label`, "Authenticated as <login>") - the same fields Settings →
 * Providers renders - so surfacing them here lets the picker explain a state
 * that otherwise looks like a stale cache.
 *
 * Renders nothing when there is nothing definitive to say: a disabled
 * provider, a probe still settling, or an authenticated account with no
 * badge/label. The signed-out line is the one exception - it pairs with the
 * rail tab's degraded treatment so the gray-out is never unexplained.
 */
export function PickerProviderAuthLine(props: {
  readonly state: ProviderCliState | null;
}): ReactNode {
  const { state } = props;
  if (state === null || !state.enabled) return null;
  if (isProviderAmbientSignedOut(state)) {
    return <AuthLineRow badgeText={null} label="Not authenticated" />;
  }
  const auth = state.auth;
  if (auth.status !== "authenticated" && auth.status !== "configured") {
    return null;
  }
  if (auth.badgeText === null && auth.label === null) return null;
  return <AuthLineRow badgeText={auth.badgeText} label={auth.label} />;
}

function AuthLineRow(props: {
  readonly badgeText: string | null;
  readonly label: string | null;
}): ReactNode {
  return (
    <div className="flex min-w-0 shrink-0 items-center gap-1.5 border-b px-3 py-1.5 text-ui-xs text-muted-foreground">
      {props.badgeText === null ? null : (
        <Badge
          variant="outline"
          className="h-4 max-w-full rounded-sm border-border/60 bg-muted/20 px-1.5 text-[10px] font-normal leading-none text-muted-foreground"
        >
          <span className="truncate">{props.badgeText}</span>
        </Badge>
      )}
      {props.label === null ? null : (
        <span className="min-w-0 truncate">{props.label}</span>
      )}
    </div>
  );
}

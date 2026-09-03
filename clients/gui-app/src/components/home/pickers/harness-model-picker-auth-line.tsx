import type { ReactNode } from "react";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { GuiHarnessCatalogEntry } from "@/hooks/harnesses/use-gui-harness-catalog";
import {
  isHarnessRowSignedOut,
  isProviderAmbientSignedOut,
} from "@/lib/providers/provider-ambient-auth";
import {
  type ProviderSetupGuidance,
  providerSetupGuidance,
} from "@/lib/providers/provider-setup-guidance";
import { isProviderSignedOutCatalogError } from "@/lib/providers/provider-signed-out-catalog-error";

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
 *
 * The signed-out verdict is read from the SAME two sources the rail's degraded
 * treatment reads (`railHarnessDegraded`): the `providers.list` state and the
 * catalog row's own `authStatus`. OR'd, definitive-only, for the reason spelled
 * out there - the two are separately timed, and a line that read only one of
 * them could contradict the dimmed tab beside it.
 *
 * For a provider with setup guidance the bare label is replaced by the steps
 * that actually fix the state, plus a way into Settings. The generic label is
 * what sent users to export a shell variable that the provider never reads.
 * The steps live HERE only while the model list below still has rows to show
 * (the host serves the last good catalog through a sign-out); once the list
 * itself is in the signed-out error state, `ModelRowsState` renders the full
 * setup CTA in that space and this line drops back to the compact label, so
 * the popover never says the same thing twice.
 */
export function PickerProviderAuthLine(props: {
  readonly state: ProviderCliState | null;
  /** The catalog entry for the same provider, when the picker has one. */
  readonly harness: GuiHarnessCatalogEntry | null;
  readonly onOpenProviderSettings: () => void;
}): ReactNode {
  const { state, harness, onOpenProviderSettings } = props;
  if (state === null || !state.enabled) return null;
  const signedOut =
    isProviderAmbientSignedOut(state) ||
    (harness !== null && isHarnessRowSignedOut(harness));
  if (signedOut) {
    const guidance = providerSetupGuidance(state.providerId);
    const listShowsSetup =
      harness !== null &&
      isProviderSignedOutCatalogError(state.providerId, harness.modelsError);
    if (guidance === null || listShowsSetup) {
      return <AuthLineRow badgeText={null} label="Not authenticated" />;
    }
    return (
      <SetupGuidanceRow
        guidance={guidance}
        onOpenProviderSettings={onOpenProviderSettings}
      />
    );
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

function SetupGuidanceRow(props: {
  readonly guidance: ProviderSetupGuidance;
  readonly onOpenProviderSettings: () => void;
}): ReactNode {
  const { guidance, onOpenProviderSettings } = props;
  return (
    <div
      role="note"
      aria-label="Setup required"
      className="flex min-w-0 shrink-0 flex-col gap-1.5 border-b px-3 py-2 text-ui-xs text-muted-foreground"
    >
      <span className="text-foreground/90">Not authenticated</span>
      <span>{guidance.summary}</span>
      <ol className="list-decimal space-y-0.5 pl-4">
        <li>
          Run{" "}
          <code className="rounded-sm bg-foreground/8 px-1 py-px font-mono text-[11px] text-foreground/90">
            {guidance.command}
          </code>{" "}
          in a terminal.
        </li>
        {guidance.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={onOpenProviderSettings}
        >
          Open Settings
        </Button>
      </div>
    </div>
  );
}

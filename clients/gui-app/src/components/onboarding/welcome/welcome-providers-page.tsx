import { ChevronRight } from "lucide-react";
import { useCallback, useId, useMemo, useState, type ReactNode } from "react";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { Button } from "@/components/ui/button";
import { WelcomeModalFooter } from "@/components/onboarding/welcome/welcome-modal-footer";
import { WelcomeProviderTile } from "@/components/onboarding/welcome/welcome-provider-tile";
import {
  buildWelcomeTiles,
  disablingLastEnabledFor,
  type WelcomeTileModel,
} from "@/components/onboarding/welcome/welcome-providers-model";
import { useWelcomeRoster } from "@/components/onboarding/welcome/use-welcome-roster";
import { useProvidersSetEnabled } from "@/hooks/providers/use-providers-set-enabled-mutation";
import {
  WELCOME_MAJOR_PROVIDER_IDS,
  welcomeMinorProviders,
} from "@/lib/provider-ordering";
import { cn } from "@/lib/utils";

const MINOR_PROVIDER_IDS: ReadonlyArray<ProviderId> =
  welcomeMinorProviders().map((provider) => provider.providerId);

/**
 * Page 1 of the welcome modal: the six major providers as tiles, the rest
 * behind a "+N more providers" disclosure, each with an install badge, the
 * account line when the host has one, and an enable switch that calls the
 * host. No sign-in flow of any kind lives here (decision 3) - a tooltip
 * points an unauthenticated provider at Settings ▸ Providers - and no
 * skills/MCP badges (decision 29: the native list RPC would start MCP
 * discovery on a cold host).
 *
 * App-wide host on purpose: this is an app-wide surface, not a composer, so
 * the default-host wrappers are the right ones.
 *
 * Continue waits for `providers.list` to RESOLVE. The modal decides the
 * branch from the enabled roster, and before the list has answered that
 * roster reads as empty - a Continue then would finish the modal as
 * `no-sessions` for a user with three providers enabled. An error with no
 * data is the same gap with a name, so it gets inline copy and a retry
 * rather than a Continue.
 */
export function WelcomeProvidersPage(props: {
  readonly onContinue: () => void;
  readonly onSkip: () => void;
}): ReactNode {
  const { onContinue, onSkip } = props;
  const roster = useWelcomeRoster();
  const { query: providersQuery, providers } = roster;
  const setEnabled = useProvidersSetEnabled();
  // A disabled query (no host bound yet) never leaves `pending` with an idle
  // fetch, and a hard query error leaves no data; surface both honestly as
  // "Unavailable" instead of an eternal "Detecting…".
  const hostUnavailable =
    (providersQuery.isPending && providersQuery.fetchStatus === "idle") ||
    (providersQuery.isError && providers === undefined);
  // Retry whenever the last read FAILED, cached data or not: after a toggle
  // a failed refresh leaves the old roster on screen, and the retry is the
  // way to the one Continue is waiting for.
  const listFailed = providersQuery.isError;
  // Continue advances on the ROSTER, so it waits for the roster to settle
  // (`useWelcomeRoster`): the first read, a toggle in flight, the refresh
  // its success invalidates into, and a refresh that failed and left the
  // roster from before the toggle in place. Without this, "enable Claude,
  // press Continue" branched on the old roster and could finish the modal
  // as `no-sessions` for a user who had just turned their one scannable
  // provider on.
  // Plus this page's OWN toggle in flight, whichever host it named: the
  // switch the user just pressed is the reason Continue should wait.
  const rosterSettling = setEnabled.isPending || !roster.settled;
  const enabledProviderCount =
    providers?.filter((provider) => provider.enabled).length ?? 0;

  const majorTiles = useMemo(
    () =>
      buildWelcomeTiles({
        providers,
        hostUnavailable,
        ids: WELCOME_MAJOR_PROVIDER_IDS,
      }),
    [providers, hostUnavailable],
  );
  const minorTiles = useMemo(
    () =>
      buildWelcomeTiles({
        providers,
        hostUnavailable,
        ids: MINOR_PROVIDER_IDS,
      }),
    [providers, hostUnavailable],
  );

  // Tooltips stay inside the dialog: the boundary is the nearest dialog
  // content, resolved once from the page's own root through a callback ref
  // (the page is only ever mounted inside the modal).
  const [collisionBoundary, setCollisionBoundary] = useState<Element | null>(
    null,
  );
  const rootRef = useCallback((node: HTMLDivElement | null) => {
    setCollisionBoundary(node?.closest('[data-slot="dialog-content"]') ?? null);
  }, []);

  const [minorsExpanded, setMinorsExpanded] = useState(false);
  const minorsId = useId();

  const handleSetEnabled = (providerId: ProviderId, enabled: boolean): void => {
    // No profile management here - this call never renames/removes a profile.
    setEnabled.mutate({ providerId, enabled, profileAction: null });
  };

  const renderTile = (
    model: WelcomeTileModel,
    layout: "tile" | "row",
  ): ReactNode => (
    <WelcomeProviderTile
      key={model.providerId}
      model={model}
      layout={layout}
      disablingLastEnabled={disablingLastEnabledFor(
        providers?.find((provider) => provider.providerId === model.providerId),
        model.enabled,
        enabledProviderCount,
      )}
      settingEnabled={setEnabled.isPending}
      collisionBoundary={collisionBoundary}
      onSetEnabled={handleSetEnabled}
    />
  );

  return (
    <>
      <div
        ref={rootRef}
        data-testid="welcome-providers-page"
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-6 py-4"
      >
        {listFailed ? (
          <div
            role="alert"
            data-testid="welcome-providers-error"
            className="flex shrink-0 flex-wrap items-center gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-ui-xs text-amber-700 dark:bg-amber-400/10 dark:text-amber-300"
          >
            <span className="min-w-0 flex-1">
              Traycer couldn't read this machine's providers.
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={providersQuery.isFetching}
              onClick={() => void providersQuery.refetch()}
            >
              Try again
            </Button>
          </div>
        ) : null}
        {/* 18rem columns: six tiles as 3×2 across the 80vw dialog at both
            1280 and 1512 px windows, wide enough that no name or badge
            wraps there. The rows take their height from the tallest tile -
            the dialog is 80vh and three rows fit, so the grid never has to
            squeeze a tile to make room. */}
        <ul
          aria-label="Coding agents"
          className="grid shrink-0 grid-cols-[repeat(auto-fill,minmax(18rem,1fr))] gap-3"
        >
          {majorTiles.map((model) => renderTile(model, "tile"))}
        </ul>
        {minorTiles.length > 0 ? (
          <div className="flex shrink-0 flex-col gap-1">
            <button
              type="button"
              aria-expanded={minorsExpanded}
              aria-controls={minorsId}
              data-testid="welcome-providers-more"
              onClick={() => setMinorsExpanded((expanded) => !expanded)}
              className="flex w-fit items-center gap-1 rounded-md py-1 pr-2 text-ui-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              <ChevronRight
                aria-hidden
                className={cn(
                  "size-3.5 shrink-0 transition-transform",
                  minorsExpanded && "rotate-90",
                )}
              />
              {minorTiles.length.toLocaleString()} more providers
            </button>
            {/* Two columns at most: each row keeps its switch beside its
                name, and a third or fourth column of them would put a
                switch closer to the next row's name than to its own. */}
            {minorsExpanded ? (
              <ul
                id={minorsId}
                aria-label="More coding agents"
                className="grid grid-cols-1 gap-x-6 md:grid-cols-2"
              >
                {minorTiles.map((model) => renderTile(model, "row"))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
      <WelcomeModalFooter
        leading={null}
        secondary={{ label: "Skip setup", onSelect: onSkip }}
        primary={{
          label: "Continue",
          onSelect: () => {
            // Same fact the `disabled` reads, re-read at the click.
            if (rosterSettling) return;
            onContinue();
          },
          disabled: rosterSettling,
          // The spinner says why Continue is not yet on offer - but not
          // over an error, where the retry is the thing to press.
          pending: rosterSettling && !providersQuery.isError,
        }}
      />
    </>
  );
}

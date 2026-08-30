import { memo, useEffect, type ReactElement } from "react";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BrowserPersistenceMockDialog } from "@/components/epic-canvas/renderers/browser-persistence-mock-dialog";
import { keystoreName } from "@/lib/browser-view/browser-cookie-degraded-message";
import {
  trackBrowserPersistence,
  trackBrowserPersistenceCardShown,
} from "@/lib/browser-view/browser-persistence-analytics";
import type { BrowserPersistenceController } from "@/lib/browser-view/use-browser-persistence-state";
import type { BrowserPersistenceState } from "@traycer-clients/shared/platform/browser-view";

/**
 * The one-time explainer (spec §7.2). It is the ONLY thing standing between a
 * user and an unexplained OS keychain dialog, so it renders before any probe
 * has run and every button on it is the user's own gesture:
 * "Enable saved logins" is what raises the real prompt, "Not now" records a
 * decline so the card never comes back.
 *
 * It renders as a banner ROW rather than a floating overlay: the tile's page is
 * a native Electron view composited over the window, so an absolutely
 * positioned card inside the surface would sit behind the page (or force the
 * page to park behind a snapshot). A row above the surface shrinks the native
 * view instead, which is both visible and interactive.
 */

interface BrowserPersistenceExplainerCardProps {
  readonly persistence: BrowserPersistenceController;
  /** An agent placed this tile (`drivenBy` non-empty), not the user. */
  readonly agentDriven: boolean;
}

function shouldShowBrowserPersistenceExplainer(
  state: BrowserPersistenceState | null,
): boolean {
  // Silent platforms (Windows DPAPI, a Linux machine with a known keyring)
  // auto-enable with no card at all - decision #21.
  return (
    state !== null &&
    state.decision.kind === "undecided" &&
    state.promptsOnEnable
  );
}

export const BrowserPersistenceExplainerCard = memo(
  function BrowserPersistenceExplainerCard(
    props: BrowserPersistenceExplainerCardProps,
  ): ReactElement | null {
    const state = props.persistence.state;
    const visible = shouldShowBrowserPersistenceExplainer(state);
    // The impression is latched for the session inside the tracker, so neither
    // a re-render nor the card moving to a surviving tile (its claim is
    // released on unmount) counts as a second showing.
    useEffect(() => {
      if (!visible) return;
      trackBrowserPersistenceCardShown();
    }, [visible]);
    if (!visible || state === null) return null;
    return (
      <section
        aria-label="Keep your website logins between sessions?"
        data-testid="browser-persistence-explainer-card"
        className="flex w-full min-w-0 flex-col gap-3 border-b border-border bg-muted/40 px-3 py-3 text-ui-sm sm:flex-row sm:items-start sm:gap-4"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <h2 className="flex min-w-0 items-center gap-2 font-heading text-ui-sm font-medium text-foreground">
            <ShieldCheck aria-hidden className="size-4 shrink-0" />
            Keep your website logins between sessions?
          </h2>
          <p className="text-pretty text-ui-xs leading-relaxed text-muted-foreground">
            {explainerBody(state, props.agentDriven)}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={props.persistence.pending}
              onClick={() => {
                trackBrowserPersistence({
                  name: "browser_persistence_card_action",
                  action: "enable",
                });
                // The outcome (`browser_persistence_enable_result`) is emitted
                // by the shared hook, so the card, the shield and Settings all
                // report the same funnel.
                props.persistence.enable("card");
              }}
            >
              Enable saved logins
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={props.persistence.pending}
              onClick={() => {
                trackBrowserPersistence({
                  name: "browser_persistence_card_action",
                  action: "not_now",
                });
                props.persistence.decline();
              }}
            >
              Not now
            </Button>
          </div>
        </div>
        {/* The mock is a macOS artifact; on another prompting platform the
            wording above stands on its own rather than mocking a dialog that
            machine will never show. */}
        {state.platform === "darwin" ? (
          <div className="w-full min-w-0 sm:max-w-xs">
            <BrowserPersistenceMockDialog appName={state.appName} />
          </div>
        ) : null}
      </section>
    );
  },
);

function explainerBody(
  state: BrowserPersistenceState,
  agentDriven: boolean,
): string {
  const opener = agentDriven
    ? "An agent opened this browser and it is signed out."
    : "";
  const body = `Traycer stores browser logins in ${keystoreName(state)} so agents can use sites you're signed into.`;
  const closer =
    state.platform === "darwin"
      ? " macOS will show this dialog:"
      : " Your system will ask for permission once.";
  return `${opener.length > 0 ? `${opener} ` : ""}${body}${closer}`;
}

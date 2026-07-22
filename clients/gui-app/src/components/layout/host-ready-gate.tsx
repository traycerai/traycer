import { useCallback, useMemo, type ReactNode } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { CenteredCard } from "@/components/centered-card";
import { LocalHostLoading } from "@/components/local-host-loading";
import { MobileHostGate } from "@/components/layout/shell/mobile-host-gate";
import {
  GATE_BYPASS_PATH_PREFIX,
  LocalHostGate,
} from "@/components/local-host-gate";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { useHostBinding } from "@/lib/host";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * Gates the routed PAGE on local-host readiness, while the rest of the root
 * route (the menu/dialog/tray bridges in `RootComponent`) stays mounted.
 *
 * This lives INSIDE `RouterProvider`, so host-independent chrome - the
 * `MenuCommandListener` and the About/Logs/Report `DesktopDialogHost` - keeps
 * working while the gate shows the "Setting up Traycer Host…" surface. It
 * replaces the old placement that wrapped the whole `RouterProvider` and
 * unmounted that chrome (and every menu/dialog handler) during setup.
 *
 * Behaviour mirrors the prior `TraycerAppRouter` gate stack:
 *   - a signed-in user whose request context has not been minted yet sees the
 *     "Restoring authenticated session…" card;
 *   - otherwise the `LocalHostGate` / `MobileHostGate` stack decides between the
 *     loading / provisioning / unavailable surfaces and the page;
 *   - `/settings*` routes bypass both gates so shell config stays reachable
 *     while the host is wedged.
 */
export function HostReadyGate(props: {
  readonly children: ReactNode;
}): ReactNode {
  const binding = useHostBinding();
  const authStatus = useAuthStore((state) => state.status);
  const readiness = useReactiveHostReadiness(
    binding === null ? null : binding.hostClient,
  );
  // Reactive within the router, so the bypass re-evaluates on programmatic
  // `router.navigate(...)` (e.g. the loading card's "Configure shell" button)
  // as well as ordinary navigation.
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const selectedEntry =
    binding === null ? null : binding.hostClient.getActiveHost();
  const bypassGates = pathname.startsWith(GATE_BYPASS_PATH_PREFIX);

  const onConfigureShell = useCallback(() => {
    void navigate({ to: "/settings/shell" });
  }, [navigate]);

  const loadingHostCard = useMemo(
    () => (
      <LocalHostLoading
        stage="loading"
        progress={null}
        onConfigureShell={onConfigureShell}
      />
    ),
    [onConfigureShell],
  );
  const slowHostCard = useMemo(
    () => (
      <LocalHostLoading
        stage="slow"
        progress={null}
        onConfigureShell={onConfigureShell}
      />
    ),
    [onConfigureShell],
  );
  const provisioningHostCard = useMemo(
    () => (
      <LocalHostLoading
        stage="loading"
        progress={null}
        onConfigureShell={onConfigureShell}
      />
    ),
    [onConfigureShell],
  );
  const mobileNoHostCard = useMemo(
    () => (
      <CenteredCard
        testId="mobile-no-host"
        message="No host connected. Connect a host from this device to get started."
        spinnerVariant={null}
      />
    ),
    [],
  );

  if (authStatus === "signed-in" && readiness.requestContextUserId === null) {
    return (
      <CenteredCard
        testId={null}
        message="Restoring authenticated session…"
        spinnerVariant="sparkle"
      />
    );
  }

  return (
    <LocalHostGate
      bypass={bypassGates}
      selectedEntry={selectedEntry}
      loading={loadingHostCard}
      provisioningLoading={provisioningHostCard}
      unavailable={slowHostCard}
    >
      <MobileHostGate bypass={bypassGates} noHost={mobileNoHostCard}>
        {props.children}
      </MobileHostGate>
    </LocalHostGate>
  );
}

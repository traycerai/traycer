import { useEffect } from "react";
import { useRouterState } from "@tanstack/react-router";
import { useLandingRouteStore } from "@/stores/layout/landing-route-store";

/**
 * Mirrors `pathname === "/"` into a router-free store so AppShell can gate
 * top-level surfaces without depending on router context (bare test mounts).
 */
export function LandingRouteBridge(): null {
  const isLandingRoute = useRouterState({
    select: (state) => state.location.pathname === "/",
  });
  const setLandingRoute = useLandingRouteStore((s) => s.setLandingRoute);

  useEffect(() => {
    setLandingRoute(isLandingRoute);
  }, [isLandingRoute, setLandingRoute]);

  // On unmount (sign-out), landing gating must not stick.
  useEffect(() => {
    return () => {
      useLandingRouteStore.getState().setLandingRoute(false);
    };
  }, []);

  return null;
}

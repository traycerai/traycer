import { create } from "zustand";

/**
 * Whether the committed route is the landing surface (`/`).
 * Written by LandingRouteBridge (mounted under the live RouterProvider);
 * AppShell reads it to keep top-level keep-alive surfaces OFF the landing
 * route, where only the route-adapter layer (All projects home / launch
 * landing) may paint.
 */
interface LandingRouteState {
  readonly isLandingRoute: boolean;
  readonly setLandingRoute: (value: boolean) => void;
}

export const useLandingRouteStore = create<LandingRouteState>()((set) => ({
  isLandingRoute: false,
  setLandingRoute: (isLandingRoute) => set({ isLandingRoute }),
}));

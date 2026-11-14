import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { LazyMotion, domMax } from "motion/react";
import { useMobileHistorySwipes } from "@/components/layout/shell/use-mobile-history-swipes";
import { MobileNavDrawerSurface } from "@/components/layout/shell/mobile-nav-drawer-surface";
import { setMobileApp } from "@/lib/mobile-app";
import { useMobileNavStore } from "@/stores/layout/mobile-nav-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import "@/index.css";

setMobileApp(true);
const history = createMemoryHistory({
  initialEntries: ["/first", "/second"],
  initialIndex: 1,
});
declare global {
  interface Window {
    __mobileHistoryPath?: () => string;
  }
}
window.__mobileHistoryPath = () => history.location.pathname;
const router = createRouter({
  routeTree: createRootRoute({ component: () => null }),
  history,
});
export function Fixture() {
  const transition = useMobileHistorySwipes();
  const open = useMobileNavStore((s) => s.open);
  const setOpen = useMobileNavStore((s) => s.setOpen);
  const historyMode = useSettingsStore((s) => s.mobileSwipeHistory);
  return (
    <LazyMotion features={domMax} strict>
      <label>
        <input
          type="checkbox"
          checked={historyMode}
          onChange={(event) =>
            useSettingsStore
              .getState()
              .setMobileSwipeHistory(event.target.checked)
          }
        />{" "}
        Swipe for back and forward
      </label>
      <div
        data-testid="canvas"
        data-history-gesture-owner=""
        style={{ height: 90, touchAction: "pan-y" }}
      >
        Canvas
      </div>
      <div data-testid="history-location">{history.location.pathname}</div>
      <MobileNavDrawerSurface open={open} onOpenChange={setOpen}>
        <p>Tasks</p>
      </MobileNavDrawerSurface>
      {transition}
    </LazyMotion>
  );
}
const root = document.getElementById("root");
if (root === null) throw new Error("missing root");
createRoot(root).render(
  <RouterContextProvider router={router}>
    <Fixture />
  </RouterContextProvider>,
);

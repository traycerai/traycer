import { useEffect } from "react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { openEpicFromList } from "@/lib/commands/actions/open-epic-from-list";
import { useTrayProjectionStore } from "@/stores/tray/tray-projection-store";

/**
 * Opens the epic chosen from the native tray's recent-epic list.
 *
 * `RunnerHostBridges` subscribes to the tray's epic-click event (it sits above
 * `RouterProvider`, so it has no `useNavigate`) and records an `openRequest`
 * in the tray-projection store. This bridge is mounted inside the router, so
 * it owns the navigation: on each new request it resolves the epic title from
 * the projected list (threaded through tab creation so the cold-open canvas
 * renders the real title immediately) and routes through the shared
 * `openEpicFromList` helper - the same entry point the in-app epic list uses.
 */
export function TrayOpenEpicBridge(): null {
  const openRequest = useTrayProjectionStore((state) => state.openRequest);
  const navigate = useNavigate();
  // `useRouter` is stable, so only a fresh `openRequest` triggers this effect;
  // the live pathname is read off `router.state` at open time rather than
  // subscribed to, so a route change does not re-open the last epic.
  const router = useRouter();

  useEffect(() => {
    if (openRequest === null) {
      return;
    }
    const epic = useTrayProjectionStore
      .getState()
      .epics.find((entry) => entry.epicId === openRequest.epicId);
    openEpicFromList(
      navigate,
      openRequest.epicId,
      router.state.location.pathname,
      { title: epic?.title, source: "system_tray" },
    );
  }, [openRequest, navigate, router]);

  return null;
}

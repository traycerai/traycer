import { useEffect } from "react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { openEpicFromList } from "@/lib/commands/actions/open-epic-from-list";
import { useTrayProjectionStore } from "@/stores/tray/tray-projection-store";

/** Opens the epic chosen from the native tray's recent-epic list. */
export function TrayOpenEpicBridge(): null {
  const openRequest = useTrayProjectionStore((state) => state.openRequest);
  const navigate = useNavigate();
  // `useRouter` is stable, so only a fresh `openRequest` triggers this effect; the live pathname is read off
  // `router.state` at open time rather than subscribed to, so a route change does not re-open the last epic.
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

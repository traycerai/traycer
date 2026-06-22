import { createFileRoute, redirect } from "@tanstack/react-router";
import { RootLandingPage } from "@/components/layout/root-landing-page";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useTabsStore } from "@/stores/tabs/store";

export const Route = createFileRoute("/")({
  // Sends a signed-in user with no restored tabs to a fresh draft.
  beforeLoad: ({ context }) => {
    if (context.getAuthSnapshot().status !== "signed-in") return;
    if (hasRestoredTabs()) return;
    redirect({ to: "/draft/new", replace: true, throw: true });
  },
  component: RootLandingPage,
});

function hasRestoredTabs(): boolean {
  if (useTabsStore.getState().stripOrder.length > 0) return true;
  if (useEpicCanvasStore.getState().openTabOrder.length > 0) return true;
  if (useLandingDraftStore.getState().drafts.length > 0) return true;
  return false;
}

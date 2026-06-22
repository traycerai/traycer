import { useEffect } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { RootLandingPage } from "@/components/layout/root-landing-page";
import { draftTabIntent } from "@/lib/tab-navigation";
import { tabActivate } from "@/stores/tabs/registry";
import { useWindowsBridgeHydrated } from "@/providers/windows-bridge-context";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";

export function DraftRoute() {
  const { draftId } = useParams({ from: "/draft/$draftId" });
  const navigate = useNavigate();
  const hasHydrated = useWindowsBridgeHydrated();

  useEffect(() => {
    if (!hasHydrated) return;
    const state = useLandingDraftStore.getState();
    const draft = state.drafts.find((entry) => entry.id === draftId);
    if (draft === undefined) {
      void navigate({ to: "/", replace: true });
      return;
    }
    if (state.activeDraftId !== draftId) {
      tabActivate(draftTabIntent(draftId));
    }
  }, [draftId, hasHydrated, navigate]);

  return <RootLandingPage />;
}

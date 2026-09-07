import { createFileRoute, redirect } from "@tanstack/react-router";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { OnboardingRoute } from "./onboarding-route-components";

export const Route = createFileRoute("/onboarding")({
  // replay:true is settings Replay tour (push). First-run is a replace from
  // / with no flag, so finish opens a fresh draft.
  validateSearch: (search: Record<string, unknown>): { replay: boolean } => ({
    replay: search.replay === true || search.replay === "true",
  }),
  beforeLoad: ({ context, search }) => {
    if (
      context.getAuthSnapshot().status !== "signed-in" ||
      (useOnboardingStore.getState().completedAt !== null && !search.replay)
    ) {
      redirect({ to: "/", replace: true, throw: true });
    }
  },
  component: OnboardingRoute,
});

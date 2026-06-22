import { createFileRoute, redirect } from "@tanstack/react-router";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { OnboardingRoute } from "./onboarding-route-components";

export const Route = createFileRoute("/onboarding")({
  // `replay: true` is set only by the settings "Replay tour" action, which
  // pushes /onboarding onto history. First-run arrives via a `replace` redirect
  // from "/" with no flag, so finishing opens a fresh draft instead of going
  // back. Explicit so finish() never has to guess from history length.
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

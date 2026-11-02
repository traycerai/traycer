import { createFileRoute, redirect } from "@tanstack/react-router";
import { OnboardingPage } from "@/components/onboarding/onboarding-page";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";

export const Route = createFileRoute("/onboarding")({
  beforeLoad: ({ context }) => {
    if (
      context.getAuthSnapshot().status !== "signed-in" ||
      useOnboardingStore.getState().completedAt !== null
    ) {
      redirect({ to: "/", replace: true, throw: true });
    }
  },
  component: OnboardingPage,
});

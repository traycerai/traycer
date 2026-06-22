import { getRouteApi } from "@tanstack/react-router";
import { OnboardingPage } from "@/components/onboarding/onboarding-page";

const onboardingRouteApi = getRouteApi("/onboarding");

/** Route body for `/onboarding` - the first-launch product tour. */
export function OnboardingRoute() {
  const { replay } = onboardingRouteApi.useSearch();
  return <OnboardingPage replay={replay} />;
}

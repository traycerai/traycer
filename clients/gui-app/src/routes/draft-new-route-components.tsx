import { useSyncExternalStore } from "react";
import { useRouterState } from "@tanstack/react-router";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { RootLandingPage } from "@/components/layout/root-landing-page";
import {
  subscribeTabNavigationResolutionFailure,
  tabNavigationResolutionFailed,
} from "@/lib/tab-navigation";

export function DraftNewRoute() {
  const locationState = useRouterState({
    select: (state) => state.location.state,
  });
  const resolutionFailed = useSyncExternalStore(
    subscribeTabNavigationResolutionFailure,
    () => tabNavigationResolutionFailed(locationState),
    () => false,
  );

  if (resolutionFailed) return <RootLandingPage />;

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      <AgentSpinningDots
        className={undefined}
        testId={undefined}
        variant={undefined}
      />
    </div>
  );
}

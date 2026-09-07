import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";

/** TanStack awaits `route._componentsPromise` before committing a navigation (see `@tanstack/router-core`
 * `load-matches`). */
export function RoutePendingScreen() {
  return (
    <div
      data-testid="route-pending-screen"
      className="flex min-h-0 flex-1 items-center justify-center bg-background"
    >
      <AgentSpinningDots
        className="text-muted-foreground"
        testId="route-pending-spinner"
        variant="dots2"
      />
    </div>
  );
}

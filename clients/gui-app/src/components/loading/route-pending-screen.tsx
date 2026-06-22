import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";

/**
 * Generic full-pane loading screen the router shows as its
 * `defaultPendingComponent` while a route's code-split chunk is still being
 * fetched. TanStack awaits `route._componentsPromise` before committing a
 * navigation (see `@tanstack/router-core` `load-matches`), so until the target
 * route's component module is in memory the router would otherwise hold the
 * previous screen on screen - which reads as "stuck on the old page".
 *
 * This component lives in the eager startup bundle, NOT inside any route chunk,
 * so it can paint during exactly that window. It is deliberately neutral and
 * does not mirror `EpicShell`'s layout: replicating that frame would drag the
 * heavy epic-canvas graph into startup and be a maintenance burden as the shell
 * evolves. Once the chunk lands, the real shell (with its own in-place loading
 * body) takes over.
 */
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

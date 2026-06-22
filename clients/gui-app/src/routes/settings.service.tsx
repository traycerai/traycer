import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Legacy redirect: `/settings/service` is retired in favor of the
 * native-packaging `Settings → Host` pane. Any persisted bookmark,
 * remembered tab path, or tray command that still references the old
 * route lands on the same surface as the primary sidebar entry.
 */
export const Route = createFileRoute("/settings/service")({
  beforeLoad: () => {
    // `throw: true` makes `redirect()` throw the redirect Response itself
    // instead of returning it - keeps the canonical TanStack Router pattern
    // (throw a redirect to short-circuit the load) while keeping the
    // explicit `throw` keyword out of our source so the
    // `only-throw-error` lint stays happy.
    redirect({ throw: true, to: "/settings/host", replace: true });
  },
});

import { redirect, type AnyContext } from "@tanstack/react-router";
import { admitsLocalPlane, type AuthState } from "@/stores/auth/auth-store";

export interface RouterAuthContext extends AnyContext {
  getAuthSnapshot: () => Pick<AuthState, "status">;
}

/**
 * Route guard for the app's own surfaces.
 *
 * Admits the `unverified` session (see `admitsLocalPlane`): those routes render
 * local, disk-served data, and bouncing a user to `/` because authn was
 * unreachable is precisely the defect this predicate exists to prevent - it
 * would strand them on the sign-in page with their epics sitting on the disk
 * underneath it. The name is kept for its call sites; what it requires is an
 * admitted session, not a validated one.
 */
export function requireSignedIn(context: RouterAuthContext): void {
  if (admitsLocalPlane(context.getAuthSnapshot().status)) return;
  // `redirect({ throw: true })` lets TanStack Router throw the Response
  // internally so we avoid a bare `throw <non-error>` at this call site.
  redirect({ to: "/", throw: true });
}

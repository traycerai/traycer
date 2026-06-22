import { redirect, type AnyContext } from "@tanstack/react-router";
import type { AuthState } from "@/stores/auth/auth-store";

export interface RouterAuthContext extends AnyContext {
  getAuthSnapshot: () => Pick<AuthState, "status">;
}

export function requireSignedIn(context: RouterAuthContext): void {
  if (context.getAuthSnapshot().status === "signed-in") return;
  // `redirect({ throw: true })` lets TanStack Router throw the Response
  // internally so we avoid a bare `throw <non-error>` at this call site.
  redirect({ to: "/", throw: true });
}

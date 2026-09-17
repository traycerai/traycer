import {
  admitsLocalPlaneOnShell,
  useAuthStore,
  type AuthStatus,
} from "@/stores/auth/auth-store";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";

/**
 * Why a session that `admitsLocalPlane` would admit is being held on the auth
 * surface anyway, or `null` when it is admitted.
 *
 * One value today, and a union rather than a boolean on purpose: the surface
 * renders a SENTENCE, and the next reason to refuse admission will want a
 * different one. A boolean would have the copy guess which refusal it is
 * describing.
 */
export type ShellAdmissionRefusal = "unverified-relay-only";

export interface ShellLocalPlaneAdmission {
  readonly admitted: boolean;
  readonly refusal: ShellAdmissionRefusal | null;
}

/**
 * THE renderer-admission read, shared by the two halves of the decision: the
 * route BODY (`RootLandingPage`) and whether the app shell exists around it at
 * all (`RootComponent`'s standalone branch). Those two have to agree - a body
 * that renders the sign-in page inside the workspace chrome is a third state
 * neither of them meant - so the reading lives here once rather than being
 * re-derived on both sides.
 *
 * `hasLocalHost` is a property of the SHELL and constant for its lifetime, so
 * this never flickers once it is readable.
 *
 * A `null` runner host means OUTSIDE A PROVIDER - a host-less test harness or
 * a degraded tree, never a real shell reporting about itself - so it reads as
 * `true`, which is the answer that leaves behaviour exactly as it was. The
 * refusal is a positive finding about a shell that said it has no local host,
 * and inferring one from the absence of a provider would turn a rendering
 * accident into a sign-in screen.
 */
export function useShellLocalPlaneAdmission(): ShellLocalPlaneAdmission {
  const status = useAuthStore((state) => state.status);
  const hasLocalHost = useRunnerHostOrNull()?.hasLocalHost ?? true;
  return resolveShellLocalPlaneAdmission(status, hasLocalHost);
}

/**
 * The pure half, so the refusal's identity can be pinned without a provider
 * tree. `admitted` is `admitsLocalPlaneOnShell` verbatim; the refusal names
 * which of the two admitted statuses was turned away and why.
 */
export function resolveShellLocalPlaneAdmission(
  status: AuthStatus,
  hasLocalHost: boolean,
): ShellLocalPlaneAdmission {
  if (admitsLocalPlaneOnShell({ status, hasLocalHost })) {
    return { admitted: true, refusal: null };
  }
  // A refusal is only worth EXPLAINING when the status alone would have
  // admitted it. `signed-out` / `signing-in` land on the auth surface for the
  // ordinary reason, and a notice there would be answering a question nobody
  // asked.
  return {
    admitted: false,
    refusal: status === "unverified" ? "unverified-relay-only" : null,
  };
}

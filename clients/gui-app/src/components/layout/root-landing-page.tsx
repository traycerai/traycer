import { AuthLandingPage } from "@/components/auth/auth-landing-page";
import { useShellLocalPlaneAdmission } from "@/hooks/auth/use-shell-local-plane-admission";

/**
 * Root index route body.
 *
 * Signed-out users land on the auth-first desktop welcome surface. Once
 * authentication succeeds, `/` becomes the normal landing workspace; the
 * surrounding `DefaultHostReadyGate` still holds the composer back until a
 * host can serve the window, and the window narrator says why.
 *
 * The test is `useShellLocalPlaneAdmission`, NOT `status === "signed-in"`, and
 * the difference is the whole point: a stored session that authn was
 * unreachable to confirm (`unverified`) still gets the workspace ON A SHELL
 * THAT HAS A LOCAL HOST, because the epics it would show are served from that
 * machine's disk and need no network at all. Sending that user here instead
 * used to park them on a sign-in page in front of their own data.
 *
 * The shell clause is the other half, and it is not a refinement - it is the
 * premise. A relay-only shell has no such disk, so the same admission put a
 * phone in a workspace no host could serve, with nothing on screen saying so
 * (see `admitsLocalPlaneOnShell`). It stays here, and says why.
 *
 * Everything cloud-backed inside the workspace keeps gating on `signed-in` and
 * stays gated.
 */
export function RootLandingPage() {
  const admission = useShellLocalPlaneAdmission();

  if (!admission.admitted) {
    return <AuthLandingPage refusal={admission.refusal} />;
  }

  return null;
}

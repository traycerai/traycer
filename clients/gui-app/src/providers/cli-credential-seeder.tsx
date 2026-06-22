import { useEffect, useRef } from "react";
import { useAuthService } from "@/lib/host";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useRunnerCliLogin } from "@/hooks/runner/use-runner-cli-login-mutation";
import type { AuthSessionSnapshot } from "@/lib/auth/auth-service";

/**
 * Seeds the local CLI's stored credentials from the renderer's bearer.
 *
 * A desktop persistence-boundary consumer of the raw bearer, like
 * `WindowsBridgeAuthSessionBridge`: it reads the token through
 * `AuthService.onSessionSnapshotChange` - never `useAuthStore`, which holds no
 * bearer - and pushes it to `traycer login --token` (`useRunnerCliLogin`) so
 * the CLI keeps using it for host comms. Re-seeds on every rotation so the
 * CLI's stored bundle stays fresh and rarely needs to self-refresh, which
 * minimises refresh-token contention between the renderer and the CLI.
 *
 * This handles ROTATION re-seeding only. The FIRST sign-in is provisioned
 * up front and awaited by `AuthService.ensureLocalProvisioning` before the
 * session flips to signed-in, because the host's owner gate denies every
 * connection until the credentials file exists - so first-login seeding cannot
 * be left to this post-sign-in, best-effort reaction.
 *
 * Renders nothing and no-ops on shells without a local CLI (`traycerCli ===
 * null`: mobile, web, tests).
 */
export function CliCredentialSeeder(): null {
  const auth = useAuthService();
  const runnerHost = useRunnerHost();
  const { mutate } = useRunnerCliLogin();
  // Dedupe so a snapshot emission that doesn't change the bearer (profile /
  // context-only updates) doesn't re-spawn the CLI. A ref (not an effect-scoped
  // local) so the dedupe survives effect re-runs - `onSessionSnapshotChange`
  // fires synchronously on subscribe, so a re-subscribe (StrictMode double
  // invoke, provider remount) would otherwise re-seed the already-seeded token.
  const lastSeededRef = useRef<string | null>(null);

  useEffect(() => {
    if (runnerHost.traycerCli === null) {
      return;
    }
    const handle = (snapshot: AuthSessionSnapshot): void => {
      if (snapshot.status !== "signed-in" || snapshot.token === null) {
        return;
      }
      if (snapshot.token === lastSeededRef.current) {
        return;
      }
      const token = snapshot.token;
      lastSeededRef.current = token;
      // The session snapshot is a persistence boundary that exposes only the
      // bearer (not the paired refresh token), so rotation re-seeds carry an
      // empty refresh token. The CLI's `--token -` JSON path treats `""` as
      // "no refresh token" and keeps whatever it last persisted; first-login
      // provisioning (which has the refresh token) goes through
      // `AuthService.ensureLocalProvisioning`, not this reaction.
      mutate(
        { token, refreshToken: "" },
        {
          onError: () => {
            if (lastSeededRef.current === token) lastSeededRef.current = null;
          },
        },
      );
    };
    // Fires immediately with the current snapshot, then on every rotation.
    const subscription = auth.onSessionSnapshotChange(handle);
    return () => subscription.dispose();
  }, [auth, runnerHost, mutate]);

  return null;
}

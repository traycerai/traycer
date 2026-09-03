/**
 * Sentry DSN to bake into the web bundle, or `""` for crash reporting OFF.
 *
 * One env var for every environment: absent by default (every local build
 * reports nothing), exported by the release lanes. Read at BUILD time and
 * baked as a literal - the same posture as the backend URLs in
 * `vite.config.ts`, and as the desktop's deploy script stamping
 * `sentryRendererDsn` - so an installed app cannot be repointed by a runtime
 * environment variable.
 *
 * A malformed value fails the build here rather than shipping a client that
 * silently reports nowhere. That is the whole point of validating at all:
 * `@sentry/browser` does not throw on a DSN it cannot parse - it logs (in
 * debug builds only) and creates no transport, so an app shipped with, say,
 * a DSN missing its project id would look exactly like an app with no
 * crashes. The shape checked is Sentry's own
 * (`{PROTOCOL}://{PUBLIC_KEY}@{HOST}/{PROJECT_ID}`): https, a public key in
 * the userinfo, and a numeric project id as the final path segment.
 */
export function sentryDsnFromEnv(env: NodeJS.ProcessEnv): string {
  const raw = env.TRAYCER_MOBILE_SENTRY_DSN;
  if (raw === undefined || raw.trim().length === 0) {
    return "";
  }
  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("TRAYCER_MOBILE_SENTRY_DSN is not a URL");
  }
  if (parsed.protocol !== "https:" || parsed.username.length === 0) {
    throw new Error(
      "TRAYCER_MOBILE_SENTRY_DSN must be an https Sentry DSN (with public key)",
    );
  }
  // A legacy DSN carries a SECRET key after the colon. The value baked here
  // ships inside every installed app, so a secret in it is a leak by
  // construction - refuse it rather than embed it. Modern DSNs have no
  // password component at all.
  if (parsed.password.length > 0) {
    throw new Error(
      "TRAYCER_MOBILE_SENTRY_DSN must not carry a secret key (public key only)",
    );
  }
  const projectId = parsed.pathname.split("/").pop() ?? "";
  if (!/^\d+$/.test(projectId)) {
    throw new Error(
      "TRAYCER_MOBILE_SENTRY_DSN must end in a numeric Sentry project id",
    );
  }
  return trimmed;
}

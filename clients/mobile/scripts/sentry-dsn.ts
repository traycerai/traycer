/**
 * Sentry DSN to bake into the web bundle, or `""` for crash reporting off.
 * A malformed value fails the build here rather than shipping a client that silently reports nowhere.
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
  // A legacy DSN carries a secret key after the colon.
  // The value baked here ships inside every installed app, so a secret in it is a leak by construction - refuse it rather than embed it.
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

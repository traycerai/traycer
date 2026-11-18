// Every GitHub token prefix: classic PAT, OAuth, App user, App installation,
// App refresh, fine-grained PAT.
const GITHUB_TOKEN = /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]+\b/g;
// `authorization: Bearer x`, `authorization="token x"` and the JSON form
// `"authorization":"Bearer x"`; the whole credential goes, not the scheme.
const AUTHORIZATION_VALUE =
  /("?authorization"?\s*[:=]\s*"?)(?:(?:bearer|token)\s+)?[^\s,;}\]"]+/gi;

export function sanitizeCredentialText(value: string): string {
  return sanitizeCredentialTextWithSecrets(value, []);
}

export function sanitizeCredentialTextWithSecrets(
  value: string,
  secrets: readonly string[],
): string {
  let sanitized = value;
  for (const secret of secrets) {
    if (secret.length > 0)
      sanitized = sanitized.replaceAll(secret, "[redacted]");
  }
  return sanitized
    .replace(GITHUB_TOKEN, "[redacted]")
    .replace(AUTHORIZATION_VALUE, "$1[redacted]")
    .replace(/(TRAYCER_STAGING_RELEASE_TOKEN\s*[:=]\s*)\S+/gi, "$1[redacted]");
}

export function trimSecret(value: string): string {
  return value.replace(/[\r\n]/g, "").trim();
}

export class AuthenticationRequiredError extends Error {
  readonly name = "AuthenticationRequiredError";

  constructor(message: string) {
    super(sanitizeCredentialText(message));
  }
}

export function isAuthenticationRequiredError(
  error: unknown,
): error is AuthenticationRequiredError {
  return error instanceof AuthenticationRequiredError;
}

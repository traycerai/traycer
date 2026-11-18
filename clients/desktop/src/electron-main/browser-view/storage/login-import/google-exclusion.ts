/**
 * Google sessions are bound to the device (Device Bound Session Credentials:
 * the cookie is paired with a key in the TPM or Secure Enclave, and a copy
 * presented from anywhere else is rejected). A transplanted Google cookie is
 * therefore not a reliable login: it works until Google's next device check
 * and can leave a half-signed-in state that breaks the in-app sign-in the
 * user could otherwise do once. So every Google surface is classified as
 * `excluded` by the scan and left out by default; the dialog says so, and
 * offers an explicit opt-in (`includeDeviceBound`) for a user who accepts
 * that the session may end on its own.
 *
 * The match is on the REGISTRABLE domain the scan grouped by, so every
 * `google.<tld>` and `google.<sld>.<tld>` collapses onto one row.
 */

const GOOGLE_REGISTRABLE_DOMAIN_PATTERN = /^google\.[a-z]{2,}(\.[a-z]{2,})?$/u;

const GOOGLE_SERVICE_DOMAINS: ReadonlySet<string> = new Set([
  "googleapis.com",
  "gstatic.com",
  "googleusercontent.com",
  "googlevideo.com",
  "youtube.com",
  "ytimg.com",
]);

export function isGoogleDeviceBoundDomain(registrableDomain: string): boolean {
  const domain = registrableDomain.toLowerCase();
  return (
    GOOGLE_REGISTRABLE_DOMAIN_PATTERN.test(domain) ||
    GOOGLE_SERVICE_DOMAINS.has(domain)
  );
}

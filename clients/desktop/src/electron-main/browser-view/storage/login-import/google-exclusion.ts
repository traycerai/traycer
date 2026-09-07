
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

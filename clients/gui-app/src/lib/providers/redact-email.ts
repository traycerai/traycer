// Redacts an email to its first local-part char + a fixed mask + the domain's
// first char (e.g. "alice@domain.com" -> "a•••@d…"). Not reversible-by-design
// obfuscation, just a glance-proof default that still lets a reader confirm
// it's the right account. Shared by every Providers-settings surface that
// displays a profile's email (identity row reveal toggle, ambient drift
// notice, add-profile success dialog) so the format can't drift between them.
export function redactEmail(email: string): string {
  const atIndex = email.indexOf("@");
  if (atIndex <= 0) return "•••";
  const domain = email.slice(atIndex + 1);
  const domainFirstChar = domain.slice(0, 1);
  return `${email.slice(0, 1)}•••@${domainFirstChar}…`;
}

// Redacts an email to its first local-part char + a fixed mask + the domain's first char (e.g.
// "alice@domain.com" -> "a•••@d…").
export function redactEmail(email: string): string {
  const atIndex = email.indexOf("@");
  if (atIndex <= 0) return "•••";
  const domain = email.slice(atIndex + 1);
  const domainFirstChar = domain.slice(0, 1);
  return `${email.slice(0, 1)}•••@${domainFirstChar}…`;
}

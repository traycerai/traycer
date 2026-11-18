export function computeInitials(userName: string, email: string): string {
  const source = userName.trim().length > 0 ? userName.trim() : email.trim();
  if (source.length === 0) {
    return "?";
  }
  const parts = source.split(/\s+/).filter((part) => part.length > 0);
  if (parts.length === 0) {
    return source.slice(0, 1).toUpperCase();
  }
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

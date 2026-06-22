export function basenameOfPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const slashIndex = trimmed.lastIndexOf("/");
  if (slashIndex === -1) return trimmed;
  return trimmed.slice(slashIndex + 1);
}

export function dirnameOfPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const slashIndex = trimmed.lastIndexOf("/");
  if (slashIndex === -1) return "";
  return trimmed.slice(0, slashIndex);
}

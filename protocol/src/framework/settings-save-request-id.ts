/** Carries a settings save's correlation on the unary frame without enabling replay. */
const PREFIX = "settings-save:";

export function settingsSaveRequestId(saveId: string): string {
  return `${PREFIX}${saveId}`;
}

export function settingsSaveIdFromRequestId(requestId: string): string | null {
  if (!requestId.startsWith(PREFIX)) return null;
  const id = requestId.slice(PREFIX.length);
  return /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
    id,
  )
    ? id
    : null;
}

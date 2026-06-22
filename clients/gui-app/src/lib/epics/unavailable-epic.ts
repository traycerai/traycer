export function isUnavailableEpicReason(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("gettaskroominfo returned null") ||
    normalized.includes("null roominfo") ||
    normalized.includes("returned null task")
  );
}

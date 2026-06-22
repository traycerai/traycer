let enabled = false;

export function isSentryEnabled(): boolean {
  return enabled;
}

export function markSentryEnabled(): void {
  enabled = true;
}

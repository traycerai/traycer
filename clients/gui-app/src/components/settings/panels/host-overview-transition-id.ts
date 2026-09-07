/** The fallback exists only so an exotic host cannot make the restart button throw - uniqueness within one
 * window is all this id needs, since the host scopes claims per process. */
export function newTransitionId(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (cryptoApi !== undefined && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  return `restart-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

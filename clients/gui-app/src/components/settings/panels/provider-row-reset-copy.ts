// The per-provider reset's copy, shared by its action and the Providers panel.

export function providerRowResetLabel(providerLabel: string): string {
  return `Reset ${providerLabel} settings`;
}

/** Shown above the providers for each provider whose own row the host cannot read. */
export function providerRowUnreadableCopy(providerLabel: string): string {
  return `Traycer can't read this host's saved ${providerLabel} settings, so ${providerLabel}'s key, on/off switch and CLI choice can't be changed.`;
}

/**
 * The consent the per-provider reset asks for: what stops being used, that the
 * provider may be switched off, and that a copy of the file is kept. It names
 * only this provider's settings as reset and promises nothing absolute about
 * the others: another host sharing the folder can still write at the same time.
 */
export function providerRowResetConsent(providerLabel: string): string {
  return `Traycer will keep a copy of the provider settings file, then reset only ${providerLabel}. Its saved key, CLI choice, environment overrides and launch arguments will stop being used, and ${providerLabel} may be turned off: you'll turn it on and enter its key again. The copy stays in the same folder.`;
}

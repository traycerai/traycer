export type HiddenActiveTabFallback =
  | { readonly kind: "keep" }
  | { readonly kind: "activate"; readonly itemId: string }
  | { readonly kind: "new-draft" };

/**
 * Where to send the window when the active strip item is gone or hidden.
 *
 * `/` is a signed-in black void (RootLandingPage returns null). Never go
 * there when a visible tab exists — All projects after a Titanos-empty
 * switch was landing on `/` and staying black. An empty first-run landing
 * stays put so `/` → `/draft/new` does not double-mint.
 */
export function hiddenActiveTabFallback(input: {
  readonly isLandingPage: boolean;
  readonly activeItemId: string | null;
  readonly visibleItemIds: ReadonlyArray<string>;
}): HiddenActiveTabFallback {
  const firstVisible = input.visibleItemIds[0];
  const activeIsVisible =
    input.activeItemId !== null &&
    input.visibleItemIds.includes(input.activeItemId);
  if (activeIsVisible) return { kind: "keep" };
  if (firstVisible !== undefined) {
    return { kind: "activate", itemId: firstVisible };
  }
  if (input.isLandingPage) return { kind: "keep" };
  return { kind: "new-draft" };
}

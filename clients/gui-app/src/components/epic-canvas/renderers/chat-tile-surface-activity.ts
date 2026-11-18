/** Owns chat catalog and provider-refresh work for one focused canvas body. */
export function chatTileCatalogActivity(
  paneFocused: boolean,
  tabSelected: boolean,
  tileActive: boolean,
): boolean {
  return paneFocused && tabSelected && tileActive;
}

import { useMobileLayoutForm } from "@/hooks/ui/use-mobile-layout-form";
import type {
  MobileLevel2Form,
  MobileTileCount,
} from "@/lib/layout/mobile-layout-form";
import { isPhoneLayoutOnly } from "@/lib/mobile-app";

/** What level 2 draws and how many tiles show. */
export interface InstalledAppTileForm {
  readonly level2: MobileLevel2Form;
  readonly tiles: MobileTileCount;
}

/**
 * The form the installed app's content draws in; `null` everywhere else, where a
 * surface keeps the layout it has always had. A narrow desktop window reaches
 * the same phone components, but the width rule describes the installed app's
 * shell, which that window does not have.
 */
export function useInstalledAppTileForm(
  openTiles: MobileTileCount,
): InstalledAppTileForm | null {
  const { level2, tiles } = useMobileLayoutForm(openTiles);
  return isPhoneLayoutOnly() ? { level2, tiles } : null;
}

/** Just level 2 of {@link useInstalledAppTileForm}. */
export function useInstalledAppLevel2Form(
  openTiles: MobileTileCount,
): MobileLevel2Form | null {
  return useInstalledAppTileForm(openTiles)?.level2 ?? null;
}

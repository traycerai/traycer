import { useMobileLayoutForm } from "@/hooks/ui/use-mobile-layout-form";
import type {
  MobileLevel2Form,
  MobileTileCount,
} from "@/lib/layout/mobile-layout-form";
import { isPhoneLayoutOnly } from "@/lib/mobile-app";

/**
 * The form level 2 draws in the installed app; `null` everywhere else, where a
 * surface keeps the layout it has always had. A narrow desktop window reaches
 * the same phone components, but the width rule describes the installed app's
 * shell, which that window does not have.
 */
export function useInstalledAppLevel2Form(
  openTiles: MobileTileCount,
): MobileLevel2Form | null {
  const { level2 } = useMobileLayoutForm(openTiles);
  return isPhoneLayoutOnly() ? level2 : null;
}

import { useMobileHeaderActive } from "@/components/layout/header/use-mobile-header-active";
import { useArrangementValue } from "@/lib/layout-overrides";
import type { TabStripPlacement } from "@/lib/layout/layout-arrangement";

/**
 * The EFFECTIVE tab strip placement for this window: `"top"` while the mobile
 * header stands in its place, else the stored arrangement pick.
 *
 * The shell and the frame read this. Editor rows, Settings, the depictions and
 * the palette toggle read the STORED field (`useArrangementValue("tabStripPlacement")`)
 * directly instead, because they describe the layout rather than this window.
 */
export function useTabStripPlacement(): TabStripPlacement {
  const mobileHeaderActive = useMobileHeaderActive();
  const stored = useArrangementValue("tabStripPlacement");
  return mobileHeaderActive ? "top" : stored;
}

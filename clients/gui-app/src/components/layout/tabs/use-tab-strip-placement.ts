import { useMobileHeaderActive } from "@/components/layout/header/use-mobile-header-active";
import { useMobileStripForm } from "@/components/layout/tabs/mobile-strip-form-context";
import { useArrangementValue } from "@/lib/layout-overrides";
import type { TabStripPlacement } from "@/lib/layout/layout-arrangement";

/**
 * The EFFECTIVE tab strip placement for this window: `"left"` while the phone
 * shell's form draws the strip, `"top"` while the mobile header stands in its
 * place, else the stored arrangement pick.
 *
 * The shell and the frame read this. Editor rows, Settings, the depictions and
 * the palette toggle read the STORED field (`useArrangementValue("tabStripPlacement")`)
 * directly instead, because they describe the layout rather than this window.
 */
export function useTabStripPlacement(): TabStripPlacement {
  const mobileHeaderActive = useMobileHeaderActive();
  const mobileStripForm = useMobileStripForm();
  const stored = useArrangementValue("tabStripPlacement");
  if (mobileStripForm !== null) return "left";
  return mobileHeaderActive ? "top" : stored;
}

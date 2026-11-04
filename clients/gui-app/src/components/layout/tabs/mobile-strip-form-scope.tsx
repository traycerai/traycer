import type { ReactNode } from "react";
import { useMobileHeaderActive } from "@/components/layout/header/use-mobile-header-active";
import {
  MobileExpandedStripFitsContext,
  MobileStripFormContext,
} from "@/components/layout/tabs/mobile-strip-form-context";
import { useMobileLayoutForm } from "@/hooks/ui/use-mobile-layout-form";

/**
 * Answers level 1 for the whole window. It sits above the app shell because the
 * command palette, the Settings modal and the notifications sheet mount outside
 * the shell and read the same answer. It asks with one tile because level 1 does
 * not depend on the tile count.
 */
export function MobileStripFormScope(props: {
  readonly children: ReactNode;
}): ReactNode {
  const mobileHeaderActive = useMobileHeaderActive();
  const { level1, expandedFits } = useMobileLayoutForm(1);
  const form = mobileHeaderActive && level1 !== "drawer" ? level1 : null;
  return (
    <MobileStripFormContext.Provider value={form}>
      <MobileExpandedStripFitsContext.Provider value={expandedFits}>
        {props.children}
      </MobileExpandedStripFitsContext.Provider>
    </MobileStripFormContext.Provider>
  );
}

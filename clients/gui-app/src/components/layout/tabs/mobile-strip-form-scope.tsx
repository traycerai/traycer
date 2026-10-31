import type { ReactNode } from "react";
import { useMobileHeaderActive } from "@/components/layout/header/use-mobile-header-active";
import { MobileStripFormContext } from "@/components/layout/tabs/mobile-strip-form-context";
import { useMobileLayoutForm } from "@/hooks/ui/use-mobile-layout-form";

/**
 * Answers level 1 for everything under the shell. It asks with one tile because
 * level 1 does not depend on the tile count.
 */
export function MobileStripFormScope(props: {
  readonly children: ReactNode;
}): ReactNode {
  const mobileHeaderActive = useMobileHeaderActive();
  const { level1 } = useMobileLayoutForm(1);
  const form = mobileHeaderActive && level1 !== "drawer" ? level1 : null;
  return (
    <MobileStripFormContext.Provider value={form}>
      {props.children}
    </MobileStripFormContext.Provider>
  );
}

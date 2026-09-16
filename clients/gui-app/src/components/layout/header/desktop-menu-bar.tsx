import type { ReactNode } from "react";
import { DesktopMenuButtons } from "@/components/layout/header/desktop-menu-buttons";
import { useDesktopMenuBarActive } from "@/components/layout/header/use-desktop-menu-bar-active";

export function DesktopMenuBar(): ReactNode {
  const active = useDesktopMenuBarActive();
  if (!active) return null;
  return <DesktopMenuButtons active={active} />;
}

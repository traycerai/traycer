import { createContext, useContext } from "react";
import type { MobileLevel1Form } from "@/lib/layout/mobile-layout-form";
import { useSideStripCollapsed } from "@/stores/layout/side-tab-strip-store";

/** The phone shell's level 1 where it is the vertical tab strip. */
export type MobileStripForm = Exclude<MobileLevel1Form, "drawer">;

/**
 * The form the phone shell's strip draws in, or `null` with no strip in the
 * phone shell: the drawer's form, and every window that is not the phone shell.
 * Provided once, by `MobileStripFormScope`, so the strip's many readers share
 * one measurement.
 */
export const MobileStripFormContext = createContext<MobileStripForm | null>(
  null,
);

export function useMobileStripForm(): MobileStripForm | null {
  return useContext(MobileStripFormContext);
}

/**
 * Whether the phone shell's width has room for the expanded strip. It decides
 * whether the collapse toggle is offered at all: below that width the stored
 * choice cannot draw, so nothing may flip it.
 */
export const MobileExpandedStripFitsContext = createContext(false);

export function useMobileExpandedStripFits(): boolean {
  return useContext(MobileExpandedStripFitsContext);
}

/**
 * Whether the strip draws collapsed. On desktop that is the person's choice. In
 * the phone shell the form decides, because a stored "expanded" still draws the
 * rail where the expanded strip does not fit. Everything that draws the strip
 * reads this; the choice itself stays `useSideStripCollapsed`.
 */
export function useSideStripDrawnCollapsed(): boolean {
  const mobileForm = useMobileStripForm();
  const collapsed = useSideStripCollapsed();
  return mobileForm === null ? collapsed : mobileForm === "rail";
}

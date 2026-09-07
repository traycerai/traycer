import { createContext, use } from "react";

/** Nested Radix overlays portal here so Dialog's body scroll-lock still sees wheel/touch as descendants. null outside a modal. */
export const DialogOverlayBoundaryContext = createContext<HTMLElement | null>(
  null,
);

export function useDialogOverlayBoundaryEl(): HTMLElement | null {
  return use(DialogOverlayBoundaryContext);
}

import { createContext, use } from "react";
import { usePaneFocused } from "@/components/epic-tabs/pane-visibility-context";

export interface MobileBotHeaderSlotValue {
  readonly target: HTMLDivElement | null;
  readonly setTarget: (target: HTMLDivElement | null) => void;
}

export const MobileBotHeaderSlotContext =
  createContext<MobileBotHeaderSlotValue | null>(null);

/** Null outside an app shell; the surface then keeps its own header. */
export function useMobileBotHeaderSlot(): MobileBotHeaderSlotValue | null {
  const slot = use(MobileBotHeaderSlotContext);
  const focused = usePaneFocused();
  return focused ? slot : null;
}

import { useCallback, useState, type MouseEvent } from "react";
import {
  useLongPress,
  type LongPressHandlers,
} from "@/hooks/ui/use-long-press";

export interface WorkspaceFolderPreviewReveal {
  readonly open: boolean;
  readonly close: () => void;
  /** Radix's `Slot` runs a child's handler before the slot's own, so a wrapper placed outside the popover trigger
   * would let the picker open before the guard below ever ran. */
  readonly triggerProps: LongPressHandlers & {
    readonly onClick: (event: MouseEvent<HTMLElement>) => void;
  };
}

/** Press-and-hold answers it the way an abbreviated row in the remote folder picker already does: tap acts,
 * hold reveals, one shared recognizer so the app keeps a single press vocabulary. */
export function useWorkspaceFolderPreviewReveal(): WorkspaceFolderPreviewReveal {
  const [open, setOpen] = useState(false);
  const longPress = useLongPress({
    onLongPress: () => setOpen(true),
    disabled: false,
  });
  const close = useCallback(() => setOpen(false), []);
  return {
    open,
    close,
    triggerProps: {
      ...longPress.handlers,
      onClick: (event) => {
        // `preventDefault` rather than `stopPropagation`: the picker opens from a composed Radix handler on this same
        // element, which defers to a prevented default and would ignore a stopped bubble.
        if (!longPress.consumedTap()) return;
        event.preventDefault();
      },
    },
  };
}

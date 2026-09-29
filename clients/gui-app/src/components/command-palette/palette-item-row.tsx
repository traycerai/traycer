import * as React from "react";
import { CommandItem } from "@/components/ui/command";

/**
 * Action palettes have no chosen-value checkmark. No `hover:` fill either:
 * Command already selects the row under a moving pointer, so a hover fill
 * would only paint a SECOND highlight on whatever row a resting pointer sits
 * over when the palette opens or the list reorders.
 */
export function PaletteItemRow(
  props: React.ComponentProps<typeof CommandItem>,
) {
  return <CommandItem {...props} showCheck={false} />;
}

/**
 * A menu item that is OFF but says why, and stays reachable (review 7): the
 * held-elsewhere "Customize layout..." and the rail's last shown panel. Its
 * label is `ExplainedMenuItemLabel` (`explained-menu-item-label.tsx`).
 *
 * Radix's `disabled` takes an item out of roving focus, so a keyboard or
 * screen-reader user never lands on it and never hears its reason. So the
 * item is `aria-disabled` instead - it reads as disabled and the menu styles
 * it so (`aria-disabled:opacity-50` in `ui/context-menu.tsx`) - its reason is
 * its description, and the press is refused here. The menu stays open on a
 * refused press, which is the answer to it.
 *
 * The item's action goes through `onSelect` and nothing else: a checkbox
 * item still calls its `onCheckedChange` after `onSelect` is
 * default-prevented, so a refusal there would not hold.
 */
export function explainedMenuItemProps(input: {
  readonly off: boolean;
  readonly reasonId: string;
  readonly onSelect: (event: Event) => void;
}): {
  readonly "aria-disabled": true | undefined;
  readonly "aria-describedby": string | undefined;
  readonly onSelect: (event: Event) => void;
} {
  const { off, reasonId, onSelect } = input;
  return {
    "aria-disabled": off ? true : undefined,
    "aria-describedby": off ? reasonId : undefined,
    onSelect: (event) => {
      if (off) {
        event.preventDefault();
        return;
      }
      onSelect(event);
    },
  };
}

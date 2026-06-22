// Radix renders nested overlays into separate portals, so their pointerdowns
// look "outside" the chip's Popover and would close it. Treat any click that
// lands inside one of these surfaces as still inside the chip.
//
// Menus are deliberately EXCLUDED: the folder picker opens from inside a
// dropdown menu (the terminal-agent launcher), where the menu is the PARENT,
// not a nested child - clicking it must dismiss the picker. None of the pickers
// nest a menu of their own, so excluding menus only affects that parent case.
const NESTED_OVERLAY_SELECTORS: ReadonlyArray<string> = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="listbox"]',
  '[data-slot="select-content"]',
  '[data-slot="dialog-content"]',
  // The Environment scripts modal stacks ON the open picker; closing it via an
  // outside-click lands on its overlay, which must not also dismiss the picker.
  '[data-slot="dialog-overlay"]',
  '[data-slot="popover-content"]',
];

export function preserveWhenNestedOverlay(event: Event): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  for (const selector of NESTED_OVERLAY_SELECTORS) {
    if (target.closest(selector) !== null) {
      event.preventDefault();
      return;
    }
  }
}

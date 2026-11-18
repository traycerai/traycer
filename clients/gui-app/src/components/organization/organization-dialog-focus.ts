const FOCUSABLE_CONTROL =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Capture before a menu closes: its item will no longer exist when the dialog closes. */
export function captureOrganizationDialogOpener(): HTMLElement | null {
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body
    ? resolveLauncher(active)
    : null;
}

function resolveLauncher(element: HTMLElement): HTMLElement | null {
  const menu = element.closest('[role="menu"]');
  if (menu === null) return element;
  const triggerId = menu.getAttribute("aria-labelledby");
  const trigger =
    triggerId === null ? null : element.ownerDocument.getElementById(triggerId);
  // Radix dropdowns and submenus name their trigger; follow nested menus out
  // to the persistent control rather than retaining a disappearing menu item.
  if (trigger !== null && trigger !== element) return resolveLauncher(trigger);
  // Context menus are pointer-anchored, so their root has no labelled-by link.
  // Our ContextMenuTrigger exposes the currently open source through data-slot.
  const contextTrigger = element.ownerDocument.querySelector<HTMLElement>(
    '[data-slot="context-menu-trigger"][data-state="open"]',
  );
  if (contextTrigger === null) return null;
  return contextTrigger.matches(FOCUSABLE_CONTROL)
    ? contextTrigger
    : contextTrigger.querySelector<HTMLElement>(FOCUSABLE_CONTROL);
}

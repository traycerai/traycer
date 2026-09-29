function guideTargetControl(target: HTMLElement): HTMLElement | null {
  const selector =
    'button:not(:disabled), a[href], input:not(:disabled):not([type="hidden"]), textarea:not(:disabled), select:not(:disabled), [contenteditable="true"], [tabindex="0"]';
  if (target.matches(selector)) return target;
  return (
    firstReachable(
      target.querySelectorAll<HTMLElement>(
        '[contenteditable="true"], textarea:not(:disabled)',
      ),
    ) ?? firstReachable(target.querySelectorAll<HTMLElement>(selector))
  );
}

/**
 * A target can hold a control for each breakpoint - Settings ▸ Layout's area
 * list is a select below `md` and a tab rail above it, both mounted - so the
 * first match in document order may be one a breakpoint does not draw, and
 * focusing it is a silent no-op that still reports success.
 */
function firstReachable(controls: NodeListOf<HTMLElement>): HTMLElement | null {
  for (const control of controls) {
    if (control.closest("[hidden], [inert]") !== null) continue;
    // `display: none` from a class; jsdom has no `checkVisibility`.
    if (
      typeof control.checkVisibility === "function" &&
      !control.checkVisibility()
    ) {
      continue;
    }
    // A tab list is reached through its SELECTED tab (the ARIA tabs pattern),
    // never the first one: the list itself carries no tab stop, so the first
    // match is its first tab, and a list that activates on focus would switch
    // to that tab the moment it was focused.
    const tabList = owningTabList(control);
    if (tabList !== null) {
      return (
        tabList.querySelector<HTMLElement>(
          '[role="tab"][aria-selected="true"]',
        ) ?? control
      );
    }
    return control;
  }
  return null;
}

/** The tab list `control` is, or is a tab of; `null` for anything else. */
function owningTabList(control: HTMLElement): HTMLElement | null {
  const role = control.getAttribute("role");
  if (role === "tablist") return control;
  if (role === "tab") return control.closest<HTMLElement>('[role="tablist"]');
  return null;
}

/**
 * Both of these answer whether they ACTED. A step whose control is not there
 * yet - a `folder-add` still disabled while the host binding resolves - is a
 * press that did nothing, and the caller must not retire the step's guidance
 * for it.
 */
export function focusGuideTarget(target: HTMLElement): boolean {
  const control = guideTargetControl(target);
  if (control === null) return false;
  control.focus({ preventScroll: true });
  return true;
}

export function interactWithGuideTarget(target: HTMLElement): boolean {
  const control = guideTargetControl(target);
  if (control === null || control.matches("[aria-disabled=true]")) return false;
  control.focus({ preventScroll: true });
  if (control.matches("button, a[href]")) control.click();
  return true;
}

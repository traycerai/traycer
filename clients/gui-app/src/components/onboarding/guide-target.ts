function guideTargetControl(target: HTMLElement): HTMLElement | null {
  const selector =
    'button:not(:disabled), a[href], input:not(:disabled):not([type="hidden"]), textarea:not(:disabled), select:not(:disabled), [contenteditable="true"], [tabindex="0"]';
  const control = target.matches(selector)
    ? target
    : (target.querySelector<HTMLElement>(
        '[contenteditable="true"], textarea:not(:disabled)',
      ) ?? target.querySelector<HTMLElement>(selector));
  return control;
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

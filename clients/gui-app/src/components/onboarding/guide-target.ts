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

export function focusGuideTarget(target: HTMLElement): void {
  guideTargetControl(target)?.focus({ preventScroll: true });
}

export function interactWithGuideTarget(target: HTMLElement): void {
  const control = guideTargetControl(target);
  control?.focus({ preventScroll: true });
  if (
    control?.matches("button:not(:disabled):not([aria-disabled=true]), a[href]")
  )
    control.click();
}

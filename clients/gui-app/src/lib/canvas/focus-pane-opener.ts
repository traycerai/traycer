let focusRequest = 0;

/** Explicit New Tab gestures focus an existing picker without adding a tab. */
export function requestPaneOpenerFocus(paneId: string): void {
  const request = ++focusRequest;
  const previousFocus = document.activeElement;
  let remainingFrames = 10;
  const focusWhenMounted = (): void => {
    if (request !== focusRequest) return;
    // Do not steal focus if the user moved elsewhere while React committed.
    if (
      document.activeElement !== previousFocus &&
      document.activeElement !== document.body
    )
      return;
    const opener = [
      ...document.querySelectorAll<HTMLElement>('[data-testid="pane-opener"]'),
    ].find((element) => element.getAttribute("data-group-id") === paneId);
    const input = opener?.querySelector<HTMLInputElement>(
      'input[data-slot="command-input"]',
    );
    if (input !== undefined && input !== null) {
      input.focus({ preventScroll: true });
    } else if (--remainingFrames > 0) {
      window.requestAnimationFrame(focusWhenMounted);
    }
  };
  window.requestAnimationFrame(focusWhenMounted);
}

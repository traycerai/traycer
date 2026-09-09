/** Explicit New Tab gestures focus an existing picker without adding a tab. */
export function requestPaneOpenerFocus(paneId: string): void {
  window.requestAnimationFrame(() => {
    const opener = [
      ...document.querySelectorAll<HTMLElement>('[data-testid="pane-opener"]'),
    ].find((element) => element.getAttribute("data-group-id") === paneId);
    opener
      ?.querySelector<HTMLInputElement>('input[data-slot="command-input"]')
      ?.focus({ preventScroll: true });
  });
}

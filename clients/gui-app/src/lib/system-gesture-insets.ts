/** System-owned horizontal strips, in CSS pixels from the WebView edges. */
export interface SystemGestureInsets {
  readonly left: number;
  readonly right: number;
}

let insets: SystemGestureInsets = { left: 0, right: 0 };
let ready = true;

export function expectSystemGestureInsets(): void {
  ready = false;
}

export function systemGestureInsetsReady(): boolean {
  return ready;
}

export function setSystemGestureInsets(next: SystemGestureInsets): void {
  insets = {
    left: Number.isFinite(next.left) ? Math.max(0, next.left) : 0,
    right: Number.isFinite(next.right) ? Math.max(0, next.right) : 0,
  };
  ready = true;
}

export function readSystemGestureInsets(): SystemGestureInsets {
  return insets;
}

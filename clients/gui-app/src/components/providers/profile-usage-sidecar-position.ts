export interface ProfileUsageSidecarRect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
}

export interface ProfileUsageSidecarPositionInput {
  readonly anchor: ProfileUsageSidecarRect;
  readonly sidecarWidth: number;
  readonly sidecarHeight: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly gap: number;
  readonly padding: number;
}

export interface ProfileUsageSidecarPosition {
  readonly side: "right" | "left";
  readonly left: number;
  readonly top: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

/** Prefer right, flip left, and hide when either choice would overlap the menu. */
export function deriveProfileUsageSidecarPosition(
  input: ProfileUsageSidecarPositionInput,
): ProfileUsageSidecarPosition | null {
  const rightSpace =
    input.viewportWidth - input.anchor.right - input.gap - input.padding;
  const leftSpace = input.anchor.left - input.gap - input.padding;
  let side: ProfileUsageSidecarPosition["side"] | null = null;
  if (rightSpace >= input.sidecarWidth) side = "right";
  else if (leftSpace >= input.sidecarWidth) side = "left";
  if (side === null) return null;

  const maximumTop = Math.max(
    input.padding,
    input.viewportHeight - input.sidecarHeight - input.padding,
  );
  return {
    side,
    left:
      side === "right"
        ? input.anchor.right + input.gap
        : input.anchor.left - input.gap - input.sidecarWidth,
    top: clamp(input.anchor.top, input.padding, maximumTop),
  };
}

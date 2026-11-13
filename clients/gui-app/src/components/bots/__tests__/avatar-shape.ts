/**
 * The shape an avatar draws itself in, read from the rendered avatar.
 *
 * A person is a circle: every picture layer (image and initials) declares the
 * `clip-path` `circle(50%)`, its `var()` resolved through the inline custom
 * properties of the layer and its ancestors. jsdom applies no stylesheet, so
 * the declaration is read where the layer carries it: its arbitrary
 * `[clip-path:…]` property, the one utility that sets the clip.
 *
 * A bot is a squircle: its root declares `data-shape="squircle"` and it has
 * no picture layer at all, so nothing is clipped over its figure.
 *
 * "unknown" for anything else: a circle with a layer that is not clipped to
 * it, a squircle with a layer drawn over its figure, or no declared shape.
 */
export function avatarShape(
  avatar: HTMLElement,
): "circle" | "squircle" | "unknown" {
  const pictures = [
    ...avatar.querySelectorAll<HTMLElement>(
      '[data-slot="avatar-image"], [data-slot="avatar-fallback"]',
    ),
  ];
  if (avatar.dataset.shape === "squircle") {
    return pictures.length === 0 ? "squircle" : "unknown";
  }
  if (avatar.dataset.shape !== "circle" || pictures.length === 0) {
    return "unknown";
  }
  return pictures.every(isClippedToCircle) ? "circle" : "unknown";
}

function isClippedToCircle(picture: HTMLElement): boolean {
  const declared = declaredClipPath(picture);
  return declared !== null && resolveVar(declared, picture) === "circle(50%)";
}

/** The value of the picture's `[clip-path:…]` utility, or `null`. */
function declaredClipPath(picture: HTMLElement): string | null {
  for (const token of picture.classList) {
    const match = /^\[clip-path:(.+)\]$/.exec(token);
    if (match !== null) return match[1].replaceAll("_", " ");
  }
  return null;
}

/** `var(--x)` read from the nearest element that sets `--x` inline. */
function resolveVar(value: string, from: HTMLElement): string | null {
  const match = /^var\((--[\w-]+)\)$/.exec(value);
  if (match === null) return value;
  for (let node: HTMLElement | null = from; node; node = node.parentElement) {
    const set = node.style.getPropertyValue(match[1]);
    if (set !== "") return set.trim();
  }
  return null;
}

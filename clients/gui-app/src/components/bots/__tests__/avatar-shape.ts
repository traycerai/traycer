/**
 * The shape an avatar draws its picture in, read from the rendered picture
 * (its image or its initials): the `clip-path` the picture declares, its
 * `var()` resolved through the inline custom properties of the picture and
 * its ancestors, and for a `url(#id)` the `<clipPath>` that id names in the
 * document, whose path must be a squircle's. jsdom applies no stylesheet,
 * so the declaration is read where the picture carries it: its arbitrary
 * `[clip-path:…]` property, the one utility that sets the clip.
 *
 * "unknown" for a picture that declares no clip, a clip that resolves to
 * nothing, or a path that is not a squircle (a square, a circle, a polygon).
 */
export function avatarShape(
  avatar: HTMLElement,
): "circle" | "squircle" | "unknown" {
  const pictures = [
    ...avatar.querySelectorAll<HTMLElement>(
      '[data-slot="avatar-image"], [data-slot="avatar-fallback"]',
    ),
  ];
  if (pictures.length === 0) return "unknown";
  const [first, ...rest] = pictures.map(pictureShape);
  return rest.every((shape) => shape === first) ? first : "unknown";
}

function pictureShape(picture: HTMLElement): "circle" | "squircle" | "unknown" {
  const declared = declaredClipPath(picture);
  if (declared === null) return "unknown";
  const clip = resolveVar(declared, picture);
  if (clip === null) return "unknown";
  if (clip === "circle(50%)") return "circle";
  const match = /^url\("#([\w-]+)"\)$/.exec(clip);
  if (match === null) return "unknown";
  const target = picture.ownerDocument.getElementById(match[1]);
  if (target === null || target.tagName.toLowerCase() !== "clippath") {
    return "unknown";
  }
  if (target.getAttribute("clipPathUnits") !== "objectBoundingBox") {
    return "unknown";
  }
  const paths = target.querySelectorAll("path");
  if (paths.length !== 1 || target.children.length !== 1) return "unknown";
  return isSquirclePath(paths[0].getAttribute("d") ?? "")
    ? "squircle"
    : "unknown";
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

/** How far a squircle's control points may sit from its corner, in box units. */
const CORNER_REACH_MAX = 0.15;

/**
 * A squircle in bounding-box units: one closed path of four cubic curves
 * through the four edge midpoints, every control point ON the box's edge
 * (so each side runs straight into its corner) and pressed into its corner
 * further than a circle's (whose control points sit about 0.22 from the
 * corner). A square or polygon has no curves; a circle's controls stop short.
 */
function isSquirclePath(d: string): boolean {
  const tokens = d.match(/[A-Za-z]|-?\d*\.?\d+/g) ?? [];
  const numbers = (from: number, count: number): number[] | null => {
    const slice = tokens.slice(from, from + count).map(Number);
    return slice.length === count && slice.every(Number.isFinite)
      ? slice
      : null;
  };
  if (tokens[0] !== "M") return false;
  const start = numbers(1, 2);
  if (start === null || !near(start, [0.5, 0])) return false;
  const ends: ReadonlyArray<readonly [number, number]> = [
    [1, 0.5],
    [0.5, 1],
    [0, 0.5],
    [0.5, 0],
  ];
  const corners: ReadonlyArray<readonly [number, number]> = [
    [1, 0],
    [1, 1],
    [0, 1],
    [0, 0],
  ];
  let at = 3;
  for (const [index, end] of ends.entries()) {
    if (tokens[at] !== "C") return false;
    const segment = numbers(at + 1, 6);
    if (segment === null) return false;
    const corner = corners[index];
    const controls = [segment.slice(0, 2), segment.slice(2, 4)];
    for (const control of controls) {
      const onEdge = control.some(
        (value, axis) => Math.abs(value - corner[axis]) < 1e-9,
      );
      const reach = Math.max(
        Math.abs(control[0] - corner[0]),
        Math.abs(control[1] - corner[1]),
      );
      if (!onEdge || reach > CORNER_REACH_MAX) return false;
    }
    if (!near(segment.slice(4, 6), end)) return false;
    at += 7;
  }
  return tokens[at]?.toUpperCase() === "Z" && at === tokens.length - 1;
}

function near(
  point: readonly number[],
  target: readonly [number, number],
): boolean {
  return (
    Math.abs(point[0] - target[0]) < 1e-9 &&
    Math.abs(point[1] - target[1]) < 1e-9
  );
}

/**
 * The shape an avatar draws its picture in, read from the rendered element:
 * the clip its root hands its picture layer (`--avatar-clip`), and for a url
 * the clip path it names, which must be in the document. Never the classes.
 */
export function avatarShape(
  avatar: HTMLElement,
): "circle" | "squircle" | "unknown" {
  const clip = avatar.style.getPropertyValue("--avatar-clip");
  if (clip === "circle(50%)") return "circle";
  const match = /^url\("#([\w-]+)"\)$/.exec(clip);
  if (match === null) return "unknown";
  const target = avatar.ownerDocument.getElementById(match[1]);
  if (target === null || target.tagName.toLowerCase() !== "clippath") {
    return "unknown";
  }
  if (target.getAttribute("clipPathUnits") !== "objectBoundingBox") {
    return "unknown";
  }
  return target.querySelector("path") === null ? "unknown" : "squircle";
}

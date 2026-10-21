export const CANVAS_IMAGE_MAX_BYTES = 15 * 1024 * 1024;
const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);
export function canvasImageRefusal(file: File): string | null {
  if (!IMAGE_TYPES.has(file.type))
    return "Choose a PNG, JPEG, GIF, WebP or AVIF image.";
  if (file.size === 0) return "This image is empty.";
  return file.size > CANVAS_IMAGE_MAX_BYTES
    ? "Choose an image smaller than 15 MiB."
    : null;
}
export function canvasImageBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const refusal = canvasImageRefusal(file);
    if (refusal !== null) {
      reject(new Error(refusal));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("This image could not be read."));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("This image could not be read."));
        return;
      }
      const separator = reader.result.indexOf(",");
      if (separator < 0) {
        reject(new Error("This image could not be read."));
        return;
      }
      resolve(reader.result.slice(separator + 1));
    };
    reader.readAsDataURL(file);
  });
}

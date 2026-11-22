import { vi } from "vitest";

/**
 * Radix `AvatarImage` commits its `<img>` once the image has loaded, and jsdom
 * never loads one. This image is complete the moment it is made and reports a
 * load to the first listener, so a picture's `<img src>` reaches the DOM.
 * Pair it with `vi.unstubAllGlobals()` in the test's teardown.
 */
class ImmediateImage {
  complete = true;
  naturalWidth = 1;
  src = "";
  addEventListener(
    type: string,
    listener: (event: { currentTarget: ImmediateImage }) => void,
  ): void {
    if (type === "load") listener({ currentTarget: this });
  }
  removeEventListener(): void {}
}

export function stubImmediateImage(): void {
  vi.stubGlobal("Image", ImmediateImage);
}

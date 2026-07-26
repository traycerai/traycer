import { afterEach, describe, expect, it, vi } from "vitest";
import { installTitleBarOverlayThemeSync } from "@/lib/title-bar-overlay-theme";

afterEach(() => {
  document.documentElement.removeAttribute("style");
  vi.restoreAllMocks();
});

describe("installTitleBarOverlayThemeSync", () => {
  it("pushes the current theme colors immediately", async () => {
    document.documentElement.style.setProperty("--canvas", "#ffffff");
    document.documentElement.style.setProperty(
      "--canvas-foreground",
      "#171717",
    );
    const setTitleBarOverlay = vi.fn(() => Promise.resolve());

    const dispose = installTitleBarOverlayThemeSync(
      { setTitleBarOverlay },
      document,
    );
    await Promise.resolve();

    expect(setTitleBarOverlay).toHaveBeenCalledWith("#ffffff", "#171717");
    dispose();
  });

  it("retries after window load so late stylesheet colors replace fallbacks", async () => {
    vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
    const setTitleBarOverlay = vi.fn(() => Promise.resolve());
    const dispose = installTitleBarOverlayThemeSync(
      { setTitleBarOverlay },
      document,
    );
    document.documentElement.style.setProperty("--canvas", "#f6f6f6");
    document.documentElement.style.setProperty(
      "--canvas-foreground",
      "#202020",
    );

    window.dispatchEvent(new Event("load"));
    await Promise.resolve();

    expect(setTitleBarOverlay).toHaveBeenLastCalledWith("#f6f6f6", "#202020");
    dispose();
  });
});

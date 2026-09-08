import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppearanceWallpaper,
  type AppearanceWallpaperImage,
} from "@/components/home/appearance-wallpaper";

const wallpaperTreatmentMock = vi.hoisted(() => ({
  url: null as string | null,
}));
vi.mock("@/hooks/appearance/use-wallpaper-treatment", () => ({
  useWallpaperTreatment: () => wallpaperTreatmentMock.url,
}));

function wallpaper(
  overrides: Partial<AppearanceWallpaperImage>,
): AppearanceWallpaperImage {
  return {
    kind: "image",
    path: "appearance/hash.webp",
    focalPoint: [0.5, 0.5],
    treatment: "original",
    dimming: 0,
    strength: 0,
    ...overrides,
  };
}

function queryImage(container: HTMLElement): HTMLImageElement {
  const img = container.querySelector<HTMLImageElement>("img");
  if (img === null) throw new Error("expected an img element");
  return img;
}

afterEach(() => {
  cleanup();
  wallpaperTreatmentMock.url = null;
});

describe("AppearanceWallpaper", () => {
  it("renders nothing when there is no wallpaper configured", () => {
    wallpaperTreatmentMock.url = "blob:original";
    const { container } = render(
      <AppearanceWallpaper
        wallpaper={null}
        originalUrl="blob:original"
        scope={null}
        onDecodeFailure={null}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing while the treated URL is not yet available", () => {
    wallpaperTreatmentMock.url = null;
    const { container } = render(
      <AppearanceWallpaper
        wallpaper={wallpaper({})}
        originalUrl={null}
        scope={null}
        onDecodeFailure={null}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("is a noninteractive, aria-hidden decoration positioned by focal point and dimming", () => {
    wallpaperTreatmentMock.url = "blob:original";
    const { container } = render(
      <AppearanceWallpaper
        wallpaper={wallpaper({ focalPoint: [0.2, 0.8], dimming: 0.3 })}
        originalUrl="blob:original"
        scope={null}
        onDecodeFailure={null}
      />,
    );
    const root = container.querySelector<HTMLElement>(".appearance-wallpaper");
    if (root === null) throw new Error("expected the wallpaper root element");
    expect(root.getAttribute("aria-hidden")).toBe("true");
    expect(root.className).toContain("pointer-events-none");
    const img = queryImage(container);
    expect(img.getAttribute("draggable")).toBe("false");
    expect(img.style.objectPosition).toBe("20% 80%");
    expect(img.style.opacity).toBe("0.7");
  });

  it("renders the texture overlay only for treatment=texture, scaled by strength", () => {
    wallpaperTreatmentMock.url = "blob:original";
    const { container, rerender } = render(
      <AppearanceWallpaper
        wallpaper={wallpaper({ treatment: "original" })}
        originalUrl="blob:original"
        scope={null}
        onDecodeFailure={null}
      />,
    );
    expect(container.querySelector(".appearance-wallpaper-texture")).toBeNull();

    rerender(
      <AppearanceWallpaper
        wallpaper={wallpaper({ treatment: "texture", strength: 0.5 })}
        originalUrl="blob:original"
        scope={null}
        onDecodeFailure={null}
      />,
    );
    const texture = container.querySelector<HTMLElement>(
      ".appearance-wallpaper-texture",
    );
    if (texture === null) throw new Error("expected the texture overlay");
    expect(texture.style.opacity).toBe(String(0.5 * 0.28));
  });

  it("falls back to the original image when the DERIVED image fails to decode, without reporting a decode failure", () => {
    wallpaperTreatmentMock.url = "blob:derived";
    const onDecodeFailure = vi.fn();
    const { container } = render(
      <AppearanceWallpaper
        wallpaper={wallpaper({ treatment: "dither", strength: 0.5 })}
        originalUrl="blob:original"
        scope={null}
        onDecodeFailure={onDecodeFailure}
      />,
    );
    expect(queryImage(container).src).toContain("blob:derived");

    fireEvent.error(queryImage(container));

    expect(queryImage(container).src).toContain("blob:original");
    expect(onDecodeFailure).not.toHaveBeenCalled();
  });

  it("reports a decode failure once the ORIGINAL image (not a derived one) fails to decode", () => {
    wallpaperTreatmentMock.url = "blob:original";
    const onDecodeFailure = vi.fn();
    const { container } = render(
      <AppearanceWallpaper
        wallpaper={wallpaper({ treatment: "original" })}
        originalUrl="blob:original"
        scope={null}
        onDecodeFailure={onDecodeFailure}
      />,
    );
    fireEvent.error(queryImage(container));
    expect(onDecodeFailure).toHaveBeenCalledTimes(1);
  });

  it("reports a decode failure only once the fallback to original has itself failed", () => {
    wallpaperTreatmentMock.url = "blob:derived";
    const onDecodeFailure = vi.fn();
    const { container } = render(
      <AppearanceWallpaper
        wallpaper={wallpaper({ treatment: "dither", strength: 0.5 })}
        originalUrl="blob:original"
        scope={null}
        onDecodeFailure={onDecodeFailure}
      />,
    );
    fireEvent.error(queryImage(container)); // derived fails -> falls back to original
    fireEvent.error(queryImage(container)); // original ALSO fails -> reports once
    expect(onDecodeFailure).toHaveBeenCalledTimes(1);
  });
});

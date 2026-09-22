import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { domMax, LazyMotion } from "motion/react";
import { MobileNavDrawerSurface } from "@/components/layout/shell/mobile-nav-drawer-surface";

const nativeOffsetWidth = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetWidth",
);

afterEach(() => {
  cleanup();
  if (nativeOffsetWidth === undefined) {
    Reflect.deleteProperty(HTMLElement.prototype, "offsetWidth");
    return;
  }
  Object.defineProperty(
    HTMLElement.prototype,
    "offsetWidth",
    nativeOffsetWidth,
  );
});

function Harness(props: { readonly open: boolean }) {
  return (
    <LazyMotion features={domMax}>
      <MobileNavDrawerSurface open={props.open} onOpenChange={() => undefined}>
        <div>Menu</div>
      </MobileNavDrawerSurface>
    </LazyMotion>
  );
}

describe("MobileNavDrawerSurface scrim backdrop blur", () => {
  it("has no blur while closed, gains it when open, and loses it again on close", () => {
    const { rerender } = render(<Harness open={false} />);
    const scrim = screen.getByTestId("mobile-nav-drawer-scrim");
    expect(
      scrim.classList.contains("supports-backdrop-filter:backdrop-blur-xs"),
    ).toBe(false);

    // jsdom reports offsetWidth 0 for the unstubbed panel, so the settle
    // target equals the current position and settledOpen flips synchronously
    // (same reasoning as mobile-nav-drawer.test.tsx's "platform branch").
    rerender(<Harness open />);
    expect(
      scrim.classList.contains("supports-backdrop-filter:backdrop-blur-xs"),
    ).toBe(true);

    rerender(<Harness open={false} />);
    expect(
      scrim.classList.contains("supports-backdrop-filter:backdrop-blur-xs"),
    ).toBe(false);
  });

  it("keeps blur during opening and closing settles", async () => {
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      value: 300,
      configurable: true,
    });

    const { rerender } = render(<Harness open={false} />);
    const scrim = screen.getByTestId("mobile-nav-drawer-scrim");

    expect(
      scrim.classList.contains("supports-backdrop-filter:backdrop-blur-xs"),
    ).toBe(false);

    rerender(<Harness open />);
    expect(
      scrim.classList.contains("supports-backdrop-filter:backdrop-blur-xs"),
    ).toBe(true);

    await waitFor(() => {
      expect(scrim.style.opacity).not.toBe("0");
    });

    rerender(<Harness open={false} />);
    expect(
      scrim.classList.contains("supports-backdrop-filter:backdrop-blur-xs"),
    ).toBe(true);
  });
});

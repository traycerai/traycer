import { render } from "@testing-library/react";
import type { ToasterProps } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster } from "@/components/ui/sonner";

type SonnerToasterSpy = (props: ToasterProps) => void;

const sonnerToasterProps = vi.hoisted(() => vi.fn<SonnerToasterSpy>());
const themeState = vi.hoisted<{ theme: string | undefined }>(() => ({
  theme: "dark",
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: themeState.theme }),
}));

vi.mock("sonner", () => ({
  Toaster: (props: ToasterProps) => {
    sonnerToasterProps(props);
    return null;
  },
}));

describe("<Toaster />", () => {
  beforeEach(() => {
    sonnerToasterProps.mockClear();
    themeState.theme = "dark";
  });

  it("enables close buttons by default", () => {
    render(<Toaster />);

    expect(lastSonnerToasterProps().closeButton).toBe(true);
  });

  it("hides close buttons until toast hover or focus on hover-capable devices", () => {
    render(<Toaster />);

    const classNames = lastSonnerToasterProps().toastOptions?.classNames;
    const closeButton = closeButtonTokens();

    expect(classNames?.toast).toContain("group/toast");
    expect(closeButton).toContain("can-hover:opacity-0");
    expect(closeButton).toContain("can-hover:pointer-events-none");
    expect(closeButton).toContain("group-hover/toast:opacity-100");
    expect(closeButton).toContain("group-focus-within/toast:opacity-100");
  });

  it("leaves close buttons visible and tappable on touch devices", () => {
    render(<Toaster />);

    // Every hiding utility is scoped to `can-hover`, so under sonner's touch
    // query nothing overrides its always-visible default. The real media
    // query is exercised in `scripts/toast-close-button-touch-browser.mjs`.
    const hides = closeButtonTokens().filter((token) =>
      /(^|:)(opacity-0|pointer-events-none)$/.test(token),
    );
    expect(hides).toEqual([
      "can-hover:pointer-events-none",
      "can-hover:opacity-0",
    ]);
    expect(closeButtonTokens()).toEqual(
      expect.arrayContaining(["touch:after:absolute", "touch:after:size-11"]),
    );
  });

  it("allows callers to opt out of close buttons", () => {
    render(<Toaster closeButton={false} />);

    expect(lastSonnerToasterProps().closeButton).toBe(false);
  });

  it("normalizes unsupported theme values to the system theme", () => {
    themeState.theme = "unsupported";

    render(<Toaster />);

    expect(lastSonnerToasterProps().theme).toBe("system");
  });
});

function closeButtonTokens(): string[] {
  const closeButton =
    lastSonnerToasterProps().toastOptions?.classNames?.closeButton;
  if (closeButton === undefined) {
    throw new Error("Expected a close button class name.");
  }
  return closeButton.split(/\s+/);
}

function lastSonnerToasterProps(): ToasterProps {
  const lastCall = sonnerToasterProps.mock.lastCall;
  if (lastCall === undefined) {
    throw new Error("Expected Sonner Toaster to be rendered.");
  }
  const [props] = lastCall;
  return props;
}

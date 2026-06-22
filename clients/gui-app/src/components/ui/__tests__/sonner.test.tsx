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

  it("shows close buttons only on toast hover or focus", () => {
    render(<Toaster />);

    const classNames = lastSonnerToasterProps().toastOptions?.classNames;

    expect(classNames?.toast).toContain("group/toast");
    expect(classNames?.closeButton).toContain("opacity-0");
    expect(classNames?.closeButton).toContain("group-hover/toast:opacity-100");
    expect(classNames?.closeButton).toContain(
      "group-focus-within/toast:opacity-100",
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

function lastSonnerToasterProps(): ToasterProps {
  const lastCall = sonnerToasterProps.mock.lastCall;
  if (lastCall === undefined) {
    throw new Error("Expected Sonner Toaster to be rendered.");
  }
  const [props] = lastCall;
  return props;
}

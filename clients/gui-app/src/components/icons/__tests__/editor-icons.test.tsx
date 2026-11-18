import { describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach } from "vitest";
import {
  CursorIcon,
  VisualStudioCodeIcon,
  WindsurfIcon,
  ZedIcon,
} from "@/components/icons/editor-icons";

afterEach(() => {
  cleanup();
});

describe("editor icon components", () => {
  const icons = [
    { name: "VisualStudioCodeIcon", Component: VisualStudioCodeIcon },
    { name: "CursorIcon", Component: CursorIcon },
    { name: "WindsurfIcon", Component: WindsurfIcon },
    { name: "ZedIcon", Component: ZedIcon },
  ] as const;

  for (const { name, Component } of icons) {
    it(`${name} renders an svg element`, () => {
      const { container } = render(
        <Component className={undefined} aria-hidden={undefined} />,
      );
      expect(container.querySelector("svg")).not.toBeNull();
    });

    it(`${name} forwards className`, () => {
      const { container } = render(
        <Component className="size-4 test-class" aria-hidden={undefined} />,
      );
      const svg = container.querySelector("svg");
      expect(svg?.getAttribute("class")).toContain("test-class");
    });

    it(`${name} forwards aria-hidden`, () => {
      const { container } = render(
        <Component className={undefined} aria-hidden="true" />,
      );
      const svg = container.querySelector("svg");
      expect(svg?.getAttribute("aria-hidden")).toBe("true");
    });
  }
});

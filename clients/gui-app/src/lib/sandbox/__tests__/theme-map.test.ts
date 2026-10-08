import { describe, expect, it } from "vitest";
import { sandboxTheme, sandboxThemeVariables } from "../theme-map";

const read = (token: string): string => `<${token}>`;

// The names the MCP Apps spec (2026-01-26) defines for `styles.variables`
// that Traycer fills.
const SPEC_NAMES = [
  "--color-background-primary",
  "--color-background-secondary",
  "--color-background-tertiary",
  "--color-background-inverse",
  "--color-background-info",
  "--color-background-danger",
  "--color-background-success",
  "--color-background-warning",
  "--color-text-primary",
  "--color-text-secondary",
  "--color-text-tertiary",
  "--color-text-inverse",
  "--color-text-info",
  "--color-text-danger",
  "--color-text-success",
  "--color-text-warning",
  "--color-border-primary",
  "--color-border-secondary",
  "--color-border-danger",
  "--color-ring-primary",
  "--font-sans",
  "--font-mono",
  "--border-radius-sm",
  "--border-radius-md",
  "--border-radius-lg",
];

describe("sandboxThemeVariables", () => {
  it("fills every spec variable name from the app's resolved tokens", () => {
    const variables = sandboxThemeVariables(read);
    for (const name of SPEC_NAMES) {
      expect(variables[name], name).toBeTruthy();
    }
    expect(variables["--color-background-primary"]).toBe("<--background>");
    expect(variables["--color-text-primary"]).toBe("<--foreground>");
    expect(variables["--color-text-danger"]).toBe("<--destructive>");
    expect(variables["--font-sans"]).toBe("<--traycer-font-ui>");
  });

  it("tints status backgrounds over the page background", () => {
    expect(sandboxThemeVariables(read)["--color-background-danger"]).toBe(
      "color-mix(in oklab, <--destructive> 15%, <--background>)",
    );
  });

  it("derives the radius scale from the app radius", () => {
    const variables = sandboxThemeVariables(read);
    expect(variables["--border-radius-md"]).toBe("<--radius>");
    expect(variables["--border-radius-sm"]).toBe("calc(<--radius> - 2px)");
    expect(variables["--border-radius-lg"]).toBe("calc(<--radius> + 2px)");
  });

  it("adds six chart colors from the terminal palette", () => {
    const variables = sandboxThemeVariables(read);
    expect(variables["--traycer-chart-1"]).toBe("<--term-ansi-blue>");
    expect(variables["--traycer-chart-6"]).toBe("<--term-ansi-red>");
    expect(variables["--traycer-chart-7"]).toBeUndefined();
  });
});

describe("sandboxTheme", () => {
  it("lets pages and apps follow the app's mode and paint the transcript surface", () => {
    for (const kind of ["page", "app"] as const) {
      for (const mode of ["light", "dark"] as const) {
        const theme = sandboxTheme(kind, mode, read);
        expect(theme.colorScheme).toBe(mode);
        expect(theme.background).toBe("<--background>");
      }
    }
  });

  it("keeps wireframes a light canvas in either mode, with the variables still available", () => {
    for (const mode of ["light", "dark"] as const) {
      const theme = sandboxTheme("wireframe", mode, read);
      expect(theme.colorScheme).toBe("light");
      expect(theme.background).toBeNull();
      expect(theme.variables["--color-text-primary"]).toBe("<--foreground>");
    }
  });
});

import { describe, expect, it } from "vitest";
import {
  escapeStyleText,
  sandboxTheme,
  sandboxThemeVariables,
  themedPageDocument,
  type SandboxTheme,
} from "../theme-map";

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
  it("lets a page follow the app's mode and paint the transcript surface", () => {
    for (const mode of ["light", "dark"] as const) {
      const theme = sandboxTheme("page", mode, read);
      expect(theme.appliesToRoot).toBe(true);
      expect(theme.colorScheme).toBe(mode);
      expect(theme.background).toBe("<--background>");
    }
  });

  it("leaves an app's root to the app, which applies the host context itself", () => {
    for (const mode of ["light", "dark"] as const) {
      const theme = sandboxTheme("app", mode, read);
      expect(theme.appliesToRoot).toBe(false);
      expect(theme.colorScheme).toBe(mode);
      expect(theme.background).toBeNull();
      expect(theme.variables["--color-text-primary"]).toBe("<--foreground>");
    }
  });

  it("keeps wireframes a light canvas in either mode, with the variables still available", () => {
    for (const mode of ["light", "dark"] as const) {
      const theme = sandboxTheme("wireframe", mode, read);
      expect(theme.appliesToRoot).toBe(true);
      expect(theme.colorScheme).toBe("light");
      expect(theme.background).toBeNull();
      expect(theme.variables["--color-text-primary"]).toBe("<--foreground>");
    }
  });
});

describe("themedPageDocument", () => {
  const theme: SandboxTheme = {
    appliesToRoot: true,
    colorScheme: "dark",
    background: "#111",
    variables: { "--color-text-primary": "#eee" },
  };
  const STYLE =
    "<style>:root{color-scheme:dark;background:#111;--color-text-primary:#eee}</style>";

  it.each([
    [
      "first in a head with attributes",
      '<!DOCTYPE html><html><head data-x="1"><title>T</title></head><header>h</header></html>',
      `<!DOCTYPE html><html><head data-x="1">${STYLE}<title>T</title></head><header>h</header></html>`,
    ],
    [
      "after <html> when there is no head, never inside a <header>",
      "<!doctype html><html lang=en><header>h</header><p>x</p></html>",
      `<!doctype html><html lang=en>${STYLE}<header>h</header><p>x</p></html>`,
    ],
    [
      "after the doctype when there is no html, keeping standards mode",
      "  <!doctype html><p>x</p>",
      `  <!doctype html>${STYLE}<p>x</p>`,
    ],
    ["in front of a bare fragment", "<p>x</p>", `${STYLE}<p>x</p>`],
  ])("puts the theme %s", (_where, html, expected) => {
    expect(themedPageDocument(html, theme)).toBe(expected);
  });

  it("escapes a < in a theme value so it cannot close the style early", () => {
    const hostile: SandboxTheme = {
      ...theme,
      background: "red</style><script>alert(1)</script>",
    };
    const text = themedPageDocument("<p>x</p>", hostile);
    expect(text.match(/<\/style>/g)).toHaveLength(1);
    expect(text).not.toContain("<script>");
    expect(escapeStyleText("a<b")).toBe("a\\3c b");
  });
});

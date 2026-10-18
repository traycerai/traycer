import type { ResolvedTheme } from "@/lib/theme-applier";

/**
 * Our theme, spoken in the MCP Apps standard variable names, so an agent page,
 * a wireframe and an MCP App all style themselves the same way. The frame
 * cannot read the app's cascade, so the values are resolved here and written
 * into the page's first `<style>` by the loader.
 */
export interface SandboxTheme {
  /**
   * Whether the loader writes this theme onto the page's root. Off for an MCP
   * App: under the MCP Apps spec the app applies `hostContext.theme` and
   * `styles.variables` itself (`applyDocumentTheme`, `applyHostStyleVariables`),
   * and a dark `color-scheme` it never asked for turns the native controls of
   * a light-only app white-on-white.
   */
  readonly appliesToRoot: boolean;
  /** The reader's scheme for pages and apps; always light for wireframes. */
  readonly colorScheme: ResolvedTheme;
  /** The page's root background, or `null` to leave the canvas alone. */
  readonly background: string | null;
  readonly variables: Readonly<Record<string, string>>;
}

/** Reads one of our tokens as the cascade resolves it now, e.g. `--card`. */
export type ThemeTokenReader = (token: string) => string;

const STATUS_ROLES = [
  ["info", "--info"],
  ["danger", "--destructive"],
  ["success", "--success"],
  ["warning", "--warning"],
] as const;

/** Our extension beyond the spec names: chart colors from the terminal palette. */
const CHART_TOKENS = [
  "--term-ansi-blue",
  "--term-ansi-green",
  "--term-ansi-yellow",
  "--term-ansi-magenta",
  "--term-ansi-cyan",
  "--term-ansi-red",
] as const;

export function sandboxThemeVariables(
  read: ThemeTokenReader,
): Record<string, string> {
  const background = read("--background");
  const foreground = read("--foreground");
  const mutedForeground = read("--muted-foreground");
  const radius = read("--radius");
  const variables: Record<string, string> = {
    "--color-background-primary": background,
    "--color-background-secondary": read("--card"),
    "--color-background-tertiary": read("--muted"),
    "--color-background-inverse": foreground,
    "--color-text-primary": foreground,
    "--color-text-secondary": mutedForeground,
    "--color-text-tertiary": mutedForeground,
    "--color-text-inverse": background,
    "--color-border-primary": read("--border"),
    "--color-border-secondary": read("--input"),
    "--color-border-danger": read("--destructive"),
    "--color-ring-primary": read("--ring"),
    "--font-sans": read("--traycer-font-ui"),
    "--font-mono": read("--traycer-font-mono"),
    "--border-radius-sm": `calc(${radius} - 2px)`,
    "--border-radius-md": radius,
    "--border-radius-lg": `calc(${radius} + 2px)`,
  };
  for (const [role, token] of STATUS_ROLES) {
    const color = read(token);
    variables[`--color-background-${role}`] =
      `color-mix(in oklab, ${color} 15%, ${background})`;
    variables[`--color-text-${role}`] = color;
  }
  CHART_TOKENS.forEach((token, index) => {
    variables[`--traycer-chart-${index + 1}`] = read(token);
  });
  return variables;
}

/**
 * The theme a frame of this kind paints with.
 *
 * A page blends into the transcript: the app's color scheme, and the
 * transcript surface as its root background. An MCP App gets the same values
 * only through its host context and applies them itself. A wireframe keeps the look
 * it had as a srcdoc frame - a light canvas whatever the app theme - because
 * wireframes written before this change rely on default black text over
 * their own white panels. It still gets the variables, for wireframes that
 * opt in to them.
 */
export function sandboxTheme(
  kind: "page" | "wireframe" | "app",
  mode: ResolvedTheme,
  read: ThemeTokenReader,
): SandboxTheme {
  const variables = sandboxThemeVariables(read);
  if (kind === "wireframe") {
    return {
      appliesToRoot: true,
      colorScheme: "light",
      background: null,
      variables,
    };
  }
  if (kind === "app") {
    return {
      appliesToRoot: false,
      colorScheme: mode,
      background: null,
      variables,
    };
  }
  return {
    appliesToRoot: true,
    colorScheme: mode,
    background: read("--background"),
    variables,
  };
}

const HEAD_OPEN = /<head(?:\s[^>]*)?>/i;
const HTML_OPEN = /<html(?:\s[^>]*)?>/i;
const INITIAL_DOCTYPE = /^\s*<!doctype(?:\s+[^>]*)?>/i;

/** `<` is the only character that can end a `<style>` element early. */
export function escapeStyleText(text: string): string {
  return text.replace(/</g, "\\3c ");
}

/**
 * A page as a standalone document that paints like its frame: the `:root`
 * rule the sandbox loader writes, as the first thing in the page's `<head>`
 * (else after `<html>`, else after the doctype, so standards mode is kept,
 * else in front). What a downloaded page carries, so it opens styled in any
 * browser. The loader cannot import this - it is built alone into a classic
 * script - so it writes the same rule itself; keep the two in step.
 */
export function themedPageDocument(html: string, theme: SandboxTheme): string {
  const declarations = [`color-scheme:${theme.colorScheme}`];
  if (theme.background !== null) {
    declarations.push(`background:${theme.background}`);
  }
  for (const [name, value] of Object.entries(theme.variables)) {
    declarations.push(`${name}:${value}`);
  }
  const style = `<style>${escapeStyleText(`:root{${declarations.join(";")}}`)}</style>`;
  const anchor =
    HEAD_OPEN.exec(html) ?? HTML_OPEN.exec(html) ?? INITIAL_DOCTYPE.exec(html);
  const at = anchor === null ? 0 : anchor.index + anchor[0].length;
  return html.slice(0, at) + style + html.slice(at);
}

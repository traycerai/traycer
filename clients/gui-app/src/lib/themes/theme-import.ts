import {
  formatHex,
  parse as parseColor,
  rgb,
  wcagContrast,
  wcagLuminance,
} from "culori";
import { Unzip, UnzipInflate } from "fflate";
import { parse, type ParseError } from "jsonc-parser";
import { z } from "zod";
import { THEME_PRESETS } from "@/lib/theme-presets";
import {
  deriveThemeColors,
  ensureVisibleThemeBorders,
  isThemeToken,
  themeSyntaxSchema,
  themeDefinitionSchema,
  type ThemeDefinition,
  type ThemeToken,
} from "@/lib/themes/theme-definition";

export const MAX_THEME_PACKAGE_BYTES = 20 * 1024 * 1024;
const MAX_THEME_BYTES = 2 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 32 * 1024 * 1024;
const MAX_THEMES = 100;
const vsCodeTokenRuleSchema =
  themeSyntaxSchema.shape.tokenColors.element.extend({
    name: z
      .string()
      .transform((value) => value.slice(0, 256))
      .optional(),
    settings: themeSyntaxSchema.shape.tokenColors.element.shape.settings.extend(
      {
        // VS Code ignores unknown styles; Dracula uses both "normal" and "regular" to reset them.
        fontStyle: z
          .string()
          .max(128)
          .transform((value) =>
            value
              .trim()
              .split(/\s+/)
              .filter((style) =>
                ["italic", "bold", "underline", "strikethrough"].includes(
                  style,
                ),
              )
              .join(" "),
          )
          .optional(),
      },
    ),
  });
const vsCodeThemeSchema = z.object({
  name: z.string().max(256).optional(),
  displayName: z.string().max(256).optional(),
  type: z.string().max(32).optional(),
  include: z.string().max(1024).optional(),
  colors: z
    .preprocess(
      (value) => {
        const record = z.record(z.string(), z.unknown()).safeParse(value);
        return record.success
          ? Object.fromEntries(
              Object.entries(record.data).filter(([, color]) => color !== null),
            )
          : value;
      },
      z.record(
        themeSyntaxSchema.shape.colors.keyType,
        z.union([
          z.literal("default"),
          themeSyntaxSchema.shape.colors.valueType,
        ]),
      ),
    )
    .default({}),
  tokenColors: z.array(vsCodeTokenRuleSchema).max(4096).default([]),
});
type VsCodeTheme = z.infer<typeof vsCodeThemeSchema>;
const manifestSchema = z.object({
  displayName: z.string().max(256).optional(),
  publisher: z.string().max(128).optional(),
  name: z.string().max(128).optional(),
  version: z.string().max(128).optional(),
  contributes: z.object({
    themes: z
      .array(
        z.object({
          label: z.string().max(256).optional(),
          uiTheme: z.string().max(32).optional(),
          path: z.string().max(1024),
        }),
      )
      .min(1)
      .max(MAX_THEMES),
  }),
});

const WORKBENCH_COLORS: Partial<Record<ThemeToken, string[]>> = {
  background: ["editor.background"],
  sidebar: [
    "sideBar.background",
    "activityBar.background",
    "editor.background",
  ],
  "sidebar-foreground": [
    "sideBar.foreground",
    "foreground",
    "editor.foreground",
  ],
  foreground: ["foreground", "editor.foreground"],
  canvas: ["editor.background"],
  "canvas-foreground": ["editor.foreground", "foreground"],
  "canvas-border": ["editorGroup.border", "panel.border", "contrastBorder"],
  card: ["editorWidget.background", "panel.background", "editor.background"],
  "card-foreground": [
    "editorWidget.foreground",
    "foreground",
    "editor.foreground",
  ],
  popover: [
    "menu.background",
    "quickInput.background",
    "dropdown.background",
    "editor.background",
  ],
  "popover-foreground": [
    "menu.foreground",
    "quickInput.foreground",
    "foreground",
    "editor.foreground",
  ],
  primary: ["button.background", "focusBorder", "textLink.foreground"],
  "primary-foreground": ["button.foreground"],
  secondary: [
    "button.secondaryBackground",
    "editorWidget.background",
    "editor.background",
  ],
  "secondary-foreground": ["button.secondaryForeground", "editor.foreground"],
  muted: ["editorWidget.background", "editor.background"],
  "muted-foreground": [
    "descriptionForeground",
    "disabledForeground",
    "editor.foreground",
  ],
  accent: ["list.hoverBackground", "list.activeSelectionBackground"],
  "accent-foreground": [
    "list.hoverForeground",
    "list.activeSelectionForeground",
    "editor.foreground",
  ],
  border: ["sideBar.border", "panel.border", "contrastBorder"],
  input: ["input.border", "dropdown.border", "panel.border"],
  ring: ["focusBorder", "button.background"],
  destructive: ["errorForeground", "editorError.foreground"],
  success: ["gitDecoration.addedResourceForeground", "terminal.ansiGreen"],
  "success-foreground": [
    "gitDecoration.addedResourceForeground",
    "terminal.ansiGreen",
  ],
  warning: ["editorWarning.foreground", "terminal.ansiYellow"],
  "warning-foreground": ["editorWarning.foreground", "terminal.ansiYellow"],
  "term-background": [
    "terminal.background",
    "panel.background",
    "editor.background",
  ],
  "term-foreground": ["terminal.foreground", "editor.foreground"],
  "term-cursor": [
    "terminalCursor.foreground",
    "editorCursor.foreground",
    "terminal.foreground",
  ],
  "term-selection": [
    "terminal.selectionBackground",
    "editor.selectionBackground",
  ],
};
const ANSI_NAMES = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
] as const;
for (const name of ANSI_NAMES) {
  const capitalized = name[0].toUpperCase() + name.slice(1);
  WORKBENCH_COLORS[`term-ansi-${name}`] = [`terminal.ansi${capitalized}`];
  WORKBENCH_COLORS[`term-ansi-bright-${name}`] = [
    `terminal.ansiBright${capitalized}`,
  ];
}

function parseJsonc(text: string): unknown {
  if (new TextEncoder().encode(text).byteLength > MAX_THEME_BYTES) {
    throw new Error("Theme JSON exceeds the 2 MB import limit.");
  }
  const errors: ParseError[] = [];
  const value: unknown = parse(text.replace(/^\uFEFF/, ""), errors, {
    allowTrailingComma: true,
  });
  if (errors.length > 0) throw new Error("The theme contains invalid JSON.");
  return value;
}

function composite(color: string, surface: string): string {
  const foreground = rgb(
    parseColor(color) ?? { mode: "rgb", r: 0, g: 0, b: 0 },
  );
  const background = rgb(
    parseColor(surface) ?? { mode: "rgb", r: 0, g: 0, b: 0 },
  );
  const alpha = foreground.alpha ?? 1;
  return formatHex({
    mode: "rgb",
    r: foreground.r * alpha + background.r * (1 - alpha),
    g: foreground.g * alpha + background.g * (1 - alpha),
    b: foreground.b * alpha + background.b * (1 - alpha),
  });
}

const FOREGROUND_SURFACES: Partial<Record<ThemeToken, ThemeToken>> = {
  foreground: "background",
  "canvas-foreground": "canvas",
  "sidebar-foreground": "sidebar",
  "card-foreground": "card",
  "popover-foreground": "popover",
  "primary-foreground": "primary",
  "secondary-foreground": "secondary",
  "accent-foreground": "accent",
  "muted-foreground": "canvas",
  "term-foreground": "term-background",
  "term-cursor": "term-background",
};

function workbenchColor(theme: VsCodeTheme, key: string): string | undefined {
  const value = Object.hasOwn(theme.colors, key)
    ? theme.colors[key]
    : undefined;
  return value === "default" ? undefined : value;
}

function vsCodeAppearance(theme: VsCodeTheme): "light" | "dark" {
  if (
    theme.type === "light" ||
    theme.type === "vs" ||
    theme.type === "hc-light"
  )
    return "light";
  if (
    theme.type === "dark" ||
    theme.type === "vs-dark" ||
    theme.type === "hc-black"
  )
    return "dark";
  const background = workbenchColor(theme, "editor.background");
  const parsed = background ? parseColor(background) : undefined;
  if (parsed && wcagLuminance(parsed) > 0.179) return "light";
  return "dark";
}

function applyWorkbenchColors(
  theme: VsCodeTheme,
  colors: ThemeDefinition["colors"],
  canvas: string,
): void {
  for (const [token, candidates] of Object.entries(WORKBENCH_COLORS)) {
    if (!isThemeToken(token)) continue;
    const key = candidates.find(
      (candidate) => workbenchColor(theme, candidate) !== undefined,
    );
    if (key === undefined) continue;
    const value = key === "editor.background" ? canvas : theme.colors[key];
    const surface = FOREGROUND_SURFACES[token];
    let base = canvas;
    if (surface) base = colors[surface] ?? canvas;
    else if (token === "term-selection" || token.startsWith("term-ansi-"))
      base = colors["term-background"] ?? canvas;
    colors[token] = composite(value, base);
  }
}

function ensureReadableText(
  colors: ThemeDefinition["colors"],
  canvas: string,
): void {
  // Workbench foregrounds may land on different surfaces in Traycer; keep every text pair readable.
  for (const [token, surface] of Object.entries(FOREGROUND_SURFACES)) {
    if (!isThemeToken(token)) continue;
    const foreground = colors[token];
    const base = colors[surface] ?? canvas;
    if (foreground && wcagContrast(foreground, base) < 4.5) {
      colors[token] =
        wcagContrast("#ffffff", base) > wcagContrast("#000000", base)
          ? "#ffffff"
          : "#000000";
    }
  }
}

function convertVsCodeTheme(
  theme: VsCodeTheme,
  fallbackName: string,
): ThemeDefinition {
  const appearance = vsCodeAppearance(theme);
  const fallbackBackground = appearance === "dark" ? "#18181b" : "#fafafa";
  const canvas = composite(
    workbenchColor(theme, "editor.background") ?? fallbackBackground,
    fallbackBackground,
  );
  const accent =
    workbenchColor(theme, "button.background") ??
    workbenchColor(theme, "focusBorder") ??
    workbenchColor(theme, "textLink.foreground") ??
    "#3b82f6";
  const colors = deriveThemeColors(
    canvas,
    composite(accent, canvas),
    appearance,
  );
  applyWorkbenchColors(theme, colors, canvas);
  ensureReadableText(colors, canvas);
  ensureVisibleThemeBorders(colors);
  return themeDefinitionSchema.parse({
    version: 1,
    id: crypto.randomUUID(),
    name: (
      theme.displayName?.trim() ||
      theme.name?.trim() ||
      fallbackName
    ).slice(0, 80),
    appearance,
    base: "neutral",
    colors,
    syntax: {
      colors: Object.fromEntries(
        Object.entries(theme.colors).filter(([, color]) => color !== "default"),
      ),
      tokenColors: theme.tokenColors,
    },
  });
}

export function importThemeText(
  text: string,
  fallbackName: string,
): ThemeDefinition[] {
  const value = parseJsonc(text);
  const entries = Array.isArray(value) ? value : [value];
  if (entries.length === 0 || entries.length > MAX_THEMES)
    throw new Error("Import between 1 and 100 themes at a time.");
  return entries.map((entry: unknown) => {
    const record = z.record(z.string(), z.unknown()).parse(entry);
    if ("version" in record || "base" in record || "appearance" in record) {
      const theme = themeDefinitionSchema.parse({
        ...record,
        id: record.id ?? crypto.randomUUID(),
        syntax: record.syntax ?? null,
      });
      if (THEME_PRESETS.some((preset) => preset.id === theme.id)) {
        throw new Error(
          "This theme identity is reserved for a built-in palette.",
        );
      }
      return theme;
    }
    if (
      !("colors" in record) &&
      !("tokenColors" in record) &&
      !("include" in record)
    ) {
      throw new Error("This file is not a Traycer or VS Code color theme.");
    }
    const theme = vsCodeThemeSchema.parse(record);
    if (theme.include)
      throw new Error(
        "This theme references another file. Import the complete .vsix theme pack instead.",
      );
    return convertVsCodeTheme(theme, fallbackName);
  });
}

function packagePath(path: string, relativeTo: string): string {
  const input = path.replaceAll("\\", "/");
  if (
    input.length > 1024 ||
    input.startsWith("/") ||
    /^[a-zA-Z]:/.test(input) ||
    input.includes("\0")
  ) {
    throw new Error("Theme paths must stay inside their extension package.");
  }
  const segments = relativeTo.split("/").slice(0, -1);
  for (const part of input.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (segments.length <= 1)
        throw new Error("Theme path escapes the extension package.");
      segments.pop();
    } else segments.push(part);
  }
  if (segments[0] !== "extension")
    throw new Error("Theme path escapes the extension package.");
  return segments.join("/");
}

async function hashThemeContent(content: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export interface ThemePackageIdentity {
  publisher: string;
  name: string;
  version: string;
}

export function importThemePackage(
  bytes: Uint8Array,
): Promise<ThemeDefinition[]> {
  return readThemePackage(bytes, null, null);
}

export function importVerifiedThemePackage(
  bytes: Uint8Array,
  identity: ThemePackageIdentity,
  signal: AbortSignal,
): Promise<ThemeDefinition[]> {
  return readThemePackage(bytes, identity, signal);
}

async function readThemePackage(
  bytes: Uint8Array,
  identity: ThemePackageIdentity | null,
  signal: AbortSignal | null,
): Promise<ThemeDefinition[]> {
  signal?.throwIfAborted();
  if (bytes.byteLength > MAX_THEME_PACKAGE_BYTES)
    throw new Error("Theme packs must be smaller than 20 MB.");
  const files = new Map<string, string>();
  const seen = new Set<string>();
  let expandedBytes = 0;
  let entryCount = 0;
  const zip = new Unzip((file) => {
    entryCount += 1;
    if (entryCount > 5000)
      throw new Error("The theme pack contains too many files.");
    const name = file.name.replaceAll("\\", "/");
    if (
      name.length > 1024 ||
      name.startsWith("/") ||
      /^[a-zA-Z]:/.test(name) ||
      name.includes("\0") ||
      name.split("/").includes("..")
    )
      throw new Error("The theme pack contains an unsafe file path.");
    if (!name.startsWith("extension/")) return;
    const path = packagePath(
      name.slice("extension/".length),
      "extension/package.json",
    );
    if (seen.has(path))
      throw new Error("The theme pack contains duplicate paths.");
    seen.add(path);
    if (!/\.(?:json|jsonc)$/i.test(path)) return;
    if ((file.originalSize ?? 0) > MAX_THEME_BYTES)
      throw new Error("A theme file exceeds the 2 MB import limit.");
    let size = 0;
    let text = "";
    const decoder = new TextDecoder();
    file.ondata = (error, chunk, final) => {
      if (error) throw error;
      size += chunk.byteLength;
      expandedBytes += chunk.byteLength;
      if (size > MAX_THEME_BYTES || expandedBytes > MAX_EXPANDED_BYTES) {
        throw new Error("The theme pack expands beyond the safe import limit.");
      }
      text += decoder.decode(chunk, { stream: !final });
      if (final) files.set(path, text);
    };
    file.start();
  });
  zip.register(UnzipInflate);
  // Feed small chunks so decompression cannot allocate an entire zip bomb before the cap runs.
  let lastYield = performance.now();
  for (let offset = 0; offset < bytes.byteLength; offset += 1024) {
    if (performance.now() - lastYield >= 8) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      signal?.throwIfAborted();
      lastYield = performance.now();
    }
    zip.push(
      bytes.subarray(offset, offset + 1024),
      offset + 1024 >= bytes.byteLength,
    );
  }
  const manifestText = files.get("extension/package.json");
  if (!manifestText)
    throw new Error("The theme pack is missing its extension manifest.");
  const manifest = manifestSchema.parse(parseJsonc(manifestText));
  if (
    identity &&
    (manifest.publisher !== identity.publisher ||
      manifest.name !== identity.name ||
      manifest.version !== identity.version)
  ) {
    throw new Error(
      "The downloaded theme pack does not match the selected extension.",
    );
  }
  const resolved = new Map<string, VsCodeTheme>();
  function resolve(path: string, ancestors: Set<string>): VsCodeTheme {
    signal?.throwIfAborted();
    if (ancestors.has(path))
      throw new Error("The theme contains circular includes.");
    if (ancestors.size >= 8)
      throw new Error("Theme includes are nested too deeply.");
    const cached = resolved.get(path);
    if (cached) return cached;
    const source = files.get(path);
    if (!source)
      throw new Error(
        "A file referenced by the theme is missing from its package.",
      );
    const theme = vsCodeThemeSchema.parse(parseJsonc(source));
    if (!theme.include) {
      resolved.set(path, theme);
      return theme;
    }
    const parent = resolve(
      packagePath(theme.include, path),
      new Set([...ancestors, path]),
    );
    const merged = vsCodeThemeSchema.parse({
      ...parent,
      ...theme,
      colors: { ...parent.colors, ...theme.colors },
      tokenColors: [...parent.tokenColors, ...theme.tokenColors],
    });
    resolved.set(path, merged);
    return merged;
  }
  const packageName =
    manifest.name ??
    (await hashThemeContent(
      JSON.stringify(
        [...files.keys()].sort().map((path) => [path, files.get(path)]),
      ),
    ));
  const collectionId = `vsix:${manifest.publisher ?? "local"}.${packageName}`;
  const pathOccurrences = new Map<string, number>();
  return Promise.all(
    manifest.contributes.themes.map(async (contribution) => {
      const path = packagePath(contribution.path, "extension/package.json");
      const theme = resolve(path, new Set());
      const occurrence = pathOccurrences.get(path) ?? 0;
      pathOccurrences.set(path, occurrence + 1);
      const id = `imported:${await hashThemeContent(`${collectionId}:${path}:${occurrence}`)}`;
      signal?.throwIfAborted();
      return {
        ...convertVsCodeTheme(
          {
            ...theme,
            displayName: contribution.label ?? theme.displayName,
            name: contribution.label ?? theme.name,
            type: contribution.uiTheme ?? theme.type,
          },
          manifest.displayName ?? path.split("/").at(-1) ?? "Imported theme",
        ),
        id,
        collection: {
          id: collectionId,
          name: (
            manifest.displayName ??
            manifest.name ??
            "Imported theme pack"
          ).slice(0, 100),
        },
      };
    }),
  );
}

export interface ThemeImportBatch {
  themes: ThemeDefinition[];
  replaceCollectionIds: string[];
}

export async function importThemeFiles(
  files: File[],
  signal: AbortSignal,
): Promise<ThemeImportBatch> {
  if (files.length === 0 || files.length > MAX_THEMES)
    throw new Error("Choose between 1 and 100 theme files.");
  const themes: ThemeDefinition[] = [];
  const replaceCollectionIds = new Set<string>();
  for (const file of files) {
    signal.throwIfAborted();
    if (!/\.(?:json|jsonc|vsix)$/i.test(file.name))
      throw new Error("Choose a .json, .jsonc, or .vsix theme file.");
    const isPackage = /\.vsix$/i.test(file.name);
    if (file.size > (isPackage ? MAX_THEME_PACKAGE_BYTES : MAX_THEME_BYTES))
      throw new Error(
        "Theme JSON must be smaller than 2 MB; theme packs must be smaller than 20 MB.",
      );
    let imported: ThemeDefinition[];
    if (isPackage) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      signal.throwIfAborted();
      imported = await readThemePackage(bytes, null, signal);
      for (const theme of imported) {
        if (theme.collection) replaceCollectionIds.add(theme.collection.id);
      }
    } else {
      const text = await file.text();
      signal.throwIfAborted();
      imported = importThemeText(text, file.name.replace(/\.jsonc?$/i, ""));
    }
    signal.throwIfAborted();
    themes.push(...imported);
    if (themes.length > MAX_THEMES)
      throw new Error("Import up to 100 themes at a time.");
  }
  return { themes, replaceCollectionIds: [...replaceCollectionIds] };
}

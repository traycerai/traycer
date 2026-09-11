import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { wcagContrast } from "culori";
import { ChevronDown, ChevronUp, Grip, MousePointer2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { readSafeAreaInsets } from "@/lib/safe-area-insets";
import {
  deriveThemeColors,
  normalizeThemeColor,
  themeTokens,
  type ThemeDefinition,
  type ThemeToken,
} from "@/lib/themes/theme-definition";
import { cn } from "@/lib/utils";
import { useThemeLibraryStore } from "@/stores/settings/theme-library-store";
import { ThemeInspector } from "./theme-inspector";

// The recovery controls stay readable even when a draft makes the application's text invisible.
const editorColors: CSSProperties & Record<string, string | number> = {
  colorScheme: "dark",
  color: "#edf0e8",
  background: "#272a25",
  borderColor: "#4a5143",
  "--background": "#272a25",
  "--foreground": "#edf0e8",
  "--popover": "#272a25",
  "--popover-foreground": "#edf0e8",
  "--input": "#707969",
  "--border": "#4a5143",
  "--primary": "#c8dba8",
  "--primary-foreground": "#20251b",
  "--ring": "#c8dba8",
  "--muted-foreground": "#bec6b5",
  "--destructive": "#fda4af",
};

function colorFor(theme: ThemeDefinition, token: ThemeToken): string {
  return (
    normalizeThemeColor(theme.colors[token] ?? "") ??
    normalizeThemeColor(
      getComputedStyle(document.documentElement).getPropertyValue(`--${token}`),
    ) ??
    "#808080ff"
  );
}

function ThemeContrastStatus({ draft }: { draft: ThemeDefinition }) {
  const contrast = wcagContrast(
    colorFor(draft, "background"),
    colorFor(draft, "foreground"),
  );
  const hasTransparency = (["background", "foreground"] as const).some(
    (token) => colorFor(draft, token).slice(7) !== "ff",
  );
  let message = `Main text contrast ${contrast.toFixed(2)}:1. Increase text or background contrast for easier reading.`;
  if (contrast >= 4.5)
    message = `Main text contrast ${contrast.toFixed(2)}:1. Meets the 4.5:1 target for normal text.`;
  if (hasTransparency)
    message =
      "These colors use transparency. Main text contrast depends on the underlying surface.";
  return (
    <p
      role="status"
      className={cn(
        "text-xs leading-relaxed",
        hasTransparency || contrast >= 4.5
          ? "text-[#bec6b5]"
          : "text-amber-200",
      )}
    >
      {message} Only the main text and background colors are checked.
    </p>
  );
}

function ColorField({
  token,
  label,
  color,
  selected,
  onChange,
  onSelect,
}: {
  token: ThemeToken;
  label: string;
  color: string;
  selected: boolean;
  onChange: (token: ThemeToken, value: string) => void;
  onSelect: (token: ThemeToken) => void;
}) {
  const errorId = useId();
  const [input, setInput] = useState({ rendered: color, text: color });
  if (input.rendered !== color) setInput({ rendered: color, text: color });
  const text = input.rendered === color ? input.text : color;
  const invalid = normalizeThemeColor(text) === null;
  return (
    <div
      data-theme-color={token}
      className={cn(
        "grid min-w-0 grid-cols-[minmax(0,1.1fr)_minmax(0,.5fr)_minmax(0,1fr)] items-center gap-2 rounded-md px-1 py-1",
        selected && "bg-[#c8dba8]/8 outline outline-[#c8dba8]/40",
      )}
    >
      <button
        type="button"
        className="text-left text-sm text-[#e0e6d8] hover:text-white focus-visible:outline-2 focus-visible:outline-[#c8dba8]"
        onClick={() => onSelect(token)}
        aria-pressed={selected}
      >
        {label}
      </button>
      <input
        type="color"
        aria-label={`${label} color picker`}
        className="h-7 w-full cursor-pointer overflow-hidden rounded-md border border-white/20 bg-transparent p-0 [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded-md [&::-webkit-color-swatch]:border-0"
        value={color.slice(0, 7)}
        onChange={(event) => onChange(token, event.target.value)}
      />
      <Input
        aria-label={`${label} color value`}
        aria-invalid={invalid}
        aria-describedby={invalid ? errorId : undefined}
        value={text}
        className="h-7 min-w-0 border-white/10 bg-transparent font-mono text-xs"
        onChange={(event) => {
          const value = event.target.value;
          const normalized = normalizeThemeColor(value);
          setInput({ rendered: normalized ?? color, text: value });
          if (normalized) onChange(token, value);
        }}
      />
      {invalid ? (
        <p
          id={errorId}
          role="alert"
          className="col-span-full text-xs text-rose-300"
        >
          Enter a color such as #8AB4F8. This value has not been applied.
        </p>
      ) : null}
    </div>
  );
}

interface Geometry {
  left: number;
  top: number;
  width: number;
  height: number;
}
interface Gesture {
  kind: "move" | "resize";
  x: number;
  y: number;
  geometry: Geometry;
}

function constrain(rect: Geometry): Geometry {
  const insets = readSafeAreaInsets();
  const left = Math.max(16, insets.left);
  const top = Math.max(16, insets.top);
  const availableWidth = Math.max(
    1,
    window.innerWidth - left - Math.max(16, insets.right),
  );
  const availableHeight = Math.max(
    1,
    window.innerHeight - top - Math.max(16, insets.bottom),
  );
  const width = Math.min(
    Math.max(Math.min(280, availableWidth), rect.width),
    availableWidth,
  );
  const height = Math.min(
    Math.max(Math.min(220, availableHeight), rect.height),
    availableHeight,
  );
  return {
    width,
    height,
    left: Math.max(left, Math.min(rect.left, left + availableWidth - width)),
    top: Math.max(top, Math.min(rect.top, top + availableHeight - height)),
  };
}

export function ThemeEditorPanel({ draft }: { draft: ThemeDefinition }) {
  const fieldId = useId();
  const setDraft = useThemeLibraryStore((state) => state.setDraft);
  const cancelDraft = useThemeLibraryStore((state) => state.cancelDraft);
  const error = useThemeLibraryStore((state) => state.error);
  const [advanced, setAdvanced] = useState(false);
  const [query, setQuery] = useState("");
  const [minimized, setMinimized] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [selectedToken, setSelectedToken] = useState<ThemeToken | null>(null);
  const [copiedPair, setCopiedPair] = useState(false);
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  const variants = useRef<Partial<Record<"light" | "dark", ThemeDefinition>>>(
    {},
  );
  const sessionIds = useRef(new Set([draft.id]));
  const panel = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);

  useEffect(() => {
    const element = panel.current;
    if (!element) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || inspecting) return;
      event.stopPropagation();
      if (selectedToken) setSelectedToken(null);
      else cancelDraft();
    };
    element.addEventListener("keydown", handleKey);
    return () => element.removeEventListener("keydown", handleKey);
  }, [cancelDraft, inspecting, selectedToken]);

  useEffect(() => {
    if (sessionIds.current.has(draft.id)) return;
    sessionIds.current = new Set([draft.id]);
    variants.current = {};
    setSelectedToken(null);
    setInspecting(false);
    setCopiedPair(false);
  }, [draft.id]);

  useEffect(() => {
    const restoreFocus = document.activeElement;
    panel.current?.querySelector<HTMLInputElement>("input")?.focus();
    return () => {
      if (restoreFocus instanceof HTMLElement && restoreFocus.isConnected)
        restoreFocus.focus();
    };
  }, []);

  useEffect(() => {
    const resize = () =>
      setGeometry((current) => (current ? constrain(current) : null));
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  const selectToken = useCallback((token: ThemeToken) => {
    setSelectedToken(token);
    setAdvanced(true);
    setQuery("");
    setMinimized(false);
    requestAnimationFrame(() =>
      panel.current
        ?.querySelector(`[data-theme-color="${token}"]`)
        ?.scrollIntoView({ block: "nearest" }),
    );
  }, []);
  const stopInspecting = useCallback(() => setInspecting(false), []);

  const updateColor = (token: ThemeToken, value: string) => {
    const normalized = normalizeThemeColor(value);
    if (!normalized) return;
    const colors =
      !advanced && (token === "background" || token === "primary")
        ? {
            ...draft.colors,
            ...deriveThemeColors(
              token === "background"
                ? normalized
                : colorFor(draft, "background"),
              token === "primary" ? normalized : colorFor(draft, "primary"),
              draft.appearance,
            ),
          }
        : { ...draft.colors, [token]: normalized };
    setDraft({ ...draft, colors });
  };

  const changeAppearance = (appearance: "light" | "dark") => {
    if (appearance === draft.appearance) return;
    const installed = useThemeLibraryStore.getState().themes;
    const siblings = draft.collection
      ? installed.filter(
          (theme) => theme.collection?.id === draft.collection?.id,
        )
      : [];
    const isCustomPair =
      draft.collection?.id.startsWith("custom:") &&
      (["light", "dark"] as const).every(
        (mode) =>
          siblings.filter((theme) => theme.appearance === mode).length <= 1,
      );
    // A package groups independent variants, not necessarily a light/dark pair.
    // Copy this variant before adding an appearance so its source pack is untouched.
    const detached = draft.collection !== undefined && !isCustomPair;
    const current = detached
      ? { ...draft, id: crypto.randomUUID(), collection: undefined }
      : draft;
    if (detached) {
      variants.current = {};
      setCopiedPair(true);
    }
    const collection = current.collection ?? {
      id: `custom:${current.id}`,
      name: current.name,
    };
    variants.current[current.appearance] = { ...current, collection };
    sessionIds.current.add(current.id);
    const opposite =
      variants.current[appearance] ??
      installed.find(
        (theme) =>
          theme.collection?.id === collection.id &&
          theme.appearance === appearance,
      );
    const next: ThemeDefinition = opposite
      ? { ...opposite, name: draft.name, collection }
      : {
          ...current,
          id: `${current.id}-${appearance}`,
          appearance,
          collection,
          colors: deriveThemeColors(
            appearance === "dark" ? "#18181b" : "#fafafa",
            colorFor(draft, "primary"),
            appearance,
          ),
          syntax: null,
        };
    sessionIds.current.add(next.id);
    setDraft(next);
  };

  const startGesture = (
    event: ReactPointerEvent<HTMLElement>,
    kind: "move" | "resize",
  ) => {
    if (event.button !== 0 || !panel.current) return;
    if (
      kind === "move" &&
      event.target instanceof Element &&
      event.target.closest("button, input")
    )
      return;
    const rect = panel.current.getBoundingClientRect();
    gesture.current = {
      kind,
      x: event.clientX,
      y: event.clientY,
      geometry: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: geometry?.height ?? rect.height,
      },
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveGesture = (event: ReactPointerEvent<HTMLElement>) => {
    const start = gesture.current;
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    setGeometry(
      constrain(
        start.kind === "move"
          ? {
              ...start.geometry,
              left: start.geometry.left + dx,
              top: start.geometry.top + dy,
            }
          : {
              ...start.geometry,
              width: start.geometry.width + dx,
              height: start.geometry.height + dy,
            },
      ),
    );
  };
  const endGesture = () => {
    gesture.current = null;
  };
  const groups = [...new Set(themeTokens.map((token) => token.group))];
  const visibleTokens = themeTokens.filter(
    (token) =>
      (advanced || token.key === "background" || token.key === "primary") &&
      `${token.label} ${token.key} ${token.group}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );

  return (
    <>
      <ThemeInspector
        inspecting={inspecting}
        token={selectedToken}
        onSelect={selectToken}
        onStop={stopInspecting}
      />
      <div
        ref={panel}
        data-theme-editor
        role="dialog"
        aria-modal={false}
        aria-label="Theme editor"
        className={cn(
          "fixed right-safe-right-gutter bottom-safe-bottom-gutter z-[110] flex w-[min(90vw,var(--container-sm))] max-w-safe-dvw flex-col overflow-hidden rounded-xl border shadow-xl",
          minimized
            ? "h-auto"
            : "max-h-[min(75svh,calc(var(--spacing-safe-svh)-var(--safe-area-inset-bottom)-2rem))]",
        )}
        style={{
          ...editorColors,
          ...(geometry
            ? {
                ...geometry,
                right: "auto",
                bottom: "auto",
                ...(minimized ? { height: "auto" } : {}),
              }
            : {}),
        }}
      >
        <header
          className="flex shrink-0 touch-none items-center gap-1 border-b border-white/10 px-3 py-2"
          onPointerDown={(event) => startGesture(event, "move")}
          onPointerMove={moveGesture}
          onPointerUp={endGesture}
          onPointerCancel={endGesture}
        >
          <Grip
            className="size-4 shrink-0 cursor-grab text-[#a6b19b]"
            aria-hidden
          />
          <h2 className="min-w-0 flex-1 truncate pl-1 text-sm font-medium">
            Theme editor
          </h2>
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={inspecting}
            onClick={() => {
              setInspecting(!inspecting);
              setSelectedToken(null);
            }}
          >
            <MousePointer2 />
            {inspecting ? "Cancel picking" : "Pick from interface"}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={
              minimized ? "Expand theme editor" : "Minimize theme editor"
            }
            onClick={() => setMinimized(!minimized)}
          >
            {minimized ? <ChevronUp /> : <ChevronDown />}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Cancel theme editing"
            onClick={cancelDraft}
          >
            <X />
          </Button>
        </header>
        {!minimized && (
          <>
            <div className="min-h-0 space-y-3 overflow-y-auto p-3">
              <p className="text-xs leading-relaxed text-[#bec6b5]">
                Changes preview immediately. Save theme keeps and selects your
                changes; Cancel restores your previous theme.
              </p>
              <label
                htmlFor={`${fieldId}-name`}
                className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-center gap-3 text-sm"
              >
                Theme name
                <Input
                  id={`${fieldId}-name`}
                  className="h-8 border-white/15 bg-transparent text-sm"
                  placeholder="e.g. Aurora"
                  maxLength={100}
                  value={draft.name}
                  onChange={(event) =>
                    setDraft({ ...draft, name: event.target.value })
                  }
                />
              </label>
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-center gap-3 text-sm">
                <span>Appearance</span>
                <div
                  role="group"
                  aria-label="Theme appearance"
                  className="grid grid-cols-2 gap-2"
                >
                  {(["light", "dark"] as const).map((appearance) => (
                    <Button
                      key={appearance}
                      variant={
                        draft.appearance === appearance ? "default" : "outline"
                      }
                      size="sm"
                      aria-pressed={draft.appearance === appearance}
                      onClick={() => changeAppearance(appearance)}
                    >
                      {appearance === "light" ? "Light" : "Dark"}
                    </Button>
                  ))}
                </div>
              </div>
              {copiedPair ? (
                <p className="text-xs text-[#bec6b5]">
                  You’re editing a copy with light and dark versions. The
                  imported theme is unchanged.
                </p>
              ) : null}
              <div className="space-y-2">
                <div
                  role="group"
                  aria-label="Color editing mode"
                  className="flex items-center gap-1 border-b border-white/10 pb-2"
                >
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-pressed={!advanced}
                    className={cn(
                      "rounded-md",
                      !advanced && "bg-white/8 text-[#e0eccf]",
                    )}
                    onClick={() => {
                      setAdvanced(false);
                      setQuery("");
                    }}
                  >
                    Basic colors
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-pressed={advanced}
                    className={cn(
                      "rounded-md",
                      advanced && "bg-white/8 text-[#e0eccf]",
                    )}
                    onClick={() => setAdvanced(true)}
                  >
                    All colors
                  </Button>
                </div>
                {!advanced ? (
                  <p className="text-xs leading-relaxed text-[#bec6b5]">
                    Changing either basic color regenerates the other theme
                    colors and replaces individual color edits. Use All colors
                    to edit one color at a time.
                  </p>
                ) : null}
                {advanced ? (
                  <Input
                    aria-label="Filter theme colors"
                    placeholder="Filter colors…"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                ) : null}
              </div>
              {groups.map((group) => {
                const tokens = visibleTokens.filter(
                  (token) => token.group === group,
                );
                return (
                  tokens.length > 0 && (
                    <section key={group} className="space-y-1">
                      {advanced ? (
                        <h3 className="pb-1 text-xs font-medium text-[#a6b19b]">
                          {group}
                        </h3>
                      ) : null}
                      {tokens.map((token) => (
                        <ColorField
                          key={`${draft.appearance}:${token.key}`}
                          token={token.key}
                          label={token.label}
                          color={colorFor(draft, token.key)}
                          selected={selectedToken === token.key}
                          onChange={updateColor}
                          onSelect={(key) =>
                            setSelectedToken(selectedToken === key ? null : key)
                          }
                        />
                      ))}
                    </section>
                  )
                );
              })}
              {visibleTokens.length === 0 && (
                <p className="text-sm text-[#bec6b5]">
                  No colors match your search.
                </p>
              )}
              <label
                htmlFor={`${fieldId}-artwork`}
                className="flex items-center justify-between gap-3 text-sm"
              >
                Show sidebar artwork for this theme
                <Switch
                  id={`${fieldId}-artwork`}
                  checked={draft.sidebarArtwork ?? false}
                  onCheckedChange={(sidebarArtwork) =>
                    setDraft({ ...draft, sidebarArtwork })
                  }
                />
              </label>
              <ThemeContrastStatus draft={draft} />
              {error ? (
                <p role="alert" className="text-sm text-rose-300">
                  {error}
                </p>
              ) : null}
            </div>
            <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-white/10 px-3 py-2 pr-7">
              <Button variant="ghost" size="sm" onClick={cancelDraft}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={!draft.name.trim()}
                onClick={() => {
                  variants.current[draft.appearance] = draft;
                  const themes = Object.values(variants.current).map(
                    (theme) => ({
                      ...theme,
                      name: draft.name.trim(),
                      ...(theme.collection?.id.startsWith("custom:")
                        ? {
                            collection: {
                              ...theme.collection,
                              name: draft.name.trim(),
                            },
                          }
                        : {}),
                    }),
                  );
                  useThemeLibraryStore.getState().saveThemes(themes);
                }}
              >
                Save theme
              </Button>
            </footer>
            <button
              type="button"
              aria-label="Resize theme editor by dragging or using arrow keys"
              className="absolute right-0 bottom-0 flex size-6 touch-none items-end justify-end p-1 text-[#a6b19b] focus-visible:outline-2 focus-visible:outline-[#c8dba8]"
              onPointerDown={(event) => startGesture(event, "resize")}
              onPointerMove={moveGesture}
              onPointerUp={endGesture}
              onPointerCancel={endGesture}
              onKeyDown={(event) => {
                if (!event.key.startsWith("Arrow") || !panel.current) return;
                event.preventDefault();
                const rect = panel.current.getBoundingClientRect();
                setGeometry(
                  constrain({
                    left: rect.left,
                    top: rect.top,
                    width:
                      rect.width +
                      16 *
                        (Number(event.key === "ArrowRight") -
                          Number(event.key === "ArrowLeft")),
                    height:
                      rect.height +
                      16 *
                        (Number(event.key === "ArrowDown") -
                          Number(event.key === "ArrowUp")),
                  }),
                );
              }}
            >
              <Grip className="size-3" />
            </button>
          </>
        )}
      </div>
    </>
  );
}

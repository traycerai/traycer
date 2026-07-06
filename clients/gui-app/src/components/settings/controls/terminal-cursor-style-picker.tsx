import { cn } from "@/lib/utils";
import type { TerminalCursorStyle } from "@/stores/settings/settings-store";

interface TerminalCursorStylePickerProps {
  value: TerminalCursorStyle;
  onChange: (next: TerminalCursorStyle) => void;
}

// iTerm2 shows the cursor shape itself as each choice rather than a word, which
// reads instantly and needs no translation. Each option renders a mini
// terminal cell drawing the actual glyph. Block sits in the middle so the two
// thin shapes flank it symmetrically.
const STYLES: ReadonlyArray<{ id: TerminalCursorStyle; label: string }> = [
  { id: "bar", label: "Bar" },
  { id: "block", label: "Block" },
  { id: "underline", label: "Underline" },
];

// The lit part of the cell; `currentColor` follows the button's text color so
// the active glyph brightens with the surrounding foreground.
const SHAPE_CLASS: Record<TerminalCursorStyle, string> = {
  block: "inset-[2px_1px]",
  bar: "top-[2px] bottom-[2px] left-0 w-[2px]",
  underline: "right-[1px] bottom-[2px] left-0 h-[2px]",
};

export function TerminalCursorStylePicker(
  props: TerminalCursorStylePickerProps,
) {
  const { value, onChange } = props;
  return (
    <div
      aria-label="Terminal cursor style"
      className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/30 p-0.5"
    >
      {STYLES.map((style) => {
        const active = style.id === value;
        return (
          <button
            key={style.id}
            type="button"
            aria-pressed={active}
            aria-label={style.label}
            title={style.label}
            onClick={() => {
              onChange(style.id);
            }}
            className={cn(
              "grid h-8 w-11 place-items-center rounded-sm transition-colors",
              active
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span className="relative block h-5 w-[0.55rem] text-current">
              <span
                aria-hidden="true"
                className={cn(
                  "absolute rounded-[1px] bg-current",
                  SHAPE_CLASS[style.id],
                )}
              />
            </span>
          </button>
        );
      })}
    </div>
  );
}

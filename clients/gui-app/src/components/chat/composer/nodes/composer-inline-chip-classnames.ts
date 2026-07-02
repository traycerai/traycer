import { cn } from "@/lib/utils";

export type ComposerInlineChipDensity = "regular" | "compact";

export interface ComposerInlineChipClassNames {
  readonly root: string;
  readonly icon: string;
  readonly mutedIcon: string;
  readonly text: string;
}

const REGULAR_INLINE_CHIP_CLASS_NAMES: ComposerInlineChipClassNames = {
  root: cn(
    "mx-[1px] inline-flex min-h-[1.55em] max-w-[min(32rem,80vw)] items-center gap-[0.35em] rounded-md border border-border/60 bg-muted/60 px-[0.45em] py-0 align-middle text-[0.85em] font-medium leading-[1.2] shadow-sm whitespace-nowrap select-none",
    "text-foreground/90",
  ),
  icon: "size-[0.95em] shrink-0",
  mutedIcon: "size-[0.95em] shrink-0 text-muted-foreground",
  text: "min-w-0 truncate",
};

const COMPACT_INLINE_CHIP_CLASS_NAMES: ComposerInlineChipClassNames = {
  root: cn(
    "mx-[1px] inline-flex min-h-[1.35em] max-w-full items-center gap-[0.28em] rounded border border-border/50 bg-muted/50 px-[0.35em] py-0 align-middle text-[0.9em] font-medium leading-[1.1] whitespace-nowrap select-none",
    "text-foreground/90",
  ),
  icon: "size-[0.9em] shrink-0",
  mutedIcon: "size-[0.9em] shrink-0 text-muted-foreground",
  text: "min-w-0 truncate",
};

export function composerInlineChipClassNames(
  density: ComposerInlineChipDensity,
): ComposerInlineChipClassNames {
  if (density === "compact") return COMPACT_INLINE_CHIP_CLASS_NAMES;
  return REGULAR_INLINE_CHIP_CLASS_NAMES;
}

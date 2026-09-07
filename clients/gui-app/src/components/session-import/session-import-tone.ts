/** One colour bundle for onboarding and the Settings dialog. */
export type SessionImportSurface = "onboarding" | "dialog";

export interface SessionImportTone {
  readonly surface: SessionImportSurface;
  readonly strong: string;
  readonly muted: string;
  readonly faint: string;
  readonly border: string;
  readonly rowHover: string;
  readonly groupSurface: string;
  readonly warningSurface: string;
  readonly pillOn: string;
  readonly pillOff: string;
  readonly checkboxFilled: string;
}

const THEME_COLOURS = {
  strong: "text-foreground",
  muted: "text-muted-foreground",
  faint: "text-muted-foreground/70",
  border: "border-border/60",
  rowHover: "hover:bg-foreground/6",
  groupSurface: "bg-foreground/[0.04]",
  warningSurface:
    "bg-amber-500/10 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300",
  pillOn: "border-transparent bg-foreground/10 text-foreground",
  pillOff:
    "border-border/60 text-muted-foreground/70 hover:bg-foreground/6 hover:text-muted-foreground",
  checkboxFilled: "border-primary bg-primary text-primary-foreground",
} as const;

export function sessionImportTone(
  surface: SessionImportSurface,
): SessionImportTone {
  return { surface, ...THEME_COLOURS };
}

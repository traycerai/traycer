/**
 * The wizard is one component on two surfaces: the welcome modal's sessions
 * page and a Settings dialog.
 *
 * Both grounds are the user's own theme, so there is one colour bundle rather
 * than one per surface, and the copy no longer differs by surface either -
 * both sit over the real app, where the task list is a click away. The
 * surface is still carried: it names where the wizard was met, for analytics
 * and for the next surface whose copy does differ.
 *
 * The colours deliberately avoid `bg-muted` fills: on a raised surface
 * `--muted` collapses into the surface in every preset theme's dark variant
 * (see gui-app AGENTS.md), so tints are alphas of the foreground, which cannot
 * collapse.
 */
export type SessionImportSurface = "welcome-modal" | "dialog";

export interface SessionImportTone {
  /** The ground this bundle was built for; drives copy, not colour. */
  readonly surface: SessionImportSurface;
  /** Row and header titles. */
  readonly strong: string;
  /** Secondary metadata: counts, dates, paths. */
  readonly muted: string;
  /** Tertiary: disabled rows, hints. */
  readonly faint: string;
  readonly border: string;
  readonly rowHover: string;
  /** The collapsed group header's own fill. */
  readonly groupSurface: string;
  readonly warningSurface: string;
  /** A provider pill whose work is in scope, and one switched out of it. */
  readonly pillOn: string;
  readonly pillOff: string;
  /** The ticked/indeterminate checkbox fill. */
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

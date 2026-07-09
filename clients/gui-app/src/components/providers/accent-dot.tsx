import { resolveProfileAccentColor } from "@/lib/providers/profile-accent-color";
import { cn } from "@/lib/utils";

interface AccentDotProps {
  readonly profileId: string;
  readonly accentColor: string | null;
  readonly label: string | null;
  /** `corner` floats bottom-right over a relatively-positioned provider icon
   *  (the picker rail); `inline` sits in normal flow next to a label (the
   *  profile dropdown's trigger and rows). */
  readonly variant: "corner" | "inline";
  readonly size: "compact" | "default";
  readonly className: string | undefined;
}

/**
 * Deterministic profile-identity dot (multi-profile decision log): a
 * bottom-right corner badge on the rail's provider icon, or an inline swatch
 * next to the profile dropdown's trigger/row label. Both variants resolve the
 * same accent color (`resolveProfileAccentColor`) - the dot signals PRESENCE
 * of 2+ profiles, never the sole identity signal; callers must always pair it
 * with a visible or accessible name.
 */
export function AccentDot(props: AccentDotProps) {
  const { profileId, accentColor, label, variant, size, className } = props;
  const color = resolveProfileAccentColor(profileId, accentColor);
  const initial = variant === "corner" ? profileInitial(label) : null;
  return (
    <span
      aria-hidden="true"
      style={{ backgroundColor: color }}
      className={cn(
        "shrink-0 rounded-full text-[0.5rem] leading-none font-semibold text-black",
        cornerDotClassName(variant, size),
        className,
      )}
    >
      {initial}
    </span>
  );
}

function cornerDotClassName(
  variant: AccentDotProps["variant"],
  size: AccentDotProps["size"],
): string {
  if (variant === "inline") return "size-2";
  if (size === "compact") {
    return "absolute -bottom-0.5 -right-0.5 flex size-3 items-center justify-center text-[0.45rem] ring-1 ring-background";
  }
  return "absolute -bottom-1 -right-1 flex size-3.5 items-center justify-center ring-2 ring-background";
}

function profileInitial(label: string | null): string | null {
  const trimmed = label?.trim() ?? "";
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, 1).toLocaleUpperCase();
}

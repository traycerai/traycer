import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { BrandEntrance } from "@/components/auth/brand-entrance";
import { cn } from "@/lib/utils";
import "@/styles/auth-arrival.css";

/**
 * How long the splash covers the sign-in page, fade included.
 *
 * One number, and every variant's CSS is authored to it: the mark's motion
 * fills the whole span, the layer fades over the last 240ms, and this timeout
 * unmounts it exactly as the fade lands. Raised from 2500ms after the first
 * pass was reported as "hardly visible so fast".
 */
export const AUTH_SPLASH_MS = 3500;

/**
 * The motion the mark performs. Three of them exist because the first attempt
 * was reported as "hardly visible so fast" - the animation finished inside a
 * second and the rest of the surface was a freeze - so each of these is
 * authored to FILL {@link AUTH_SPLASH_MS} rather than to finish early and wait.
 */
export type AuthSplashVariant = "draw" | "assemble" | "scale";

/**
 * The one that ships. The others stay implemented because they are three CSS
 * rule blocks against the same component, and keeping them costs nothing while
 * the choice is open.
 */
export const AUTH_SPLASH_DEFAULT_VARIANT: AuthSplashVariant = "assemble";

/**
 * The brand animation a signed-out launch opens on, over the sign-in page.
 *
 * Deliberately the simplest thing that does the job: one boolean, set once by
 * one timeout. There is no phase machine, no clock read at render, and nothing
 * derived from other flags - an earlier version had all three, and the React
 * Compiler memoized its derived phase past the timer that was supposed to end
 * it, which shipped a launch screen that never left. A single boolean cannot
 * fail that way, because there is nothing to derive it from.
 *
 * The crossfade and the pass-through are done by the KEYFRAMES rather than by
 * more state: `auth-splash-play` holds opacity, then fades, and flips
 * `pointer-events` to `none` at the moment the fade starts. So the layer
 * swallows taps while it is opaque - a tap there would hit a control the user
 * cannot see - and stops swallowing them the instant the page beneath becomes
 * visible.
 *
 * NOT a second full-bleed surface. It is `absolute inset-0` inside the sign-in
 * page's `<main>`, which already sits in the app's one sanctioned `fixed
 * inset-0` shell, and its content layer takes the safe-area insets like every
 * other content layer in there.
 */
const VARIANT_CLASS: Record<AuthSplashVariant, string> = {
  draw: "auth-splash--draw",
  assemble: "auth-splash--assemble",
  scale: "auth-splash--scale",
};

export function AuthBrandSplash(props: {
  readonly variant: AuthSplashVariant;
}): ReactNode {
  // Read once, plainly, at mount. A surface this brief has no reason to track
  // a preference change mid-flight, and reading it here keeps it out of render.
  const [done, setDone] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    if (done) return;
    const timer = setTimeout(() => setDone(true), AUTH_SPLASH_MS);
    return () => clearTimeout(timer);
  }, [done]);

  if (done) return null;

  return (
    <div
      data-testid="auth-brand-splash"
      aria-hidden="true"
      data-variant={props.variant}
      className={cn(
        "auth-splash absolute inset-0 z-20 flex items-center justify-center bg-zinc-950 pt-safe-top pr-safe-right pb-safe-bottom pl-safe-left",
        VARIANT_CLASS[props.variant],
      )}
    >
      <BrandEntrance size="hero">{null}</BrandEntrance>
    </div>
  );
}

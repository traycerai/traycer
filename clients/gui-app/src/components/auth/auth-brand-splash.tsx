import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { BrandEntrance } from "@/components/auth/brand-entrance";
import { BRAND_DARK_GROUND_CLASS } from "@/components/auth/brand-surface";
import { cn } from "@/lib/utils";
import "@/styles/auth-arrival.css";

/**
 * How long the splash covers the sign-in page, fade included.
 *
 * ONE number, and the keyframes are authored to it: the pieces are still
 * arriving until 2000ms, the fade begins the instant the last one lands, and
 * this timeout unmounts the layer exactly as the fade finishes. There is no
 * still frame anywhere in it - an assembled mark holding on screen is a pause
 * the viewer reads as the app having stopped. Changing the span means changing
 * the keyframes with it.
 */
export const AUTH_SPLASH_MS = 2240;

/**
 * The brand animation a signed-out launch opens on, over the sign-in page.
 *
 * ONE BOOLEAN, set once by one timeout, and that is a constraint rather than a
 * convenience: this component is compiled by the React Compiler, which
 * memoizes a derived value on the things it is derived FROM. A phase computed
 * from other flags can therefore be cached past the timer meant to retire it,
 * and the surface never leaves. A boolean written directly by the timeout has
 * nothing to derive it from and cannot be cached past its own write.
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
export function AuthBrandSplash(): ReactNode {
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
      className={cn(
        "auth-splash absolute inset-0 z-20 flex items-center justify-center pt-safe-top pr-safe-right pb-safe-bottom pl-safe-left",
        BRAND_DARK_GROUND_CLASS,
      )}
    >
      <BrandEntrance size="hero">{null}</BrandEntrance>
    </div>
  );
}

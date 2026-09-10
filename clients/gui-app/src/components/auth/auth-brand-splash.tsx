import type { ReactNode } from "react";
import { BrandEntrance } from "@/components/auth/brand-entrance";
import { BRAND_DARK_GROUND_CLASS } from "@/components/auth/brand-surface";
import { cn } from "@/lib/utils";
import "@/styles/auth-arrival.css";

/**
 * The brand animation a signed-out launch opens on, over the sign-in page.
 *
 * The crossfade and the pass-through are done by the KEYFRAMES rather than by
 * state: `auth-splash-play` holds opacity, then fades, and flips
 * `pointer-events` to `none` at the frame the fade starts. So the layer
 * swallows taps while it is opaque - a tap there would hit a control the user
 * cannot see - and stops swallowing them the instant the page beneath becomes
 * visible. Keyboard reach is the page's half of that, through `inert`.
 *
 * NOT a second full-bleed surface. It is `absolute inset-0` inside the sign-in
 * page's `<main>`, which already sits in the app's one sanctioned `fixed
 * inset-0` shell, and it takes the safe-area insets like every other content
 * layer in there.
 *
 * How long it stays, and which launches get it, belong to
 * `useAuthSplashCover` - this draws what it is told to draw.
 */
export function AuthBrandSplash(): ReactNode {
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

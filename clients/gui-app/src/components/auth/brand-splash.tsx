import type { ReactNode } from "react";
import { BrandEntrance } from "@/components/auth/brand-entrance";
import { cn } from "@/lib/utils";
import "@/styles/auth-arrival.css";

/**
 * The signed-out launch surface: the mark assembling on the same dark ground
 * the sign-in page uses, so the two read as one continuous screen and the
 * crossfade has nothing to travel over.
 *
 * No wordmark and no copy. The mark is the whole message, and a launch screen
 * that also spells the product name is the thing that made the sign-in heading
 * read as shouting.
 *
 * `aria-hidden`, because everything this surface conveys is decorative and the
 * real content is already mounted underneath it.
 *
 * How long it stays, and which launches get it at all, belong to
 * `useBrandSplashHold` - this component only draws a phase it is handed.
 */
export function BrandSplash(props: { readonly exiting: boolean }): ReactNode {
  return (
    <div
      data-testid="brand-splash"
      aria-hidden="true"
      className={cn(
        "absolute inset-0 z-20 flex items-center justify-center bg-zinc-950",
        props.exiting && "brand-splash-exit",
      )}
    >
      <div className="brand-splash-mark">
        <BrandEntrance size="hero">{null}</BrandEntrance>
      </div>
    </div>
  );
}

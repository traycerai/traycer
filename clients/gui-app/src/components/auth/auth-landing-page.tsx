import { BrandEntrance } from "@/components/auth/brand-entrance";
import { PhotoBloom } from "@/components/auth/cinematic-backdrop";
import { SignInButton } from "@/components/layout/header/sign-in-button";
import { getClientAppVersionLabel } from "@/lib/app-version";
import type { ShellAdmissionRefusal } from "@/hooks/auth/use-shell-local-plane-admission";
import { cn } from "@/lib/utils";

const SIGN_IN_COLOR_VARS =
  "[--primary:#f8f7f2] [--primary-foreground:#050505] [--ring:#f8f7f2]";
const SIGN_IN_LANE_CLASS =
  "w-[min(100%,31rem)] pt-[clamp(0.35rem,1.2vh,0.8rem)]";

/**
 * The sentence for a session the STATUS would have admitted and the SHELL
 * could not - one per refusal reason, keyed by the reason.
 *
 * Three things each sentence has to do, and the order is the reading order: name
 * what is wrong with the session (the sign-in is unconfirmed, not rejected), say
 * why that is fatal HERE and not on a laptop (nothing on this device to fall back
 * to), and leave the user with the one action that helps. It deliberately does
 * NOT claim the account is signed out - it is not - nor that the network is
 * down, which may be perfectly false.
 *
 * A `Record` over the union rather than a `switch`, and for the same purpose the
 * switch had: `Record<ShellAdmissionRefusal, string>` is exhaustive BY TYPE, so
 * adding a refusal reason fails to compile here until someone writes its
 * sentence - which is the whole reason the reason is a union rather than a
 * boolean. The switch expressed that too, but while the union has exactly one
 * member its single `case` compares two identical literal types, which
 * `no-unnecessary-condition` reports; a mapped type has no comparison in it to be
 * unnecessary, and keeps the guarantee at one member or ten.
 */
const REFUSAL_MESSAGES: Record<ShellAdmissionRefusal, string> = {
  "unverified-relay-only":
    "Your sign-in couldn't be confirmed, and this device has no Traycer host of its own — everything here is served from another device over the network. Sign in again to reconnect.",
};

function refusalMessage(refusal: ShellAdmissionRefusal): string {
  return REFUSAL_MESSAGES[refusal];
}

export function AuthLandingPage(props: {
  /**
   * Why an otherwise-admitted session is on this surface, or `null` for the
   * ordinary signed-out arrival. Required so a caller has to answer the
   * question rather than inherit a silent default.
   */
  readonly refusal: ShellAdmissionRefusal | null;
}) {
  return (
    // min-h-full, not min-h-svh: the standalone shell owns the viewport
    // height and reserves the Windows title-bar band above this page.
    <main className="relative isolate flex min-h-full flex-1 overflow-hidden bg-zinc-950 text-white">
      <div className="auth-arrival-backdrop pointer-events-none absolute inset-0">
        <PhotoBloom />
      </div>

      {/* The content layer of a full-bleed surface: the backdrop above is
          meant to run under the status bar and the sensor housing, and this is
          not. Each edge takes its own gutter or the device inset, whichever is
          larger - `max()` rather than a sum, so a device with no inset renders
          the layout unchanged. Stated per edge rather than left to the gutters
          being generous enough: they are today, by margins small enough that
          retuning one would silently put the sign-in control under the
          housing. */}
      <section className="relative z-10 mx-auto flex w-full flex-col items-center justify-center pt-[max(clamp(4rem,12vh,8rem),var(--safe-area-inset-top))] pr-[max(clamp(1.5rem,5vw,4.5rem),var(--safe-area-inset-right))] pb-[clamp(5rem,12vh,8rem)] pl-[max(clamp(1.5rem,5vw,4.5rem),var(--safe-area-inset-left))] text-center font-heading">
        <div className="flex w-full max-w-[min(88vw,31rem)] flex-col items-center gap-[clamp(1.2rem,2.8vh,2rem)]">
          <BrandEntrance size="hero">
            <h1 className="brand-entrance-copy mb-2 text-[clamp(2rem,5vw,2.75rem)] font-semibold leading-[clamp(2.25rem,5.5vw,3rem)] tracking-tight">
              Welcome to Traycer
            </h1>
          </BrandEntrance>
          {/* Above the button, not below it: this is the reason the button is
              being shown at all, and a reader who has already pressed it has
              no use for the explanation. Sized as body copy on the artwork's
              own scale rather than as an alert - the session is intact and
              nothing here is an error state. */}
          {props.refusal === null ? null : (
            <p
              data-testid="auth-landing-refusal"
              className="max-w-[min(88vw,28rem)] text-balance text-ui-sm leading-relaxed font-sans text-white/70"
            >
              {refusalMessage(props.refusal)}
            </p>
          )}
          <div
            className={cn(
              "auth-arrival-actions",
              SIGN_IN_COLOR_VARS,
              SIGN_IN_LANE_CLASS,
            )}
          >
            <SignInButton layout="hero" />
          </div>
        </div>
      </section>

      {/* Pinned to the corner the home indicator shares, and in landscape the
          corner a right-side sensor housing shares too. */}
      <footer className="pointer-events-none absolute right-0 bottom-0 z-10 flex items-center justify-end px-[clamp(1.25rem,4vw,4rem)] pr-[max(clamp(1.25rem,4vw,4rem),var(--safe-area-inset-right))] pb-[max(clamp(1rem,3vh,2rem),var(--safe-area-inset-bottom))] font-mono text-overline text-white/[0.42]">
        <span>{getClientAppVersionLabel()}</span>
      </footer>
    </main>
  );
}

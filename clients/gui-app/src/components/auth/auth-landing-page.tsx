import "@/styles/auth-arrival.css";
import { BrandMark, PhotoBloom } from "@/components/auth/cinematic-backdrop";
import { SignInButton } from "@/components/layout/header/sign-in-button";
import { getClientAppVersionLabel } from "@/lib/app-version";
import { cn } from "@/lib/utils";

const SIGN_IN_COLOR_VARS =
  "[--primary:#f8f7f2] [--primary-foreground:#050505] [--ring:#f8f7f2]";
const SIGN_IN_LANE_CLASS =
  "w-[min(100%,31rem)] pt-[clamp(0.35rem,1.2vh,0.8rem)]";

export function AuthLandingPage() {
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
          <BrandMark className="auth-arrival-mark h-auto w-[clamp(4.5rem,18vw,6.5rem)] drop-shadow-[0_1.5rem_2.5rem_rgba(0,0,0,0.42)]" />
          <div className="auth-arrival-copy flex flex-col items-center gap-5">
            <h1 className="flex flex-col items-center gap-2 font-medium">
              <span className="text-ui text-white/65">Welcome to</span>
              <span className="text-[clamp(3.5rem,14vw,5rem)] leading-none tracking-[-0.055em]">
                traycer
              </span>
            </h1>
            <p className="text-ui text-white/65">Pick up where you left off.</p>
          </div>
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

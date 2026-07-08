import { BrandMark, PhotoBloom } from "@/components/auth/cinematic-backdrop";
import { SignInButton } from "@/components/layout/header/sign-in-button";
import { cn } from "@/lib/utils";

const SIGN_IN_COLOR_VARS =
  "[--primary:#f8f7f2] [--primary-foreground:#050505] [--ring:#f8f7f2]";
const SIGN_IN_LANE_CLASS =
  "w-[min(100%,31rem)] pt-[clamp(0.35rem,1.2vh,0.8rem)]";

/**
 * Reads the build-time app version injected by Vite as `VITE_APP_VERSION`.
 * Shells that don't define the variable fall back to an empty label so the
 * footer renders without a stale hardcoded version string.
 */
function resolveAppVersionLabel(): string {
  const raw = import.meta.env.VITE_APP_VERSION;
  if (typeof raw !== "string" || raw.length === 0) return "";
  return raw.startsWith("v") ? raw : `v${raw}`;
}

export function AuthLandingPage() {
  return (
    <main className="relative isolate flex min-h-svh flex-1 overflow-hidden bg-zinc-950 text-white">
      <PhotoBloom />

      <section className="relative z-10 mx-auto flex w-full flex-col items-center justify-center px-[clamp(1.5rem,5vw,4.5rem)] pb-[clamp(5rem,12vh,8rem)] pt-[clamp(4rem,12vh,8rem)] text-center font-heading">
        <div className="flex w-full max-w-[min(88vw,31rem)] flex-col items-center gap-[clamp(1.2rem,2.8vh,2rem)]">
          <BrandMark className="h-auto w-[clamp(3.75rem,8vw,5.4rem)] drop-shadow-[0_1.5rem_2.5rem_rgba(0,0,0,0.42)]" />
          <h1 className="mb-2 text-[clamp(2rem,5vw,2.75rem)] font-semibold leading-[clamp(2.25rem,5.5vw,3rem)] tracking-tight">
            Welcome to Traycer
          </h1>
          <div className={cn(SIGN_IN_COLOR_VARS, SIGN_IN_LANE_CLASS)}>
            <SignInButton layout="hero" />
          </div>
        </div>
      </section>

      <footer className="pointer-events-none absolute right-0 bottom-0 z-10 flex items-center justify-end px-[clamp(1.25rem,4vw,4rem)] pb-[clamp(1rem,3vh,2rem)] font-mono text-overline text-white/[0.42]">
        <span>{resolveAppVersionLabel()}</span>
      </footer>
    </main>
  );
}

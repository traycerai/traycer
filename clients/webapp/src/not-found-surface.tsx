import type { ReactNode } from "react";
import {
  TRAYCER_MARK_PATH_D,
  TRAYCER_MARK_VIEWBOX,
} from "@/lib/brand/traycer-mark";

export interface NotFoundSurfaceProps {
  /** Where this shell's app root lives, prefix included. */
  readonly homeHref: string;
}

/**
 * What a browser tab shows for a URL that matches no route.
 *
 * A shell with an address bar can be sent anywhere, and the router library's
 * own fallback is two words with nothing to click. That is survivable while
 * the app chrome is around it and a dead end without: a visitor who is signed
 * out has no chrome, so a mistyped or stale link leaves them on a page with no
 * way forward and no way to sign in - the app is reachable, and they cannot
 * tell.
 *
 * The single action is deliberately the app root rather than a sign-in button.
 * The root already IS the sign-in surface while signed out, and is the app
 * while signed in, so one link is correct for both - where a sign-in button
 * would be a lie to anyone who already has a session and simply mistyped a
 * path. It is a plain document link, not a client-side navigation: this
 * surface is a dead end by definition, and a real load re-runs the shell's
 * whole boot, which is the most complete recovery available from here.
 */
export function NotFoundSurface(props: NotFoundSurfaceProps): ReactNode {
  return (
    <div className="flex min-h-safe-svh w-full flex-col items-center justify-center gap-5 px-6 py-12 text-center">
      <svg
        viewBox={TRAYCER_MARK_VIEWBOX}
        aria-hidden="true"
        className="size-8 fill-foreground/80"
      >
        <path d={TRAYCER_MARK_PATH_D} />
      </svg>
      <div className="flex w-full max-w-sm flex-col gap-2">
        <h1 className="text-lg font-semibold text-foreground">
          This page does not exist
        </h1>
        <p className="text-sm text-muted-foreground">
          The address you opened is not part of Traycer. Everything else,
          including signing in, is where it always was.
        </p>
      </div>
      <a
        href={props.homeHref}
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
      >
        Go to Traycer
      </a>
    </div>
  );
}

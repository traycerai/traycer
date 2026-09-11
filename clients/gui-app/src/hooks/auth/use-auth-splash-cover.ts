import { useEffect, useState } from "react";

/**
 * How long the splash covers the sign-in page, fade included.
 *
 * ONE number, and the keyframes are authored to it: the pieces are still
 * arriving until 2000ms, the fade begins the instant the last one lands, and
 * the timeout below releases the cover exactly as the fade finishes. There is
 * no still frame anywhere in it - an assembled mark holding on screen is a
 * pause the viewer reads as the app having stopped. Changing the span means
 * changing the keyframes with it.
 */
export const AUTH_SPLASH_MS = 2240;

/**
 * Whether the splash is still covering the sign-in page.
 *
 * ONE BOOLEAN, set once by one timeout, and that is a constraint rather than a
 * convenience: the surfaces that read this are compiled by the React Compiler,
 * which memoizes a derived value on the things it is derived FROM. A phase
 * computed from other flags can therefore be cached past the timer meant to
 * retire it, and the cover never leaves. A boolean written directly by the
 * timeout has nothing to derive it from and cannot be cached past its own
 * write.
 *
 * The page reads it for two things - drawing the layer, and holding the
 * controls underneath out of the focus order - and one owner is what keeps
 * those two from disagreeing.
 */
export function useAuthSplashCover(): boolean {
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

  return !done;
}

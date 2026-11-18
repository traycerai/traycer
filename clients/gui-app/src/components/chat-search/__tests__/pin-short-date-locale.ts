import { afterAll, beforeAll, vi } from "vitest";

/**
 * Pins the locale the short-date assertions in this directory are written in.
 *
 * The app formats dates locale-AWARE on purpose: `formatShortDate` in
 * `lib/relative-time.ts` and the hit row's own `toLocaleDateString` both pass
 * `undefined`, so a user reads their own conventions. That makes the rendered
 * string a fact about the MACHINE - these suites' expected "Sep 8" is "8 Sept"
 * on an `en-IN` runner - while the behaviour under test is which row is
 * grouped, focused and opened, not how a date reads.
 *
 * Pinned here rather than through an `LC_ALL` in a package script: ICU reads
 * the environment once at startup, so a script-level variable would make these
 * suites correct only when launched through that script, and a single file run
 * from an editor would answer differently from CI. Only the DEFAULT is
 * replaced; a call site that names a locale still gets the one it named.
 */
export function pinShortDateLocale(): void {
  let restore: (() => void) | null = null;
  beforeAll(() => {
    // Formatted through `Intl.DateTimeFormat` rather than by delegating to the
    // captured original, which the method's own specification says is the same
    // thing - and which keeps this from holding an unbound method reference.
    const spy = vi
      .spyOn(Date.prototype, "toLocaleDateString")
      .mockImplementation(function (
        this: Date,
        locales: Intl.LocalesArgument,
        options: Intl.DateTimeFormatOptions | undefined,
      ): string {
        return new Intl.DateTimeFormat(locales ?? "en-US", options).format(
          this,
        );
      });
    restore = () => {
      spy.mockRestore();
    };
  });
  afterAll(() => {
    restore?.();
    restore = null;
  });
}

import { describe, expect, it } from "vitest";
import { createAppRouter } from "@/router";

describe("createAppRouter", () => {
  it("boots from the desktop initial route without relying on the URL hash", () => {
    const router = createAppRouter("/epics/epic-a", null, null, null);

    expect(router.state.location.pathname).toBe("/epics/epic-a");
  });

  it("parses a served-under prefix off the URL and leaves the route id alone", () => {
    // The whole point of the argument: the prefix is a fact about how the
    // bundle is SERVED, so it belongs to the URL and to nothing downstream.
    // A route guard reading `/epics/epic-a` must keep reading that.
    const router = createAppRouter("/app/epics/epic-a", null, "/app", null);

    expect(router.basepath).toBe("/app");
    expect(router.state.location.pathname).toBe("/epics/epic-a");
  });

  it("owns the root when no prefix is passed", () => {
    // The discriminating half: with the same URL and no prefix, the segment
    // stays in the route - so the case above is measuring the prefix rather
    // than a normalization that would happen anyway.
    const router = createAppRouter("/app/epics/epic-a", null, null, null);

    expect(router.state.location.pathname).toBe("/app/epics/epic-a");
  });

  it("installs the shell's not-found component as the router-wide fallback", () => {
    const notFound = (): null => null;

    const router = createAppRouter(null, null, null, notFound);

    expect(router.options.defaultNotFoundComponent).toBe(notFound);
  });

  it("leaves the library's own fallback in place when the shell supplies none", () => {
    // `null` has to OMIT the option, not pass `undefined` through it: a shell
    // with no address bar keeps router-core's default, and an explicitly
    // undefined key is a different thing from an absent one to any later
    // reader that merges options.
    const router = createAppRouter(null, null, null, null);

    expect("defaultNotFoundComponent" in router.options).toBe(false);
  });
});

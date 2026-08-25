/**
 * `/settings/keybindings` keeps its route on every build, because a URL
 * outlives the build that produced it - a bookmark, a remembered tab path, or
 * a settings entry point handed a stored section id all navigate here. Where
 * the section is not offered, the route lands on General instead of rendering
 * a panel the navigation beside it has no row for.
 */
import { afterEach, describe, expect, it } from "vitest";
import { isRedirect } from "@tanstack/react-router";
import { setMobileApp } from "@/lib/mobile-app";
import { Route as KeybindingsRoute } from "@/routes/settings.keybindings";

afterEach(() => {
  setMobileApp(false);
});

// TanStack Router's `beforeLoad` signature is parameterized on the full
// file-route context, but this redirect reads none of those args. A permissive
// sentinel keeps the test decoupled from that type.
function runBeforeLoad(): unknown {
  const beforeLoad = KeybindingsRoute.options.beforeLoad;
  expect(beforeLoad).toBeTypeOf("function");
  const invoke = beforeLoad as (args: { context: object }) => void;
  try {
    invoke({ context: {} });
  } catch (err) {
    return err;
  }
  return null;
}

describe("/settings/keybindings route", () => {
  it("renders the panel on builds that offer the section", () => {
    setMobileApp(false);
    expect(KeybindingsRoute.options.component).toBeDefined();
    expect(runBeforeLoad()).toBeNull();
  });

  it("redirects to /settings/general in the installed mobile app", () => {
    setMobileApp(true);
    const thrown = runBeforeLoad();
    expect(isRedirect(thrown)).toBe(true);
    const response = thrown as Response & {
      options: { to: string; replace: boolean };
    };
    expect(response.options.to).toBe("/settings/general");
    // `replace`, so Back leaves Settings rather than bouncing off this route
    // into General again.
    expect(response.options.replace).toBe(true);
  });
});

/**
 * Locks down the legacy `/settings/service` route to redirect into the
 * native-packaging Host pane. The Settings sidebar no longer surfaces
 * the old Service entry, but persisted bookmarks, remembered tab paths,
 * and tray commands may still navigate there - the redirect makes that
 * land on the same surface as the primary sidebar entry.
 */
import { describe, expect, it } from "vitest";
import { isRedirect } from "@tanstack/react-router";
import { Route as ServiceRoute } from "@/routes/settings.service";

describe("legacy /settings/service route", () => {
  it("has no component (the legacy ServiceSettingsPanel is removed)", () => {
    expect(ServiceRoute.options.component).toBeUndefined();
  });

  it("beforeLoad throws a redirect to /settings/host", () => {
    const beforeLoad = ServiceRoute.options.beforeLoad;
    expect(beforeLoad).toBeTypeOf("function");
    let thrown: unknown = null;
    try {
      // TanStack Router's `beforeLoad` signature is parameterized on
      // the full file-route context, but our redirect implementation
      // reads none of those args. Pass a permissive sentinel so the
      // test stays decoupled from that type.
      const invoke = beforeLoad as (args: { context: object }) => void;
      invoke({ context: {} });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).not.toBeNull();
    expect(isRedirect(thrown)).toBe(true);
    const response = thrown as Response & {
      options: { to: string; replace: boolean };
    };
    expect(response.options.to).toBe("/settings/host");
    expect(response.options.replace).toBe(true);
  });
});

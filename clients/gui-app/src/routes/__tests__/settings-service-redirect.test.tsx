/** Legacy /settings/service redirects to the Host pane so bookmarks still land on the sidebar's primary surface. */
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
      // Permissive sentinel: this beforeLoad reads none of the file-route
      // context.
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

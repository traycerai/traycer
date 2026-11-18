/**
 * `/settings/app-diagnostics` keeps its route on every build. The installed
 * mobile app drops the section from the offered list, but unlike Keybindings
 * this route has no `beforeLoad` redirect: a direct link still renders the
 * panel, which says the controls live on the desktop app.
 */
import { describe, expect, it } from "vitest";
import { Route } from "@/routes/settings.app-diagnostics";

describe("/settings/app-diagnostics route", () => {
  it("does not redirect", () => {
    expect(Route.options.beforeLoad).toBeUndefined();
  });
});

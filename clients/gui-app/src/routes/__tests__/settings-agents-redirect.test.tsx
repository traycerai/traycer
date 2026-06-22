import { describe, expect, it } from "vitest";
import { isRedirect } from "@tanstack/react-router";
import { Route as AgentsRoute } from "@/routes/settings.agents";

describe("legacy /settings/agents route", () => {
  it("has no component because agent guidance now lives under Providers", () => {
    expect(AgentsRoute.options.component).toBeUndefined();
  });

  it("beforeLoad throws a redirect to /settings/providers", () => {
    const beforeLoad = AgentsRoute.options.beforeLoad;
    expect(beforeLoad).toBeTypeOf("function");
    let thrown: unknown = null;
    try {
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
    expect(response.options.to).toBe("/settings/providers");
    expect(response.options.replace).toBe(true);
  });
});

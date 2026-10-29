/**
 * The pages of the features the build without them does not ship keep their
 * routes, because a URL outlives the build that produced it: a bookmark or a
 * remembered tab path still navigates there. Each lands on Settings instead
 * of mounting a panel the navigation has no row for, and no entry point of
 * the page (a billing action, a cloud page frame) is reachable through it.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { Route as CreditsRoute } from "@/routes/settings.credits";
import { Route as McpServersRoute } from "@/routes/settings.mcp-servers";
import { Route as SkillsRoute } from "@/routes/settings.skills";
import { Route as SandboxesRoute } from "@/routes/settings.sandboxes";
import { Route as MembersRoute } from "@/routes/settings.members";
import { Route as SecretsRoute } from "@/routes/settings.secrets";
import { Route as MachineSetupRoute } from "@/routes/settings.machine-setup";

vi.mock("@/unreleased-features", () => ({
  UNRELEASED_FEATURES_ENABLED: false,
}));

type BeforeLoad = (args: { context: object }) => void;

const GUARDED = [
  ["/settings/credits", CreditsRoute],
  ["/settings/mcp-servers", McpServersRoute],
  ["/settings/skills", SkillsRoute],
  ["/settings/sandboxes", SandboxesRoute],
  ["/settings/members", MembersRoute],
  ["/settings/secrets", SecretsRoute],
  ["/settings/machine-setup", MachineSetupRoute],
] as const;

// The routes' own `beforeLoad`s, mounted into a throwaway route tree rather
// than invoked directly, so that matching, redirect handling and history
// replacement all run (the same arrangement as the link-phone suite).
function buildRouter(initialPath: string) {
  const rootRoute = createRootRoute();
  const guarded = GUARDED.map(([path, route]) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path,
      beforeLoad: () =>
        (route.options.beforeLoad as BeforeLoad)({ context: {} }),
      component: () => <div data-testid="unreleased-panel" />,
    }),
  );
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings",
    component: () => <div data-testid="settings" />,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([...guarded, settingsRoute]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
}

describe("the unreleased settings routes without the features", () => {
  it.each(GUARDED.map(([path]) => path))(
    "%s lands on Settings, replacing the entry",
    async (path) => {
      const router = buildRouter(path);
      await router.load();
      expect(router.state.location.pathname).toBe("/settings");
      // `replace`: Back leaves Settings instead of bouncing off the page again.
      expect(router.history.length).toBe(1);
    },
  );

  it("leaves Settings itself alone", async () => {
    const router = buildRouter("/settings");
    await router.load();
    expect(router.state.location.pathname).toBe("/settings");
  });
});

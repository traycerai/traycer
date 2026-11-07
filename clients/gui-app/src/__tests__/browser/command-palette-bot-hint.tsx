import { useMemo, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  CommandPaletteShell,
  RootView,
  type PaletteRootListProps,
} from "@/components/command-palette/command-palette-shell";
import { CommandPaletteRouterContext } from "@/components/command-palette/command-palette-context";
import { buildCommandContext } from "@/lib/commands/context";
import { botsSource } from "@/lib/commands/sources/bots.source";
import { routerAdapterFor } from "@/lib/keybindings/router-adapter";
import { useStandaloneBotsStore } from "@/stores/bots/standalone-bots-store";
import { useCommandPaletteStore } from "@/stores/command-palette/command-palette-store";
import "@/lib/theme-applier";
import "@/index.css";

/**
 * THE TRACY ROWS OF THE COMMAND PALETTE, open in real Chrome: the production
 * palette shell and root view over the production Tracy source, through the
 * real router adapter. The directory holds a team's bot whose team has a
 * name far longer than the row, so the row carries its team beside its own
 * name; `browser-tests/command-palette-bot-hint.spec.ts` measures that row.
 */

/** A team name long enough to overflow any palette row on its own. */
const LONG_TEAM_NAME =
  "the platform infrastructure and developer experience guild of traycerai";

useStandaloneBotsStore.setState({
  directory: {
    model: {
      groups: [
        {
          environmentId: "env-team",
          label: LONG_TEAM_NAME,
          ownerKind: "organization",
          canCreate: true,
          bots: [
            {
              botId: "bot_0BHAF30C73QHBSQ7G0M8C7W2PR",
              environmentId: "env-team",
              createdByUserId: "user-1",
              title: "Triage",
              harness: "claude",
              model: "claude-opus-5-5",
              effort: null,
              profile: null,
              trunkChatId: "trunk-triage",
              boundHostId: "host-1",
              hostEpoch: 0,
              createdAt: 1,
              archivedAt: null,
              directive: null,
              replyMode: "direct",
              appConversationChatId: null,
            },
          ],
          mainBotId: null,
        },
      ],
      botCount: 1,
    },
    setups: [],
  },
  settled: true,
});

export function TracyRootList(props: PaletteRootListProps): ReactElement {
  const items = botsSource.useItems(props.ctx);
  return <RootView {...props} items={items} loading={false} />;
}

const rootRoute = createRootRoute({ component: Outlet });
const router = createRouter({
  routeTree: rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => null,
    }),
  ]),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});
const adapter = routerAdapterFor(router);

export function Fixture(): ReactElement {
  const ctx = useMemo(
    () => buildCommandContext({ router: adapter, focusedComposerKind: null }),
    [],
  );
  return (
    <CommandPaletteRouterContext.Provider value={adapter}>
      <RouterProvider router={router} />
      <CommandPaletteShell ctx={ctx} RootList={TracyRootList} />
    </CommandPaletteRouterContext.Provider>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("command-palette-bot-hint: no #root");
createRoot(root).render(<Fixture />);
useCommandPaletteStore.getState().setOpen(true);

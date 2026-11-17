import { createRoot } from "react-dom/client";

import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import {
  advertiseHostMethods,
  BOT_ID,
  HOST_ID,
  hostGates,
} from "./bot-compact-actions-menu-host";
import { ColdOpenFixture } from "./tracy-tab-cold-open-page";

/**
 * A TRACY TAB'S COLD OPEN, THROUGH THE REAL TAB HOST.
 *
 * The real `TopLevelTabHost` mounts the one Tracy tab, whose surface is the
 * real lazy `BotTabSurface`, over the fake host of
 * `bot-compact-actions-menu-host`. Every wait on the way to the channel's
 * header is held until the page's probe releases it, in the order a cold open
 * meets them:
 *
 * - `hostMethods`: the host's handshake (`?hostMethods=held` leaves it open);
 * - `drafts`: the read of the account's own drafts;
 * - `lists`: the bot, conversation and environment lists;
 * - `open`: the channel's `bot.open`;
 * - `snapshot`: the channel's snapshot (`?snapshot=held` holds it).
 *
 * The surface's code is held by the spec, which holds the request for its
 * module. The page is the phone's form, as the installed app is, so the title
 * row is the one the channel's header draws.
 */
type Gate = "hostMethods" | "drafts" | "lists" | "open" | "snapshot";

declare global {
  interface Window {
    __coldOpenProbe?: { readonly release: (gate: Gate) => void };
  }
}

interface Held {
  readonly opened: Promise<void>;
  readonly open: () => void;
}

function hold(): Held {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

const drafts = hold();
const lists = hold();
const channelOpen = hold();

hostGates.lists = lists.opened;
hostGates.open = channelOpen.opened;

// The drafts the tab waits on are read when the account signs in; the read
// begins once its gate opens.
const rehydrate = useBotDraftsStore.persist.rehydrate;
useBotDraftsStore.persist.rehydrate = () =>
  drafts.opened.then(() => rehydrate());

useTracySurfaceStore.getState().openSurface(HOST_ID);
useTracySurfaceStore.getState().selectChannel(BOT_ID);

window.__coldOpenProbe = {
  release: (gate) => {
    switch (gate) {
      case "hostMethods":
        advertiseHostMethods();
        return;
      case "drafts":
        drafts.open();
        return;
      case "lists":
        lists.open();
        return;
      case "open":
        channelOpen.open();
        return;
      case "snapshot":
        window.__botChannelProbe?.holdSnapshots(null);
        return;
    }
  },
};

const root = document.querySelector("#root");
if (root === null) throw new Error("tracy tab cold open root missing");
createRoot(root).render(<ColdOpenFixture />);

import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { BotReplyingStrip } from "@/components/bots/bot-replying-strip";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useSettingsStore } from "@/stores/settings/settings-store";
import "@/lib/theme-applier";
import "@/index.css";

/**
 * THE REPLYING STRIP IN A DOCK, WITH AND WITHOUT A TURN TO OPEN.
 *
 * The real `BotReplyingStrip` in two docks as the channel draws one: a
 * transcript stand-in above, the strip, a composer stand-in below. The first
 * dock's strip names a turn that has been running for a few seconds; the
 * second names none, to compare heights. Opening the turn is counted on the
 * first dock's `data-opened`. `?theme=dark` draws it dark.
 */
const theme = new URLSearchParams(window.location.search).get("theme");
useSettingsStore.getState().setTheme(theme === "dark" ? "dark" : "light");

const STARTED_AT = Date.now() - 75_000;

export function Dock(props: {
  readonly id: string;
  readonly withTurn: boolean;
  readonly onOpen: () => void;
}): ReactElement {
  return (
    <div
      data-testid={`dock-${props.id}`}
      className="flex h-96 w-full max-w-md flex-col border border-border/60"
    >
      <div className="min-h-0 flex-1 p-4 text-ui-sm">Transcript</div>
      <BotReplyingStrip
        botTitle="Tracy"
        activity={{
          state: "replying",
          startedAt: STARTED_AT,
          step: null,
          requestId: "request-1",
          reason: null,
        }}
        turn={
          props.withTurn
            ? {
                summary: null,
                startedAt: STARTED_AT,
                endedAt: null,
                open: props.onOpen,
              }
            : null
        }
        testId={`strip-${props.id}`}
      />
      <div
        data-testid={`composer-${props.id}`}
        className="m-2 h-16 rounded-md border border-border"
      >
        Composer
      </div>
    </div>
  );
}

export function Page(): ReactElement {
  const onOpen = (): void => {
    const dock = document.querySelector('[data-testid="dock-turn"]');
    const opened = Number(dock?.getAttribute("data-opened") ?? "0") + 1;
    dock?.setAttribute("data-opened", String(opened));
  };
  return (
    <TooltipProvider>
      <div className="flex w-full gap-4 bg-background p-4 text-foreground">
        <Dock id="turn" withTurn onOpen={onOpen} />
        <Dock id="plain" withTurn={false} onOpen={onOpen} />
      </div>
    </TooltipProvider>
  );
}

const root = document.querySelector("#root");
if (root === null) throw new Error("bot replying strip fixture root missing");
createRoot(root).render(<Page />);

import {
  AlarmClock,
  Bot,
  Monitor,
  Plug,
  TerminalSquare,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type { BackgroundItem } from "@traycer/protocol/host/agent/gui/subscribe";

/**
 * One glyph per background-item kind, for every surface that lists background
 * work.
 *
 * A registry rather than a component, because the two consumers size and tone
 * their glyphs differently - the chat panel paints its rows `text-primary/80`
 * at `size-3.5`, Home's Background section reads `text-muted-foreground` at
 * `size-4` like every other row glyph there. What must not differ is WHICH
 * glyph a kind gets: a sub-agent that is a `Bot` in the chat and something else
 * on Home teaches two vocabularies for one thing.
 *
 * `Record<BackgroundItem["kind"], LucideIcon>` rather than a switch, so a kind
 * added to the protocol fails to compile here instead of falling through to a
 * default glyph at runtime.
 */
export const BACKGROUND_KIND_ICONS: Readonly<
  Record<BackgroundItem["kind"], LucideIcon>
> = {
  subagent: Bot,
  command: TerminalSquare,
  monitor: Monitor,
  wakeup: AlarmClock,
  workflow: Workflow,
  mcp: Plug,
};

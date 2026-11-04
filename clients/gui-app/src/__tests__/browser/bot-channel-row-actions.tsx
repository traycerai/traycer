import { useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { makeMessage } from "@/components/chat/__tests__/chat-message-fixtures";
import {
  ChatBotPresentationContext,
  type ChatBotPresentation,
} from "@/components/chat/chat-bot-presentation-context";
import { ChatMessage } from "@/components/chat/chat-message";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ResolvedThemeContext } from "@/providers/use-resolved-theme";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import "@/index.css";

/**
 * A MEMBER'S FRESH POST IN A BOT'S CHANNEL, WITH ITS HOVER ACTIONS.
 *
 * The real `ChatMessage` row of a member's post whose thread has no reply
 * yet, so the row's floating actions are the only way into the thread from
 * the row itself. `data-testid="opened"` counts the threads the row opened.
 * The spec reads the actions' computed style under a fine and a coarse
 * pointer; nothing of the row is reimplemented.
 */
const NO_BLOCKS: ReadonlySet<string> = new Set();
const POST_TEXT = "Can you cut the release branch tonight?";

const post: ChatMessageModel = {
  ...makeMessage(0, "user"),
  createdAt: Date.now(),
  persistentMessageId: "post-1",
  senderLabel: "Tess Teammate",
  content: POST_TEXT,
  segments: [
    {
      id: "post-1:text",
      kind: "text",
      markdown: POST_TEXT,
      isStreaming: false,
    },
  ],
};

export function Channel(): ReactElement {
  const [opened, setOpened] = useState(0);
  const presentation: ChatBotPresentation = {
    botTitle: "Release Bot",
    threadLine: () => null,
    openThread: () => setOpened((count) => count + 1),
    openAnnouncementThread: null,
    threadAnchorKinds: [],
    chooseOption: null,
    questions: null,
    failedRequest: null,
    failedRecovery: null,
    replyReceipt: null,
    requestReceipt: null,
  };
  return (
    <ResolvedThemeContext.Provider
      value={{ resolvedTheme: "light", themePreset: "neutral" }}
    >
      <TooltipProvider>
        <ChatExpansionTestProviders tileInstanceId="bot-channel-row-actions">
          <ChatBotPresentationContext.Provider value={presentation}>
            <main className="flex min-h-screen flex-col bg-background px-2 py-3 text-foreground">
              <ChatMessage
                message={post}
                actions={null}
                backgroundToolBlockIds={NO_BLOCKS}
                nextStepActions={null}
              />
              <output data-testid="opened">{opened}</output>
            </main>
          </ChatBotPresentationContext.Provider>
        </ChatExpansionTestProviders>
      </TooltipProvider>
    </ResolvedThemeContext.Provider>
  );
}

const rootRoute = createRootRoute({ component: Channel });
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => null,
});
const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute]),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

const root = document.querySelector("#root");
if (root === null)
  throw new Error("bot channel row actions fixture root missing");
createRoot(root).render(<RouterProvider router={router} />);

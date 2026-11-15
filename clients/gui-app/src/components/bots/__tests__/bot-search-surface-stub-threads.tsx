import { vi } from "vitest";

vi.mock("@/components/bots/bot-threads-view", () => ({
  BotThreadsView: () => <div data-testid="stub-threads" />,
}));

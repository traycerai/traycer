import { vi } from "vitest";

vi.mock("@/components/bots/bot-message-composer", () => ({
  BotMessageComposer: (props: { testId: string }) => (
    <div data-testid={`stub-${props.testId}`} />
  ),
}));

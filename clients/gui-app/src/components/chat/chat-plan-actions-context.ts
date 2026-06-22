import { createContext, use } from "react";

export interface ChatPlanActionsContextValue {
  readonly epicId: string;
  readonly chatId: string;
  readonly canAct: boolean;
  readonly pending: boolean;
  // Sends a follow-up user message asking the harness to implement the plan.
  // Plan mode is non-blocking and uniform across harnesses: a plan card never
  // carries a pending approval to resolve (the plan turn already completed), so
  // the Implement action always sends a fresh "implement the plan" message.
  // Returns true when the message was accepted.
  readonly onImplement: () => boolean;
}

export const ChatPlanActionsContext =
  createContext<ChatPlanActionsContextValue | null>(null);

export function useChatPlanActions(): ChatPlanActionsContextValue | null {
  return use(ChatPlanActionsContext);
}

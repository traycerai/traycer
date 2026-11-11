import { createContext } from "react";

export const ChatIndicatorFreshHostsContext = createContext<
  Readonly<Record<string, boolean>>
>({});

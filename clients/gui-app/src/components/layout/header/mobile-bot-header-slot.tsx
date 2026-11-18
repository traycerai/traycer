import { useMemo, useState, type ReactNode } from "react";
import { MobileBotHeaderSlotContext } from "@/components/layout/header/mobile-bot-header-context";

/** Each app shell owns its target, so one window cannot take another's title. */
export function MobileBotHeaderSlotProvider(props: {
  readonly children: ReactNode;
}): ReactNode {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const value = useMemo(() => ({ target, setTarget }), [target]);
  return (
    <MobileBotHeaderSlotContext value={value}>
      {props.children}
    </MobileBotHeaderSlotContext>
  );
}

import type { ReactNode } from "react";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";

interface EpicSessionGateProps {
  readonly children: ReactNode;
  readonly fallback: ReactNode;
}

export function EpicSessionGate(props: EpicSessionGateProps): ReactNode {
  const openEpicHandle = useMaybeOpenEpicHandle();
  return openEpicHandle === null ? props.fallback : props.children;
}

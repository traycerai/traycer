import { useMemo, type ReactNode } from "react";
import {
  LinkTargetContext,
  type LinkTarget,
} from "@/lib/links/link-target-context";

interface LinkTargetProviderProps extends LinkTarget {
  readonly children: ReactNode;
}

export function LinkTargetProvider(props: LinkTargetProviderProps) {
  const { epicId, viewTabId } = props;
  const value = useMemo<LinkTarget>(
    () => ({ epicId, viewTabId }),
    [epicId, viewTabId],
  );
  return (
    <LinkTargetContext.Provider value={value}>
      {props.children}
    </LinkTargetContext.Provider>
  );
}

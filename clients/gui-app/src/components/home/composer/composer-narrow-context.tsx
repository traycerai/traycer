import { type ReactNode } from "react";
import { ComposerNarrowContext } from "@/components/home/composer/composer-narrow-context-internal";

export function ComposerNarrowProvider(props: {
  isNarrow: boolean;
  children: ReactNode;
}) {
  return (
    <ComposerNarrowContext.Provider value={props.isNarrow}>
      {props.children}
    </ComposerNarrowContext.Provider>
  );
}

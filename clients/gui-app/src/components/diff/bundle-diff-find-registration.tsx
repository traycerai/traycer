import type { ReactNode } from "react";
import {
  BundleDiffFindRegistrationContext,
  type BundleDiffFindRegistrationContextValue,
} from "@/components/diff/bundle-diff-find-registration-hooks";

export function BundleDiffFindRegistrationProvider(props: {
  readonly value: BundleDiffFindRegistrationContextValue;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <BundleDiffFindRegistrationContext.Provider value={props.value}>
      {props.children}
    </BundleDiffFindRegistrationContext.Provider>
  );
}

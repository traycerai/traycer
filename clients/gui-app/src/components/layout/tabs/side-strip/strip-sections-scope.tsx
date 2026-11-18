import { useLayoutEffect, type ReactNode } from "react";
import { useNeedsYouTaskCountStore } from "@/stores/notifications/needs-you-task-count-store";
import type { StripItemsSource } from "./strip-item-tabs";
import { needsYouTaskCountOf } from "./strip-sections";
import { StripSectionsContext } from "./strip-sections-context";
import { useStripSections } from "./use-strip-sections";

/**
 * The window's tasks in sections, read once per strip in either view and
 * either placement: the Activity view's rows draw them, and their Needs you
 * task count is published for the counts outside the list, so the
 * Notifications pill and the header's bell say the number the Needs you header
 * does. Published before paint, so no frame shows the two disagreeing. Mount
 * it under the strip's `StripNeedsYouScope` and `TabStripIndicatorScope`.
 */
export function StripSectionsScope(props: {
  readonly controller: StripItemsSource;
  readonly children: ReactNode;
}): ReactNode {
  const sections = useStripSections(props.controller);
  const needsYouCount = needsYouTaskCountOf(sections);
  useLayoutEffect(() => {
    useNeedsYouTaskCountStore.setState({ count: needsYouCount });
  }, [needsYouCount]);
  useLayoutEffect(
    () => () => {
      useNeedsYouTaskCountStore.setState({ count: 0 });
    },
    [],
  );
  return (
    <StripSectionsContext.Provider value={sections}>
      {props.children}
    </StripSectionsContext.Provider>
  );
}

import { lazy, Suspense, type ReactNode } from "react";

const TracyTabPicture = lazy(() =>
  import("@/components/bots/tracy-entry-picture").then((module) => ({
    default: module.TracyTabIcon,
  })),
);

/**
 * The Tracy tab's icon: the Tracy entry's picture. This file imports nothing
 * of a bot's picture itself, because that reaches the tab registry and the
 * registry imports the tab kind that names this icon.
 */
export function TracyTabIcon(props: {
  readonly className: string | undefined;
}): ReactNode {
  return (
    <Suspense fallback={null}>
      <TracyTabPicture className={props.className} />
    </Suspense>
  );
}

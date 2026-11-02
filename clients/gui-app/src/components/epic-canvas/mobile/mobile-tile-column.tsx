import { TileSwitcherList } from "@/components/epic-canvas/mobile/tile-switcher-list";
import { MobileLevel2Column } from "@/components/layout/shell/mobile-level2";
import { useEpicTitle } from "@/lib/epic-selectors";
import type { MobileLevel2Form } from "@/lib/layout/mobile-layout-form";
import "@/components/layout/shell/mobile-shell-touch-targets.css";

function stayOpen(): void {}

/**
 * The task's tiles beside the content, at the width the resolver answered, and
 * nothing in a form that has no column.
 */
export function MobileTileColumn(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly level2: MobileLevel2Form;
}) {
  const { epicId, tabId, level2 } = props;
  if (typeof level2 !== "object") return null;
  return (
    <MobileTileColumnBody epicId={epicId} tabId={tabId} width={level2.column} />
  );
}

function MobileTileColumnBody(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly width: number;
}) {
  const { epicId, tabId, width } = props;
  const title = useEpicTitle();
  return (
    <MobileLevel2Column width={width} testId="mobile-tile-column">
      <nav
        aria-label={title}
        data-mobile-shell-touch-scope=""
        className="flex min-h-0 flex-1 flex-col"
      >
        <TileSwitcherList epicId={epicId} tabId={tabId} onClose={stayOpen} />
      </nav>
    </MobileLevel2Column>
  );
}

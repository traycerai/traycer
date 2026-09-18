import type { ReactNode } from "react";
import { CustomizeOptionPicture } from "@/lib/customize/options/option-pictures";
import {
  useComposerLayout,
  useLayoutSetting,
  useStatusBarRateLimitValue,
} from "@/lib/layout-overrides";
import type {
  ComposerCompactableMode,
  ComposerLayoutPreferences,
  DockSection,
  ToolbarItemId,
} from "@/stores/settings/layout-store";

/**
 * The layout, drawn small: the tab strip, the composer's dock rows and toolbar,
 * and the status bar's usage readings.
 *
 * Read through the layout-override seam, so the SAME component draws the card's
 * "your layout now" (no provider above it) and each preset's thumbnail (under
 * `LayoutOverrideProvider value={preset}`): what differs between them is the
 * values it is handed, never the drawing.
 *
 * **Passive by construction.** Every piece is one of the option pictures'
 * NON-registering view leaves. A registering wrapper here would register an
 * instance the moment Customize starts from Settings - a hotspot nobody can
 * reach, drawn inside a page the editor is not editing - so this file mounts
 * none, and `appearance-layout-passive.test.tsx` holds it to that. It is a
 * picture and not a control: callers wrap it `inert aria-hidden`, and it
 * carries no text a reader could not get from the labels beside it.
 *
 * Drawn from the leaves and not from the real tab strip / toolbar / dock, which
 * would mount the app's chrome a second time (host queries, keyboard handlers,
 * activation registration) to show what a row of icons can.
 */
export function LayoutThumbnail(): ReactNode {
  const composer = useComposerLayout();
  const homeTab = useLayoutSetting("homeTabEnabled");
  const usageShown = useStatusBarRateLimitValue("enabled");
  return (
    <div className="flex w-full min-w-0 flex-col gap-2 overflow-hidden text-ui-sm">
      <ThumbnailRow>
        {homeTab ? (
          <CustomizeOptionPicture id="tabs.home" value="visible" />
        ) : null}
        <span className="h-6 w-16 shrink-0 rounded-md border border-border/60" />
      </ThumbnailRow>
      <div className="flex flex-col gap-1 rounded-md border border-border/60 bg-background p-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          {composer.dockOrder.map((section) => (
            <DockPicture
              key={section}
              section={section}
              mode={composer[section]}
            />
          ))}
        </div>
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <ToolbarCluster items={composer.toolbar.left} composer={composer} />
          <ToolbarCluster items={composer.toolbar.right} composer={composer} />
        </div>
      </div>
      <ThumbnailRow>
        {usageShown ? (
          <CustomizeOptionPicture id="statusBar.usage.show" value="on" />
        ) : (
          <span className="h-4 w-full rounded-sm border border-dashed border-border/60" />
        )}
      </ThumbnailRow>
    </div>
  );
}

function ThumbnailRow(props: { readonly children: ReactNode }): ReactNode {
  return (
    <div className="flex min-w-0 items-center gap-1 overflow-hidden">
      {props.children}
    </div>
  );
}

function DockPicture(props: {
  readonly section: DockSection;
  readonly mode: ComposerCompactableMode;
}): ReactNode {
  return (
    <CustomizeOptionPicture
      id={`composer.${props.section}`}
      value={props.mode}
    />
  );
}

function ToolbarCluster(props: {
  readonly items: ReadonlyArray<ToolbarItemId>;
  readonly composer: ComposerLayoutPreferences;
}): ReactNode {
  const { items, composer } = props;
  return (
    <div className="flex min-w-0 items-center gap-1">
      {items.map((item) => (
        <ToolbarPicture key={item} item={item} composer={composer} />
      ))}
    </div>
  );
}

function ToolbarPicture(props: {
  readonly item: ToolbarItemId;
  readonly composer: ComposerLayoutPreferences;
}): ReactNode {
  const { item, composer } = props;
  // Hidden elements are not drawn at all rather than as the dashed ghost the
  // editor uses: a thumbnail compares what IS on screen, and a hidden button is
  // not.
  if (item === "attachImage" && composer.attachImage === "hidden") return null;
  if (item === "mic" && composer.mic === "hidden") return null;
  // `harness` has no picture of its own: its trigger is the model chip's
  // sibling in the live toolbar, and the model chip already says which
  // provider this is.
  if (item === "harness") return null;
  return (
    <CustomizeOptionPicture
      id={`composer.${item}`}
      value={item === "access" ? composer.access : "visible"}
    />
  );
}

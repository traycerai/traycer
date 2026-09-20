import { useCustomizeLayout } from "@/components/customize/use-customize-layout";
import { useSortableProxy } from "@/components/customize/use-sortable-proxy";
import {
  getCustomizeOptions,
  useCustomizeOptionsRegistry,
} from "@/lib/customize/customize-options";
import { consumeCustomizeDragClick } from "@/lib/customize/drop";
import { useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getCustomizeSetting } from "@/lib/customize/catalog";
import { cn } from "@/lib/utils";
import {
  useCustomizeStore,
  type HotspotInstance,
  type InstanceKey,
} from "@/stores/customize/customize-store";

export function CustomizeProxies({
  instances,
  rects,
}: {
  instances: ReadonlyArray<HotspotInstance>;
  rects: ReadonlyMap<InstanceKey, DOMRect>;
}) {
  useCustomizeLayout();
  const activeKey = useCustomizeStore((state) => state.activeKey);
  const [lastFocusedKey, setLastFocusedKey] = useState<InstanceKey | null>(
    null,
  );
  const visible = instances.filter((instance) => rects.has(instance.key));
  const tabStop =
    visible.find((instance) => instance.key === activeKey) ??
    visible.find((instance) => instance.key === lastFocusedKey) ??
    visible[0];
  return (
    <TooltipProvider delayDuration={250} skipDelayDuration={500}>
      {instances.map((instance) => {
        const rect = rects.get(instance.key);
        return rect ? (
          <Proxy
            key={instance.key}
            instance={instance}
            rect={rect}
            tabIndex={tabStop.key === instance.key ? 0 : -1}
            onFocused={() => setLastFocusedKey(instance.key)}
          />
        ) : null;
      })}
    </TooltipProvider>
  );
}
function Proxy({
  instance,
  rect,
  tabIndex,
  onFocused,
}: {
  instance: HotspotInstance;
  rect: DOMRect;
  tabIndex: number;
  onFocused: () => void;
}) {
  useCustomizeOptionsRegistry();
  const options = getCustomizeOptions(instance);
  const state = proxyState(instance);
  const { setNodeRef, attributes, listeners, transform } = useSortableProxy(
    instance.key,
    options?.drag?.axis ?? "both",
  );
  const active = useCustomizeStore((state) => state.activeKey === instance.key);
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const labelOpen = active || focused || hovered;
  const label = getCustomizeSetting(instance.settingId).label;

  return (
    <Tooltip
      open={labelOpen}
      onOpenChange={(open) => {
        if (window.matchMedia("(hover: hover) and (pointer: fine)").matches)
          setHovered(open);
      }}
    >
      <TooltipTrigger asChild>
        <button
          ref={setNodeRef}
          {...attributes}
          {...listeners}
          type="button"
          tabIndex={tabIndex}
          data-customize-proxy={instance.key}
          data-customize-ghost={instance.ghost || undefined}
          aria-label={`Customize ${label}, ${state}`}
          aria-describedby={
            instance.condition ? `${instance.key}-condition` : undefined
          }
          className={cn(
            "pointer-events-auto fixed rounded-sm border border-dashed border-foreground bg-transparent outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring forced-colors:outline",
            active && "border-solid ring-2 ring-ring",
            options?.drag && "touch-none",
          )}
          style={{
            transform: transform
              ? `translate(${transform.x}px, ${transform.y}px)`
              : undefined,
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
          }}
          onFocus={() => {
            setFocused(true);
            onFocused();
            useCustomizeStore.getState().setActive(instance.key);
          }}
          onBlur={() => setFocused(false)}
          onPointerDownCapture={() =>
            useCustomizeStore.getState().setActive(instance.key)
          }
          onClick={() => {
            if (!consumeCustomizeDragClick())
              useCustomizeStore
                .getState()
                .openPopover(instance.key, instance.key, null);
          }}
        />
      </TooltipTrigger>
      <TooltipContent data-customize-editor>
        {label} · {state}
        {instance.condition ? (
          <span id={`${instance.key}-condition`}> — {instance.condition}</span>
        ) : null}
      </TooltipContent>
      {instance.condition ? (
        <span
          id={labelOpen ? undefined : `${instance.key}-condition`}
          className="sr-only"
        >
          {instance.condition}
        </span>
      ) : null}
    </Tooltip>
  );
}

function proxyState(instance: HotspotInstance): string {
  if (instance.ghost) return "hidden";
  return getCustomizeOptions(instance)?.state ?? "visible";
}

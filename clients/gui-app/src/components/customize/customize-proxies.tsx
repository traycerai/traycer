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
  return (
    <TooltipProvider delayDuration={250} skipDelayDuration={500}>
      {instances.map((instance) => {
        const rect = rects.get(instance.key);
        return rect ? (
          <Proxy key={instance.key} instance={instance} rect={rect} />
        ) : null;
      })}
    </TooltipProvider>
  );
}
function Proxy({
  instance,
  rect,
}: {
  instance: HotspotInstance;
  rect: DOMRect;
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
  const label = getCustomizeSetting(instance.settingId).label;

  return (
    <Tooltip
      open={focused || hovered}
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
          data-customize-proxy={instance.key}
          aria-label={`Customize ${label}, ${state}`}
          aria-describedby={
            instance.condition ? `${instance.key}-condition` : undefined
          }
          className={cn(
            "pointer-events-auto fixed min-h-6 min-w-6 rounded-sm border border-dashed border-foreground bg-transparent outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring forced-colors:outline",
            instance.ghost && "border-foreground/60",
            active && "border-solid ring-2 ring-ring",
            options?.drag && "touch-none",
          )}
          style={{
            transform: transform
              ? `translate(${transform.x}px, ${transform.y}px)`
              : undefined,
            left: rect.left + (rect.width - Math.max(24, rect.width)) / 2,
            top: rect.top + (rect.height - Math.max(24, rect.height)) / 2,
            width: Math.max(24, rect.width),
            height: Math.max(24, rect.height),
          }}
          onFocus={() => {
            setFocused(true);
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
      <TooltipContent>
        {label} · {state}
        {instance.condition ? (
          <span id={`${instance.key}-condition`}> — {instance.condition}</span>
        ) : null}
      </TooltipContent>
      {instance.condition ? (
        <span
          id={focused || hovered ? undefined : `${instance.key}-condition`}
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

import { useId } from "react";
import type {
  HotspotInstance,
  InstanceKey,
} from "@/stores/customize/customize-store";

export function CustomizeScrim({
  instances,
  rects,
  closePopover,
}: {
  instances: ReadonlyArray<HotspotInstance>;
  rects: ReadonlyMap<InstanceKey, DOMRect>;
  closePopover: () => void;
}) {
  const id = useId();
  return (
    <svg
      className="pointer-events-none fixed inset-0 h-full w-full"
      aria-hidden
      onClick={closePopover}
    >
      <defs>
        <mask id={id}>
          <rect width="100%" height="100%" className="fill-white" />
          {instances
            .filter((instance) => !instance.ghost)
            .map((instance) => {
              const rect = rects.get(instance.key);
              return rect ? (
                <rect
                  key={instance.key}
                  x={rect.x}
                  y={rect.y}
                  width={rect.width}
                  height={rect.height}
                  rx="4"
                  className="fill-black"
                />
              ) : null;
            })}
          {/* The tab strip stays operable. Its parent sits above this scrim. */}
        </mask>
      </defs>
      <rect
        width="100%"
        height="100%"
        className="fill-black"
        fillOpacity="0.35"
        mask={`url(#${id})`}
      />
    </svg>
  );
}

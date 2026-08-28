import type { BrowserViewSnapshotState } from "@/lib/browser-view/tiles/browser-overlay-coordinator";

export function BrowserViewSnapshotLayer(props: {
  readonly snapshot: BrowserViewSnapshotState | null;
}) {
  const snapshot = props.snapshot;
  if (snapshot === null) return null;
  return (
    <div
      className="pointer-events-none absolute inset-0 z-10 bg-background"
      data-browser-view-snapshot=""
      data-stale={snapshot.stale ? "true" : "false"}
    >
      {snapshot.dataUrl === null ? null : (
        <img
          src={snapshot.dataUrl}
          alt=""
          aria-hidden
          className="h-full w-full object-contain"
          draggable={false}
        />
      )}
    </div>
  );
}

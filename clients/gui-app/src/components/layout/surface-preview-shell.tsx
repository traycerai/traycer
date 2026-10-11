/** Occupies the body's existing box without mounting its resource owners. */
export function SurfacePreviewShell() {
  return (
    <div
      className="h-full min-h-0 w-full bg-canvas"
      data-testid="surface-preview-shell"
      aria-hidden="true"
    />
  );
}

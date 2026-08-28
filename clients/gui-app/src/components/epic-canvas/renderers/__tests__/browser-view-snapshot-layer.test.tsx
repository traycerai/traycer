import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import { BrowserViewSnapshotLayer } from "@/components/epic-canvas/renderers/browser-view-snapshot-layer";

it("preserves a fixed viewport's aspect ratio while the native view is occluded", () => {
  const { container } = render(
    <BrowserViewSnapshotLayer
      snapshot={{ dataUrl: "data:image/png;base64,frame", stale: false }}
    />,
  );

  expect(container.querySelector("img")?.className).toContain("object-contain");
});

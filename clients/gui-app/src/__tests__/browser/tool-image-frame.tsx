import { useEffect, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  AttachmentImage,
  AttachmentImageLoading,
} from "@/components/chat/segments/attachment-image";
import "@/lib/theme-applier";
import "@/index.css";

/**
 * THE FRAME A CHAT IMAGE HOLDS WHILE IT LOADS: the real `AttachmentImage` and
 * `AttachmentImageLoading` (what `ResolvedImage` draws for a blob that is still
 * syncing, a blob the browser has not decoded, and a delayed SVG sanitizer),
 * each in a container of a known width.
 *
 * jsdom has no layout, so it cannot say whether the placeholder and the image
 * that replaces it occupy the same box. `browser-tests/tool-image-frame.spec.ts`
 * measures them in Chrome. The "undecoded" and "delayed" sources are requests
 * the spec holds open, so those states last as long as the spec wants.
 *
 * Every case is a `section[data-case]` whose FIRST child is the frame.
 */

function pngDataUrl(width: number, height: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("no 2d canvas");
  context.fillStyle = "#4488cc";
  context.fillRect(0, 0, width, height);
  return canvas.toDataURL("image/png");
}

const WIDE = 900;
const NARROW = 300;

interface Case {
  readonly id: string;
  readonly containerWidth: number;
  readonly render: () => ReactElement;
}

function loading(
  width: number | null,
  height: number | null,
): () => ReactElement {
  return () => (
    <AttachmentImageLoading
      label="Waiting for image sync"
      fullWidth={false}
      width={width}
      height={height}
    />
  );
}

function raster(
  src: string,
  width: number | null,
  height: number | null,
): () => ReactElement {
  return () => (
    <AttachmentImage
      alt="plot"
      src={src}
      mediaType="image/png"
      suggestedName={null}
      fullWidth={false}
      width={width}
      height={height}
    />
  );
}

const CASES: ReadonlyArray<Case> = [
  { id: "wait-512", containerWidth: WIDE, render: loading(512, 512) },
  {
    id: "undecoded-512",
    containerWidth: WIDE,
    render: raster("/fixture-image/slow-512.png", 512, 512),
  },
  {
    id: "loaded-512",
    containerWidth: WIDE,
    render: raster(pngDataUrl(512, 512), 512, 512),
  },
  { id: "wait-portrait", containerWidth: WIDE, render: loading(256, 512) },
  {
    id: "undecoded-portrait",
    containerWidth: WIDE,
    render: raster("/fixture-image/slow-portrait.png", 256, 512),
  },
  {
    id: "loaded-portrait",
    containerWidth: WIDE,
    render: raster(pngDataUrl(256, 512), 256, 512),
  },
  { id: "wait-large", containerWidth: WIDE, render: loading(1600, 800) },
  {
    id: "loaded-large",
    containerWidth: WIDE,
    render: raster(pngDataUrl(1600, 800), 1600, 800),
  },
  { id: "wait-narrow", containerWidth: NARROW, render: loading(512, 512) },
  {
    id: "loaded-narrow",
    containerWidth: NARROW,
    render: raster(pngDataUrl(512, 512), 512, 512),
  },
  {
    id: "svg-delayed",
    containerWidth: WIDE,
    render: () => (
      <AttachmentImage
        alt="diagram"
        src="/fixture-image/delayed.svg"
        mediaType="image/svg+xml"
        suggestedName={null}
        fullWidth={false}
        width={512}
        height={512}
      />
    ),
  },
  // No recorded size (Markdown and editor images): the image's own size.
  {
    id: "loaded-unrecorded",
    containerWidth: WIDE,
    render: raster(pngDataUrl(512, 300), null, null),
  },
];

export function Fixture(): ReactElement {
  useEffect(() => {
    document.body.dataset["ready"] = "true";
  }, []);
  return (
    <div>
      {CASES.map((testCase) => (
        <section
          key={testCase.id}
          data-case={testCase.id}
          style={{ width: testCase.containerWidth }}
        >
          {testCase.render()}
        </section>
      ))}
    </div>
  );
}

export function Providers(props: {
  readonly children: ReactNode;
}): ReactElement {
  return (
    <QueryClientProvider client={new QueryClient()}>
      {props.children}
    </QueryClientProvider>
  );
}

const rootRoute = createRootRoute({
  component: () => (
    <Providers>
      <Fixture />
    </Providers>
  ),
});
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => null,
});
const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute]),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

const container = document.getElementById("root");
if (container === null) throw new Error("no #root");
createRoot(container).render(<RouterProvider router={router} />);

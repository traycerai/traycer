import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { AttachmentStrip } from "@/components/chat/composer/attachments/attachment-strip";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ScopedImageBytesFetcher } from "@/lib/attachments/image-blob-cache";
import "@/lib/theme-applier";
import "@/index.css";

/**
 * A DRAFT WITH THREE ATTACHED IMAGES OF THREE DIFFERENT SHAPES.
 *
 * The real `AttachmentStrip`, so the chips, the one viewer they share and its
 * navigation are production's. The images are hash-only, the shape a restored
 * draft has, and their bytes come through the real blob cache from the fetcher
 * below, which paints a PNG of each image's own size. The shapes differ on
 * purpose: `browser-tests/image-set-viewer.spec.ts` measures that the viewer
 * keeps its box, and its arrows their place, from one image to the next.
 */
interface FixtureImage {
  readonly hash: string;
  readonly width: number;
  readonly height: number;
  readonly fill: string;
}

const IMAGES: readonly FixtureImage[] = [
  { hash: "image-set-1", width: 390, height: 310, fill: "#3b5b92" },
  { hash: "image-set-2", width: 336, height: 252, fill: "#2f6b4f" },
  { hash: "image-set-3", width: 1858, height: 776, fill: "#8a6d1f" },
];

async function paintPng(image: FixtureImage): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("no 2d context for the fixture image");
  context.fillStyle = image.fill;
  context.fillRect(0, 0, image.width, image.height);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) reject(new Error("the fixture image did not encode"));
      else resolve(blob);
    }, "image/png");
  });
}

const fetcher: ScopedImageBytesFetcher = {
  scopeKey: "image-set-viewer-fixture",
  fetch: async (hash) => {
    const image = IMAGES.find((candidate) => candidate.hash === hash);
    if (image === undefined) throw new Error(`unknown fixture image ${hash}`);
    const blob = await paintPng(image);
    return {
      bytes: new Uint8Array(await blob.arrayBuffer()),
      mediaType: "image/png",
    };
  },
};

const content: JsonContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: IMAGES.map((image, index) => ({
        type: "imageAttachment",
        attrs: {
          id: image.hash,
          fileName: `shot-${String(index + 1)}.png`,
          hash: image.hash,
          mimeType: "image/png",
        },
      })),
    },
  ],
};

const queryClient = new QueryClient();

export function Fixture(): ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <div className="flex p-4">
          <AttachmentStrip
            content={content}
            onRemoveImage={() => undefined}
            fetcher={fetcher}
            sessionObjectUrl={() => null}
          />
        </div>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

const root = document.querySelector("#root");
if (root === null) throw new Error("image set viewer fixture root missing");
createRoot(root).render(<Fixture />);

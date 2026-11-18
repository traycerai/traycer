import {
  createCanvasFrameSink,
  type CanvasFrameSink,
  type SimulatorFrameSink,
} from "@/lib/simulator-view/simulator-decoder";

/**
 * A sink whose elements arrive after the controller that paints into it. The
 * controller is created once per stream, the `<canvas>` and `<img>` mount
 * (and remount) with the surface, so the surface attaches them through
 * callback refs and the sink forwards to whichever pair is current. A frame
 * that lands while nothing is attached is dropped: the next one paints.
 * Each pair's sink is disposed when the pair changes, which includes the
 * elements detaching on unmount, so the last JPEG's object URL is revoked.
 */
export interface AttachableFrameSink extends SimulatorFrameSink {
  readonly attachCanvas: (canvas: HTMLCanvasElement | null) => void;
  readonly attachImage: (image: HTMLImageElement | null) => void;
}

export function createAttachableFrameSink(): AttachableFrameSink {
  let canvas: HTMLCanvasElement | null = null;
  let image: HTMLImageElement | null = null;
  let inner: CanvasFrameSink | null = null;
  const rebuild = (): void => {
    inner?.dispose();
    inner = canvas === null ? null : createCanvasFrameSink(canvas, image);
  };
  return {
    attachCanvas(next) {
      if (canvas === next) return;
      canvas = next;
      rebuild();
    },
    attachImage(next) {
      if (image === next) return;
      image = next;
      rebuild();
    },
    present(source, width, height) {
      return inner?.present(source, width, height) ?? false;
    },
    presentJpeg(bytes) {
      return inner?.presentJpeg(bytes) ?? false;
    },
  };
}

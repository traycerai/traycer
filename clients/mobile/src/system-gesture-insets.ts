import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import {
  expectSystemGestureInsets,
  setSystemGestureInsets,
} from "@traycer-clients/gui-app/src/lib/system-gesture-insets";

interface NativeGeometry {
  readonly left: number;
  readonly right: number;
  readonly width: number;
  readonly sequence: number;
}

interface SystemGestureInsetsPlugin {
  get(): Promise<NativeGeometry>;
  addListener(
    event: "change",
    listener: (geometry: NativeGeometry) => void,
  ): Promise<PluginListenerHandle>;
}

const plugin = registerPlugin<SystemGestureInsetsPlugin>("SystemGestureInsets");

/** Keep window-pixel geometry aligned with the WebView's current CSS viewport. */
export function startSystemGestureInsets(): void {
  expectSystemGestureInsets();
  let current: NativeGeometry | null = null;
  const update = (): void => {
    if (current === null || current.width <= 0) return;
    const scale = 1 / window.devicePixelRatio;
    setSystemGestureInsets({
      left: current.left * scale,
      right: current.right * scale,
    });
  };
  const receive = (geometry: NativeGeometry): void => {
    if (geometry.width <= 0) return;
    if (current !== null && geometry.sequence < current.sequence) return;
    current = geometry;
    update();
  };
  window.addEventListener("resize", update);
  void plugin
    .addListener("change", receive)
    .then(() => plugin.get())
    .then(receive)
    .catch(() => {
      // The first draw publishes the insets if the window was not ready yet.
    });
}

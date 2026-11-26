import { Capacitor } from "@capacitor/core";

import { registerPackagedPhoneCanvasScope } from "@/lib/drafts/packaged-phone-canvas-scope";
import { NATIVE_HTTP_TOKEN_GLOBAL } from "./native-http-token";

const PACKAGED_ORIGIN = {
  ios: "capacitor://localhost",
  android: "http://localhost",
};

function isPackagedAppDocument(win: Window): boolean {
  if (
    !import.meta.env.PROD ||
    win.top !== win ||
    !Object.hasOwn(win, NATIVE_HTTP_TOKEN_GLOBAL)
  ) {
    return false;
  }

  const platform = Capacitor.getPlatform();
  if (platform !== "ios" && platform !== "android") return false;
  const origin = PACKAGED_ORIGIN[platform];
  const { protocol, host } = win.location;

  // WKWebView can report "null" for a custom scheme's location.origin.
  return (
    protocol + "//" + host === origin &&
    Reflect.get(win, "WEBVIEW_SERVER_URL") === origin
  );
}

if (Capacitor.isNativePlatform()) {
  registerPackagedPhoneCanvasScope(isPackagedAppDocument(window));
}

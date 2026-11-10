import { describe, expect, it } from "vitest";
import {
  isElectronWebviewDetachNoise,
  type RendererSentryErrorEvent,
} from "../sentry-capture-filter";

const NULL_SYNC_REPLY_VALUE =
  "object null is not iterable (cannot read property Symbol(Symbol.iterator))";
const GUEST_HOST_FILE =
  "..\\..\\..\\..\\gui-app\\src\\lib\\browser-view\\guest\\persistent-browser-guest-host.ts";
const ELECTRON_BUNDLE_FILE = "node:electron/js2c/isolated_bundle";
const ELECTRON_DETACH_FUNCTION = "WebViewElement.disconnectedCallback";

const handleReleaseFrame = {
  filename: GUEST_HOST_FILE,
  function: "handleRelease",
};
const removeGuestFrame = { filename: GUEST_HOST_FILE, function: "removeGuest" };
const electronDetachFrame = {
  filename: ELECTRON_BUNDLE_FILE,
  function: ELECTRON_DETACH_FUNCTION,
};

function eventWith(
  value: string,
  frames: { filename: string; function: string }[],
): RendererSentryErrorEvent {
  return { exception: { values: [{ value, stacktrace: { frames } }] } };
}

describe("isElectronWebviewDetachNoise", () => {
  it("is true for the production event: Electron's detach callback is the last frame", () => {
    expect(
      isElectronWebviewDetachNoise(
        eventWith(NULL_SYNC_REPLY_VALUE, [
          handleReleaseFrame,
          removeGuestFrame,
          electronDetachFrame,
        ]),
      ),
    ).toBe(true);
  });

  it("is false when the same message is thrown from our own frame", () => {
    expect(
      isElectronWebviewDetachNoise(
        eventWith(NULL_SYNC_REPLY_VALUE, [
          handleReleaseFrame,
          removeGuestFrame,
        ]),
      ),
    ).toBe(false);
  });

  it("is false when the Electron frame is not the throw site", () => {
    expect(
      isElectronWebviewDetachNoise(
        eventWith(NULL_SYNC_REPLY_VALUE, [
          handleReleaseFrame,
          electronDetachFrame,
          removeGuestFrame,
        ]),
      ),
    ).toBe(false);
  });

  it("is false for a different message from the Electron detach frame", () => {
    expect(
      isElectronWebviewDetachNoise(
        eventWith("undefined is not iterable", [
          handleReleaseFrame,
          removeGuestFrame,
          electronDetachFrame,
        ]),
      ),
    ).toBe(false);
  });

  it("is false when the filename is not under node:electron/js2c/", () => {
    expect(
      isElectronWebviewDetachNoise(
        eventWith(NULL_SYNC_REPLY_VALUE, [
          {
            filename: "app://renderer/bundle.js",
            function: ELECTRON_DETACH_FUNCTION,
          },
        ]),
      ),
    ).toBe(false);
  });

  const unusableEvents: [string, RendererSentryErrorEvent][] = [
    ["no exception", {}],
    ["no values", { exception: {} }],
    ["empty values", { exception: { values: [] } }],
    [
      "two exception values",
      {
        exception: {
          values: [
            {
              value: NULL_SYNC_REPLY_VALUE,
              stacktrace: { frames: [electronDetachFrame] },
            },
            {
              value: NULL_SYNC_REPLY_VALUE,
              stacktrace: { frames: [electronDetachFrame] },
            },
          ],
        },
      },
    ],
    [
      "no frames",
      {
        exception: {
          values: [
            { value: NULL_SYNC_REPLY_VALUE, stacktrace: { frames: [] } },
          ],
        },
      },
    ],
  ];

  it.each(unusableEvents)("is false for an event with %s", (_name, event) => {
    expect(isElectronWebviewDetachNoise(event)).toBe(false);
  });
});

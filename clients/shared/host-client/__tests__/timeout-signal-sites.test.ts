import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  exchangeCodeForTokens,
  refreshOnceAbortable,
  validateAuthTokenIdentityAccessOnceAbortable,
  validateAuthTokenIdentityAccessOnly,
} from "../../auth/auth-validation";
import { listUserSessionsViaHttp } from "../../auth/devices-sessions-fetcher";
import {
  registerDevicePushTokenViaHttp,
  removeDevicePushTokenViaHttp,
} from "../../auth/push-token-fetcher";
import { mintAttachGrantViaHttp } from "../../host-transport/remote/grant-client";
import { deregisterHostViaHttp } from "../host-deregister-fetcher";
import {
  probeHostActivity,
  probeHostActivityBusy,
  probeHostReachable,
} from "../host-activity-probe";
import { updateHostVersionPolicyViaHttp } from "../host-version-policy-fetcher";
import { fetchRegisteredHostsViaHttp } from "../remote-fetcher";

// Every shared fetch helper that a Capacitor shell reaches builds its own
// time-box. `AbortSignal.timeout` is Safari 16; the iOS shell's deployment
// target is 15.5, where the native call is a `TypeError` thrown at the
// argument and the helper's `catch` folds it into `network-error`. Each row
// runs the real helper with the API removed and holds that the request still
// goes out under a signal that fires a `TimeoutError`.

const AUTHN = "https://authn.example.test";
const WS_URL = "ws://127.0.0.1:43210/rpc";
const nativeTimeout = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");

interface Site {
  readonly name: string;
  readonly run: () => Promise<unknown>;
}

const SITES: readonly Site[] = [
  {
    name: "auth-validation fetchUserResponse (validateAuthTokenIdentityAccessOnly)",
    run: () => validateAuthTokenIdentityAccessOnly(AUTHN, "token"),
  },
  {
    name: "auth-validation validateAuthTokenIdentityAccessOnceAbortable",
    run: () =>
      validateAuthTokenIdentityAccessOnceAbortable({
        authnBaseUrl: AUTHN,
        token: "token",
        signal: null,
      }),
  },
  {
    name: "auth-validation refreshOnceAbortable",
    run: () =>
      refreshOnceAbortable({
        authnBaseUrl: AUTHN,
        token: "token",
        refreshToken: "refresh",
        clientKind: null,
        signal: null,
      }),
  },
  {
    name: "auth-validation exchangeCodeForTokens",
    run: () => exchangeCodeForTokens(AUTHN, "code", "verifier"),
  },
  {
    name: "devices-sessions-fetcher requestSignal (no caller signal)",
    run: () => listUserSessionsViaHttp(AUTHN, "token", null),
  },
  {
    name: "devices-sessions-fetcher requestSignal (caller signal)",
    run: () =>
      listUserSessionsViaHttp(AUTHN, "token", new AbortController().signal),
  },
  {
    name: "push-token-fetcher postPushTokens (register)",
    run: () =>
      registerDevicePushTokenViaHttp(AUTHN, "token", {
        token: "apns",
        platform: "ios",
        environment: "production",
      }),
  },
  {
    name: "push-token-fetcher postPushTokens (remove)",
    run: () => removeDevicePushTokenViaHttp(AUTHN, "token", "apns"),
  },
  {
    name: "remote-fetcher fetchRegisteredHostsViaHttp",
    run: () => fetchRegisteredHostsViaHttp(AUTHN, "token"),
  },
  {
    name: "host-activity-probe probeHostActivityBusy",
    run: () => probeHostActivityBusy(WS_URL),
  },
  {
    name: "host-activity-probe probeHostActivity",
    run: () => probeHostActivity(WS_URL),
  },
  {
    name: "host-activity-probe probeHostReachable",
    run: () => probeHostReachable(WS_URL),
  },
  {
    name: "host-deregister-fetcher deregisterHostViaHttp",
    run: () => deregisterHostViaHttp(AUTHN, "token", "host-1"),
  },
  {
    name: "host-version-policy-fetcher updateHostVersionPolicyViaHttp",
    run: () =>
      updateHostVersionPolicyViaHttp(AUTHN, "token", "host-1", {
        updatePolicy: undefined,
        desiredVersion: null,
        force: undefined,
      }),
  },
  {
    name: "grant-client mintAttachGrantViaHttp",
    run: () => mintAttachGrantViaHttp(AUTHN, "host-1", "token"),
  },
];

let signals: AbortSignal[];

beforeEach(() => {
  signals = [];
  Object.defineProperty(AbortSignal, "timeout", {
    value: undefined,
    writable: true,
    configurable: true,
  });
  vi.useFakeTimers();
  // Like a real fetch: pending until its signal aborts, then rejecting with
  // the signal's reason.
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_input: RequestInfo | URL, init: RequestInit | undefined) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!(signal instanceof AbortSignal)) {
            reject(new Error("request went out without an AbortSignal"));
            return;
          }
          signals.push(signal);
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    ),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (nativeTimeout === undefined) {
    Reflect.deleteProperty(AbortSignal, "timeout");
  } else {
    Object.defineProperty(AbortSignal, "timeout", nativeTimeout);
  }
});

describe("fetch helpers without AbortSignal.timeout", () => {
  it.each(SITES)(
    "$name sends its request under a timeout signal",
    async (site) => {
      const settled = site.run().then(
        () => "resolved",
        () => "rejected",
      );
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await settled;

      expect(signals.length).toBeGreaterThan(0);
      for (const signal of signals) {
        expect(signal.aborted).toBe(true);
        expect(signal.reason).toMatchObject({ name: "TimeoutError" });
      }
    },
  );
});

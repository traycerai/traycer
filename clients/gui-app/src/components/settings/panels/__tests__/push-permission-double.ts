import type {
  IPushPermissionHost,
  PushPermissionState,
  PushRegistrationState,
  PushSeverity,
} from "@traycer-clients/shared/platform/runner-host";

export interface PushPermissionDouble {
  readonly host: IPushPermissionHost;
  readonly calls: {
    get: number;
    request: number;
    openSettings: number;
    retry: number;
  };
  /** Move the OS's answer without telling the GUI - as the OS itself does. */
  readonly setState: (next: PushPermissionState) => void;
  /** Move the registration result the row reads beside the OS permission. */
  readonly setRegistration: (next: PushRegistrationState) => void;
  /** The host's "this MAY have changed, re-read it" edge. */
  readonly fireChange: () => void;
  /** Finishes a Retry that was held pending, as the phone's upload settling. */
  readonly finishRetry: (next: PushRegistrationState) => void;
  /** Lets a deferred `openSettings()` finish, ending the pending state. */
  readonly resolveOpenSettings: () => void;
  /** Each `setMutedSeverities` call's set, in call order. */
  readonly setCalls: PushSeverity[][];
  /** What the phone has stored for the current account. */
  readonly setStoredMuted: (next: readonly PushSeverity[]) => void;
  /** The account the phone answers for, like its login session. */
  readonly setAccount: (accountId: string) => void;
  /** Holds every `getMutedSeverities` unresolved until `releaseReads()`. */
  readonly holdReads: () => void;
  readonly releaseReads: () => void;
  /** Holds the next `setMutedSeverities` unresolved until `releaseSet()`. */
  readonly holdNextSet: () => void;
  readonly releaseSet: () => void;
}

/**
 * Stands in for the phone's `IPushPermissionHost`. It behaves like the OS in
 * the one way that matters here: `onChange` carries no state, so a subscriber
 * only learns the new value by asking again.
 */
export function createPushPermissionDouble(options: {
  readonly initial: PushPermissionState;
  /** State `request()` resolves with, i.e. what the OS prompt returned. */
  readonly requestResolvesWith: PushPermissionState;
  readonly getRejectsWith: string | null;
  /**
   * Hold `openSettings()` unresolved until `resolveOpenSettings()`. Jumping to
   * the OS Settings app is the slowest thing this row does, so it is where the
   * pending UX actually shows up.
   */
  readonly deferOpenSettings: boolean;
  /**
   * What the phone reports for the registration beside the OS permission.
   * Omitted: a granted permission is already registered, and every other
   * permission has not registered.
   */
  readonly registration?: PushRegistrationState;
  /** Hold `retryRegistration()` until `finishRetry()`, so the row can be read mid-retry. */
  readonly holdRetry?: boolean;
}): PushPermissionDouble {
  const calls = { get: 0, request: 0, openSettings: 0, retry: 0 };
  const handlers = new Set<() => void>();
  let state = options.initial;
  let registration: PushRegistrationState =
    options.registration ??
    (options.initial === "granted" ? "registered" : "pending");
  let finishHeldRetry: (next: PushRegistrationState) => void = () => undefined;
  let releaseOpenSettings: () => void = () => undefined;
  const openSettingsGate = new Promise<void>((resolve) => {
    releaseOpenSettings = resolve;
  });
  const setCalls: PushSeverity[][] = [];
  const mutedByAccount = new Map<string, readonly PushSeverity[]>();
  let account = "user-a";
  let readGate: Promise<void> | null = null;
  let releaseReadGate: () => void = () => undefined;
  let setGate: Promise<void> | null = null;
  let releaseSetGate: () => void = () => undefined;
  const host: IPushPermissionHost = {
    get: () => {
      calls.get += 1;
      if (options.getRejectsWith !== null) {
        return Promise.reject(new Error(options.getRejectsWith));
      }
      return Promise.resolve(state);
    },
    getRegistrationState: () => registration,
    retryRegistration: () => {
      calls.retry += 1;
      if (options.holdRetry === true) {
        registration = "pending";
        notify();
        return new Promise<void>((resolve) => {
          finishHeldRetry = (next) => {
            registration = next;
            notify();
            resolve();
          };
        });
      }
      registration = "registered";
      notify();
      return Promise.resolve();
    },
    request: () => {
      calls.request += 1;
      state = options.requestResolvesWith;
      if (state === "granted") registration = "registered";
      return Promise.resolve(state);
    },
    openSettings: () => {
      calls.openSettings += 1;
      if (options.deferOpenSettings) return openSettingsGate;
      return Promise.resolve();
    },
    getMutedSeverities: async () => {
      const readFor = account;
      if (readGate !== null) await readGate;
      return mutedByAccount.get(readFor) ?? [];
    },
    // Like the phone: store the set, then say "re-read" through `onChange`.
    setMutedSeverities: async (set) => {
      setCalls.push([...set]);
      if (setGate !== null) await setGate;
      mutedByAccount.set(account, [...set]);
      for (const handler of Array.from(handlers)) handler();
    },
    onChange: (handler) => {
      handlers.add(handler);
      return {
        dispose: () => {
          handlers.delete(handler);
        },
      };
    },
  };
  function notify(): void {
    for (const handler of Array.from(handlers)) handler();
  }
  return {
    host,
    calls,
    setState: (next) => {
      state = next;
    },
    setRegistration: (next) => {
      registration = next;
    },
    fireChange: () => {
      notify();
    },
    finishRetry: (next) => {
      finishHeldRetry(next);
    },
    resolveOpenSettings: () => {
      releaseOpenSettings();
    },
    setCalls,
    setStoredMuted: (next) => {
      mutedByAccount.set(account, next);
    },
    setAccount: (accountId) => {
      account = accountId;
    },
    holdReads: () => {
      readGate = new Promise<void>((resolve) => {
        releaseReadGate = resolve;
      });
    },
    releaseReads: () => {
      releaseReadGate();
      readGate = null;
    },
    holdNextSet: () => {
      setGate = new Promise<void>((resolve) => {
        releaseSetGate = resolve;
      });
    },
    releaseSet: () => {
      releaseSetGate();
    },
  };
}

export function doubleFor(initial: PushPermissionState): PushPermissionDouble {
  return createPushPermissionDouble({
    initial,
    requestResolvesWith: initial,
    getRejectsWith: null,
    deferOpenSettings: false,
  });
}

import { app } from "electron";
import { join } from "node:path";
import {
  createJsonFileStore,
  type StrictJsonFileStore,
} from "./json-file-store";

const STORE_FILE_NAME = "update-preferences.json";

interface UpdatePreferences {
  readonly allowPrerelease: boolean;
}

export interface UpdateChannelSnapshot {
  readonly allowPrerelease: boolean;
  readonly generation: number;
}

export const UPDATE_PREFERENCE_PERSISTENCE_ERROR_CODE =
  "update-preference-persistence-failed";

export class UpdatePreferencePersistenceError extends Error {
  readonly code = UPDATE_PREFERENCE_PERSISTENCE_ERROR_CODE;
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("Failed to persist update preferences");
    this.name = "UpdatePreferencePersistenceError";
    this.cause = cause;
  }
}

export function isUpdatePreferencePersistenceError(
  error: unknown,
): error is UpdatePreferencePersistenceError {
  return (
    error instanceof UpdatePreferencePersistenceError &&
    error.code === UPDATE_PREFERENCE_PERSISTENCE_ERROR_CODE
  );
}

const DEFAULT_PREFERENCES: UpdatePreferences = { allowPrerelease: false };

let preferences = DEFAULT_PREFERENCES;
let hydration: Promise<UpdatePreferences> | null = null;
let store: StrictJsonFileStore<UpdatePreferences> | null = null;
let channelGeneration = 0;
let preferenceMutationQueue: Promise<void> = Promise.resolve();

function parsePreferences(value: unknown): UpdatePreferences {
  if (value !== null && typeof value === "object") {
    return {
      allowPrerelease: Reflect.get(value, "allowPrerelease") === true,
    };
  }
  return DEFAULT_PREFERENCES;
}

function getStore() {
  store ??= createJsonFileStore<UpdatePreferences>(
    join(app.getPath("userData"), STORE_FILE_NAME),
    DEFAULT_PREFERENCES,
    parsePreferences,
  );
  return store;
}

/**
 * Loads the machine-local update preference before launch-time host and
 * desktop probes run. The synchronous reader below deliberately remains
 * default-off until this resolves so an unreadable or legacy store can never
 * opt a user into prereleases.
 */
export function hydrateUpdatePreferences(): Promise<UpdatePreferences> {
  if (hydration !== null) return hydration;
  hydration = getStore()
    .load()
    .then((loaded) => {
      preferences = loaded;
      return loaded;
    });
  return hydration;
}

export function prereleaseUpdatesEnabled(): boolean {
  return preferences.allowPrerelease;
}

/**
 * Captures the update channel and its process-local epoch. The epoch advances
 * only after a durable, actual channel transition, so A → B → A cannot make
 * work captured under the first A look current again.
 */
export function getUpdateChannelSnapshot(): UpdateChannelSnapshot {
  return {
    allowPrerelease: preferences.allowPrerelease,
    generation: channelGeneration,
  };
}

export function setPrereleaseUpdatesEnabled(
  allowPrerelease: boolean,
): Promise<boolean> {
  const mutation = preferenceMutationQueue.then(async () => {
    await hydrateUpdatePreferences();
    if (preferences.allowPrerelease === allowPrerelease) return;
    const next = { allowPrerelease };
    try {
      await getStore().saveStrict(next);
    } catch (err) {
      throw new UpdatePreferencePersistenceError(err);
    }
    preferences = next;
    channelGeneration += 1;
  });
  preferenceMutationQueue = mutation.then(
    () => undefined,
    () => undefined,
  );
  return mutation.then(() => allowPrerelease);
}

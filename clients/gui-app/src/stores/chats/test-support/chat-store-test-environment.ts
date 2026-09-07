import type { RuntimeEnvironment } from "@traycer-clients/shared/replica-runtime";

/**
 * Injected into `createChatSessionStore` from tests so the store factory
 * never builds a renderer environment.
 */
export const CHAT_STORE_TEST_ENVIRONMENT: RuntimeEnvironment = {
  clock: {
    now(): number {
      return 0;
    },
  },
  scheduler: {
    schedule() {
      return { cancel(): void {} };
    },
    scheduleMicrotask(): void {},
  },
  logger: {
    debug(): void {},
    warn(): void {},
    error(): void {},
  },
};

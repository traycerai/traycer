export interface CallEvents {
  emit(): void;
  waitFor(callNumber: number): Promise<void>;
}

export function createCallEvents(): CallEvents {
  let emittedCalls = 0;
  const waiters = new Map<number, Array<() => void>>();
  return {
    emit(): void {
      emittedCalls += 1;
      for (const resolve of waiters.get(emittedCalls) ?? []) resolve();
      waiters.delete(emittedCalls);
    },
    waitFor(callNumber: number): Promise<void> {
      if (emittedCalls >= callNumber) return Promise.resolve();
      return new Promise((resolve) => {
        const listeners = waiters.get(callNumber) ?? [];
        listeners.push(resolve);
        waiters.set(callNumber, listeners);
      });
    },
  };
}

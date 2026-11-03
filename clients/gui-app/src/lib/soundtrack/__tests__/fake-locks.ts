/**
 * The one exclusive, first-come lock `holdSoundtrackSessionLock` asks for, shared
 * by every window in a test as one app origin's Web Locks are.
 */
export class FakeLockManager {
  private held = false;
  private readonly waiting: Array<() => void> = [];

  request(_name: string, granted: () => Promise<void>): Promise<void> {
    return new Promise((resolve) => {
      const grant = (): void => {
        this.held = true;
        void granted().then(() => {
          this.held = false;
          this.waiting.shift()?.();
          resolve();
        });
      };
      if (this.held) this.waiting.push(grant);
      else grant();
    });
  }
}

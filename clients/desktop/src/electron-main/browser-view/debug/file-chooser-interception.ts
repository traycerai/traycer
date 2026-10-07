import { describeLogError, log } from "../../app/logger";

export interface FileChooserInterceptionTarget {
  /** Whether the target is still attached and can take a command. */
  readonly live: () => boolean;
  /** Whether this target should intercept file choosers right now. */
  readonly desired: () => boolean;
  readonly send: (enabled: boolean) => Promise<unknown>;
}

/**
 * One CDP target's `Page.setInterceptFileChooserDialog` setting.
 *
 * The setting lives in the target, so the root page and every out-of-process
 * iframe session each carry their own. Commands for one target go out one at a
 * time, and what the target holds is recorded only when its command succeeded:
 * Electron promises no ordering between concurrent `sendCommand` calls, so two
 * overlapping updates could leave a target on the older reading with a record
 * that says otherwise and nothing left to correct it. The reading is taken
 * again after every command, so an edge that arrived while one was in flight
 * is applied rather than lost.
 */
export class FileChooserInterception {
  private readonly target: FileChooserInterceptionTarget;
  /**
   * What the target holds. A fresh attachment intercepts nothing, so a tab
   * that is on screen costs no command at all.
   */
  private applied = false;
  private attachment = 0;
  private converging = false;
  private settled: Promise<void> = Promise.resolve();

  constructor(target: FileChooserInterceptionTarget) {
    this.target = target;
  }

  /**
   * Brings the target in line with its reading. Never rejects: a target that
   * refuses the command is still driven, and the cost of the refusal is the
   * picker this exists to prevent. A refused command is not retried here; the
   * record still says what the target holds, so the next edge sends it again.
   */
  sync(): Promise<void> {
    if (!this.converging) this.settled = this.converge();
    return this.settled;
  }

  /** The target detached and took its setting with it. */
  reset(): void {
    this.applied = false;
    this.attachment += 1;
  }

  private async converge(): Promise<void> {
    this.converging = true;
    try {
      while (this.target.live()) {
        const enabled = this.target.desired();
        if (enabled === this.applied) return;
        const attachment = this.attachment;
        try {
          await this.target.send(enabled);
        } catch (err) {
          // A command that died with its attachment says nothing about the
          // next one, which still needs its reading applied.
          if (attachment !== this.attachment) continue;
          log.warn("[browser-view] file chooser interception failed", {
            enabled,
            error: describeLogError(err),
          });
          return;
        }
        if (attachment === this.attachment) this.applied = enabled;
      }
    } finally {
      this.converging = false;
    }
  }
}

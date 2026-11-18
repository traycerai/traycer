import {
  advanceMigrationJournal,
  beginMigrationJournal,
  type MigrationCoordinatorLock,
  type ProcessIncarnationProbe,
} from "@traycer/protocol/config/data-migration-admission";
import type { MigrationJournal } from "@traycer/protocol/config/data-migration-contracts";
import type { EngineCheckpoint } from "./engine-types";

/**
 * The one writer of a transaction's journal inside the engine. Every change
 * becomes the next revision through `advanceMigrationJournal` (admission
 * mutex, phase table, activation boundary, coordinator binding), with a crash
 * checkpoint on each side of the durable write. The in-memory journal is
 * replaced only after the write landed, so the engine never acts on a
 * revision that is not on disk.
 */
export class JournalSession {
  private current: MigrationJournal;

  private constructor(
    private readonly bootstrapDir: string,
    private readonly lock: MigrationCoordinatorLock,
    private readonly probe: ProcessIncarnationProbe,
    private readonly checkpoint: (point: EngineCheckpoint) => Promise<void>,
    private readonly now: () => string,
    journal: MigrationJournal,
  ) {
    this.current = journal;
  }

  /** Writes revision 1 (planned) and selects it as the active transaction. */
  static async begin(input: {
    readonly bootstrapDir: string;
    readonly lock: MigrationCoordinatorLock;
    readonly probe: ProcessIncarnationProbe;
    readonly checkpoint: (point: EngineCheckpoint) => Promise<void>;
    readonly now: () => string;
    readonly journal: MigrationJournal;
  }): Promise<JournalSession> {
    await input.checkpoint("before-journal:planned");
    await beginMigrationJournal({
      bootstrapDir: input.bootstrapDir,
      coordinator: input.lock,
      journal: input.journal,
    });
    await input.checkpoint("after-journal:planned");
    return new JournalSession(
      input.bootstrapDir,
      input.lock,
      input.probe,
      input.checkpoint,
      input.now,
      input.journal,
    );
  }

  /**
   * Continue an existing active journal. The first write binds it to this
   * coordinator incarnation (a recovering process replaces a dead one).
   */
  static resume(input: {
    readonly bootstrapDir: string;
    readonly lock: MigrationCoordinatorLock;
    readonly probe: ProcessIncarnationProbe;
    readonly checkpoint: (point: EngineCheckpoint) => Promise<void>;
    readonly now: () => string;
    readonly journal: MigrationJournal;
  }): JournalSession {
    return new JournalSession(
      input.bootstrapDir,
      input.lock,
      input.probe,
      input.checkpoint,
      input.now,
      input.journal,
    );
  }

  get journal(): MigrationJournal {
    return this.current;
  }

  get coordinatorLock(): MigrationCoordinatorLock {
    return this.lock;
  }

  /** Whether the durable journal already names this coordinator. */
  get boundToThisCoordinator(): boolean {
    const recorded = this.current.coordinator;
    const mine = this.lock.incarnation;
    return (
      recorded !== null &&
      recorded.pid === mine.pid &&
      recorded.lockNonce === mine.lockNonce &&
      recorded.startIdentity === mine.startIdentity
    );
  }

  /**
   * Persist `changes` as the next revision. `revision`, `updatedAt`,
   * `coordinator` and `activationRevision` (set exactly by the revision that
   * records `activated`) are filled here.
   */
  async advance(
    changes: Partial<
      Omit<
        MigrationJournal,
        | "revision"
        | "updatedAt"
        | "coordinator"
        | "activationRevision"
        | "id"
        | "version"
      >
    >,
  ): Promise<MigrationJournal> {
    const expected = this.current;
    const phase = changes.phase ?? expected.phase;
    const revision = expected.revision + 1;
    const next: MigrationJournal = {
      ...expected,
      ...changes,
      revision,
      updatedAt: this.now(),
      coordinator: this.lock.incarnation,
      activationRevision:
        phase === "activated" && expected.phase !== "activated"
          ? revision
          : expected.activationRevision,
    };
    await this.checkpoint(`before-journal:${phase}`);
    await advanceMigrationJournal({
      bootstrapDir: this.bootstrapDir,
      coordinator: this.lock,
      probe: this.probe,
      expected,
      next,
    });
    this.current = next;
    await this.checkpoint(`after-journal:${phase}`);
    return next;
  }

  /** Binds the journal to this coordinator without changing anything else. */
  async bind(): Promise<MigrationJournal> {
    return this.boundToThisCoordinator ? this.current : this.advance({});
  }
}

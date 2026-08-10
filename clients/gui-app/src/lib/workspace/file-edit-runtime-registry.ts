import { indexedDbFileEditRecoveryJournal } from "@/lib/workspace/file-edit-recovery-store";
import {
  FILE_EDIT_AUTOSAVE_DELAY_MS,
  FILE_EDIT_RECOVERY_DELAY_MS,
  FileEditRuntime,
  fileEditIdentityKey,
  type FileEditDiskSnapshot,
  type FileEditIdentity,
  type FileEditRecoveryJournal,
  type FileEditRuntimeOptions,
  type FileEditWriter,
} from "@/lib/workspace/file-edit-runtime";

export interface FileEditRuntimeAttachment {
  readonly runtime: FileEditRuntime;
  readonly detach: () => void;
  readonly updateWriter: (writer: FileEditWriter | null) => boolean;
}

export interface AttachFileEditRuntimeArgs {
  readonly identity: FileEditIdentity;
  readonly initialDisk: FileEditDiskSnapshot;
  readonly surfaceId: string;
  readonly writer: FileEditWriter | null;
}

export class FileEditRuntimeRegistry {
  private readonly runtimes = new Map<string, FileEditRuntime>();

  constructor(
    private readonly journal: FileEditRecoveryJournal,
    private readonly options: FileEditRuntimeOptions,
  ) {}

  getOrCreate(
    identity: FileEditIdentity,
    initialDisk: FileEditDiskSnapshot,
  ): FileEditRuntime {
    const key = fileEditIdentityKey(identity);
    const existing = this.runtimes.get(key);
    if (existing !== undefined) {
      existing.refreshCleanDisk(initialDisk);
      return existing;
    }

    const runtime = new FileEditRuntime(identity, initialDisk, {
      journal: this.journal,
      options: this.options,
      onDisposable: () => {
        if (this.runtimes.get(key) === runtime && runtime.canDispose()) {
          this.runtimes.delete(key);
        }
      },
    });
    this.runtimes.set(key, runtime);
    return runtime;
  }

  attach(args: AttachFileEditRuntimeArgs): FileEditRuntimeAttachment {
    const runtime = this.getOrCreate(args.identity, args.initialDisk);
    const lease = runtime.attachSurface(args.surfaceId, args.writer);
    let attached = true;
    return {
      runtime,
      detach: () => {
        if (!attached) return;
        attached = false;
        runtime.detachSurface(args.surfaceId, lease);
        const key = fileEditIdentityKey(args.identity);
        if (this.runtimes.get(key) === runtime && runtime.canDispose()) {
          this.runtimes.delete(key);
        }
      },
      updateWriter: (writer) =>
        attached && runtime.updateWriter(args.surfaceId, lease, writer),
    };
  }

  get(identity: FileEditIdentity): FileEditRuntime | null {
    return this.runtimes.get(fileEditIdentityKey(identity)) ?? null;
  }

  flushRecovery(): Promise<void> {
    return Promise.all(
      Array.from(this.runtimes.values(), (runtime) => runtime.flushRecovery()),
    ).then(() => undefined);
  }

  teardown(): Promise<void> {
    const recoveries = Array.from(this.runtimes.values(), (runtime) =>
      runtime.teardown(),
    );
    this.runtimes.clear();
    // `allSettled`, not `all`: every caller (sign-out/user-switch teardown,
    // the local-state wipe) either discards this promise or awaits it without
    // a `.catch`. One runtime's rejected teardown must not fail the whole
    // aggregate and surface as an unhandled rejection or abort an unrelated
    // caller's flow.
    return Promise.allSettled(recoveries).then(() => undefined);
  }

  resetForTesting(): void {
    void this.teardown();
  }
}

const defaultOptions: FileEditRuntimeOptions = {
  autosaveDelayMs: FILE_EDIT_AUTOSAVE_DELAY_MS,
  recoveryDelayMs: FILE_EDIT_RECOVERY_DELAY_MS,
  now: () => Date.now(),
};

export const fileEditRuntimeRegistry = new FileEditRuntimeRegistry(
  indexedDbFileEditRecoveryJournal,
  defaultOptions,
);

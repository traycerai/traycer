import type {
  DurableBytes,
  FileReadResult,
} from "@traycer-clients/shared/host-lifecycle/durable/decoder";
import { fileReadToDurableBytes } from "@traycer-clients/shared/host-lifecycle/durable/decoder";
import type { DurableRecord } from "@traycer-clients/shared/host-lifecycle/evidence";
import type {
  DurableBytes as ProtocolDurableBytes,
  DurableRecord as ProtocolDurableRecord,
} from "@traycer/protocol/config/host-update-attempt";
import type { HostUpdateAttemptRecord } from "./record";

// Total decode of `update-attempt.json`.
//
// THE DECODER MOVED to `@traycer/protocol/config/host-update-attempt`, for
// the reason given in `./record`: `traycer-host` reads this same file and
// cannot import this package. This module is the client-facing re-export.
//
// The VOCABULARY deliberately did not move with it. `DurableBytes`,
// `FileReadResult`, and `fileReadToDurableBytes` still come from the
// lifecycle layer here, and `HostUpdateAttemptRead` is still spelled with the
// lifecycle `DurableRecord`, so every type this module exports is byte-for-byte
// the type it exported before. The protocol module declares its own
// structurally identical pair (it cannot import the lifecycle layer either),
// and the two are mutually assignable - so the decoder accepts the lifecycle
// `DurableBytes` a client hands it with no adapter, and no client-side type
// changed to make that work.

export type HostUpdateAttemptRead = DurableRecord<HostUpdateAttemptRecord>;

export type { DurableBytes, FileReadResult };
export { fileReadToDurableBytes };

export { decodeHostUpdateAttempt } from "@traycer/protocol/config/host-update-attempt";

// The "mutually assignable" claim above, enforced at compile time. The
// protocol module cannot import the lifecycle layer (nor vice versa), so
// nothing structural stops the two copies from drifting — only this
// assertion does. If either side changes shape unilaterally, this line stops
// compiling instead of `decodeHostUpdateAttempt` quietly rejecting the
// lifecycle `DurableBytes` a client hands it.
type MutuallyAssignable<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never;
const _durableVocabularyAgrees: [
  MutuallyAssignable<DurableBytes, ProtocolDurableBytes>,
  MutuallyAssignable<
    DurableRecord<HostUpdateAttemptRecord>,
    ProtocolDurableRecord<HostUpdateAttemptRecord>
  >,
] = [true, true];
void _durableVocabularyAgrees;

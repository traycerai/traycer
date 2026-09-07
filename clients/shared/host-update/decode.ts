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
// The decoder moved to `@traycer/protocol/config/host-update-attempt`, for the reason given in `./record`: `traycer-host` reads this same file and cannot import this package.

export type HostUpdateAttemptRead = DurableRecord<HostUpdateAttemptRecord>;

export type { DurableBytes, FileReadResult };
export { fileReadToDurableBytes };

export { decodeHostUpdateAttempt } from "@traycer/protocol/config/host-update-attempt";

// The "mutually assignable" claim above, enforced at compile time.
// The protocol module cannot import the lifecycle layer (nor vice versa), so nothing structural stops the two copies from drifting - only this assertion does.
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

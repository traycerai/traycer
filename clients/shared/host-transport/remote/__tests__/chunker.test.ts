import {
  ChunkReassembler,
  ChunkReassemblyError,
} from "@traycer/protocol/host-transport/chunking";
import { runChunkReassemblerConformanceSpec } from "@traycer/protocol/host-transport/__tests__/chunk-reassembler-conformance";

runChunkReassemblerConformanceSpec(
  () => new ChunkReassembler(undefined),
  ChunkReassemblyError,
);

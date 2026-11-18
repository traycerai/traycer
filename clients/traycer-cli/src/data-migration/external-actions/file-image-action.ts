import { z } from "zod";
import type {
  ExternalAction,
  ExternalActionKind,
  ObjectFingerprint,
} from "@traycer/protocol/config/data-migration-contracts";
import {
  compareAndSetFileImage,
  decodeImage,
  encodeImage,
  externalActionId,
  fileImageFingerprint,
  readFileImage,
  type ExternalActionStage,
} from "./ledger";

/**
 * One file replaced as an exact byte image: the destination copy of the
 * hidden host launcher (`host-start-hidden.vbs`) regenerated for the
 * destination CLI. Before/after are the exact bytes; the inverse writes the
 * recorded before bytes back (or removes a file that did not exist).
 */
export const FILE_IMAGE_ADAPTER = "file-image";

const stageSchema = z.enum(["quiesce", "prepare", "activate"]);

export const fileImageForwardSchema = z.strictObject({
  adapter: z.literal(FILE_IMAGE_ADAPTER),
  version: z.literal(1),
  stage: stageSchema,
  path: z.string().min(1),
  /** Base64 of the after image; `null` removes the file. */
  image: z.string().nullable(),
});

export const fileImageInverseSchema = z.strictObject({
  adapter: z.literal(FILE_IMAGE_ADAPTER),
  version: z.literal(1),
  image: z.string().nullable(),
});

export function planFileImageAction(input: {
  readonly kind: ExternalActionKind;
  readonly stage: ExternalActionStage;
  readonly path: string;
  readonly before: Buffer | null;
  readonly after: Buffer | null;
}): ExternalAction {
  return {
    id: externalActionId("file", input.stage, input.path),
    kind: input.kind,
    object: input.path,
    before: fileImageFingerprint(input.before),
    after: fileImageFingerprint(input.after),
    forward: {
      adapter: FILE_IMAGE_ADAPTER,
      version: 1,
      stage: input.stage,
      path: input.path,
      image: encodeImage(input.after),
    },
    inverse: {
      adapter: FILE_IMAGE_ADAPTER,
      version: 1,
      image: encodeImage(input.before),
    },
    state: "planned",
  };
}

export async function observeFileImage(
  action: ExternalAction,
): Promise<ObjectFingerprint> {
  const forward = fileImageForwardSchema.parse(action.forward);
  return fileImageFingerprint(await readFileImage(forward.path));
}

export async function applyFileImage(action: ExternalAction): Promise<void> {
  const forward = fileImageForwardSchema.parse(action.forward);
  const inverse = fileImageInverseSchema.parse(action.inverse);
  await compareAndSetFileImage(
    forward.path,
    decodeImage(inverse.image),
    decodeImage(forward.image),
  );
}

export async function invertFileImage(action: ExternalAction): Promise<void> {
  const forward = fileImageForwardSchema.parse(action.forward);
  const inverse = fileImageInverseSchema.parse(action.inverse);
  await compareAndSetFileImage(
    forward.path,
    decodeImage(forward.image),
    decodeImage(inverse.image),
  );
}

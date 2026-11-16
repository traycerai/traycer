import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

/** Inert carrier retained only to parse released request shapes. */
export const releasedExecutableWriteGrantSchema = lazySchema(() =>
  z.string().min(1).max(8192).nullable(),
);

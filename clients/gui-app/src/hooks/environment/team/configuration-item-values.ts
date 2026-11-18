import { z } from "zod";

export const configurationTextValueSchema = z.object({ value: z.string() });
export const configurationShellValueSchema = z.object({
  path: z.string(),
  args: z.array(z.string()),
});
export const configurationProfileValueSchema = z.object({
  name: z.string(),
  color: z.string().nullable(),
  harnessId: z.string(),
  accountIdentity: z.string().nullable(),
  needsLink: z.boolean(),
  enabled: z.boolean(),
});
export const configurationPackValueSchema = z.object({
  pinnedVersion: z.string().nullable(),
  autoDownload: z.boolean(),
});
export const configurationPolicyValueSchema = z.object({ body: z.string() });

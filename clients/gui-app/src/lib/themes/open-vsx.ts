import { z } from "zod";
import type { ThemeDefinition } from "@/lib/themes/theme-definition";
import {
  importVerifiedThemePackage,
  MAX_THEME_PACKAGE_BYTES,
} from "@/lib/themes/theme-import";

const API = "https://open-vsx.org/api";
const identitySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
const extensionSchema = z.object({
  namespace: identitySchema,
  name: identitySchema,
  version: z.string().min(1).max(128),
  displayName: z.string().max(256).optional(),
  description: z.string().max(10000).optional(),
  downloadCount: z.number().nonnegative().optional(),
  files: z
    .object({
      icon: z.string().optional(),
      download: z.string().optional(),
      sha256: z.string().optional(),
    })
    .optional(),
});
export interface OpenVsxExtension {
  id: string;
  name: string;
  publisher: string;
  description: string;
  downloadCount: number;
  iconUrl: string | null;
  version: string;
}

function trustedUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.origin === "https://open-vsx.org" &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

async function readResponse(
  url: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const response = await fetch(url, {
    signal,
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  return readCappedResponse(response, maxBytes);
}

async function readCappedResponse(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!response.ok)
    throw new Error(`Open VSX request failed (${response.status}).`);
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw new Error("The Open VSX response exceeds the import size limit.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Open VSX returned an empty response.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (
      let result = await reader.read();
      !result.done;
      result = await reader.read()
    ) {
      size += result.value.byteLength;
      if (size > maxBytes)
        throw new Error("The Open VSX response exceeds the import size limit.");
      chunks.push(result.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseExtension(value: unknown): OpenVsxExtension | null {
  const result = extensionSchema.safeParse(value);
  if (!result.success) return null;
  const extension = result.data;
  return {
    id: `${extension.namespace}.${extension.name}`,
    name: extension.displayName ?? extension.name,
    publisher: extension.namespace,
    description: extension.description ?? "",
    downloadCount: extension.downloadCount ?? 0,
    iconUrl: trustedUrl(extension.files?.icon),
    version: extension.version,
  };
}

async function lookupOpenVsxIdentity(
  namespace: string,
  name: string,
  signal: AbortSignal,
): Promise<OpenVsxExtension | null> {
  try {
    const detail = await fetch(
      `${API}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`,
      {
        signal,
        credentials: "omit",
        referrerPolicy: "no-referrer",
      },
    );
    if (!detail.ok) {
      await detail.body?.cancel();
      return null;
    }
    const bytes = await readCappedResponse(detail, 512 * 1024);
    return parseExtension(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    signal.throwIfAborted();
    return null;
  }
}

export async function searchOpenVsxThemes(
  query: string,
  sort: "downloadCount" | "rating" | "timestamp" | "relevance",
  signal: AbortSignal,
): Promise<OpenVsxExtension[]> {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
  const identity = /^([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)$/.exec(query.trim());
  if (identity) {
    const extension = await lookupOpenVsxIdentity(
      identity[1],
      identity[2],
      requestSignal,
    );
    if (extension) return [extension];
  }
  const url = new URL(`${API}/-/search`);
  url.search = new URLSearchParams({
    query: query.trim().slice(0, 256),
    category: "Themes",
    sortBy: sort,
    sortOrder: "desc",
    size: "12",
  }).toString();
  const bytes = await readResponse(url.href, 512 * 1024, requestSignal);
  const response = z
    .object({ extensions: z.array(z.unknown()).max(100) })
    .parse(JSON.parse(new TextDecoder().decode(bytes)));
  return response.extensions.flatMap((value) => {
    const extension = parseExtension(value);
    return extension ? [extension] : [];
  });
}

export async function installOpenVsxTheme(
  extension: OpenVsxExtension,
  signal: AbortSignal,
): Promise<ThemeDefinition[]> {
  const [namespace, name, ...extra] = extension.id.split(".");
  if (
    extra.length ||
    !identitySchema.safeParse(namespace).success ||
    !identitySchema.safeParse(name).success
  ) {
    throw new Error("Invalid Open VSX extension identity.");
  }
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(60000)]);
  const detailBytes = await readResponse(
    `${API}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/${encodeURIComponent(extension.version)}`,
    512 * 1024,
    requestSignal,
  );
  const detail = extensionSchema.parse(
    JSON.parse(new TextDecoder().decode(detailBytes)),
  );
  if (
    detail.namespace !== namespace ||
    detail.name !== name ||
    detail.version !== extension.version
  )
    throw new Error("Open VSX returned a different extension.");
  const downloadUrl = trustedUrl(detail.files?.download);
  const checksumUrl = trustedUrl(detail.files?.sha256);
  if (!downloadUrl || !checksumUrl)
    throw new Error("Open VSX did not provide a valid download URL.");
  const [bytes, checksumBytes] = await Promise.all([
    readResponse(downloadUrl, MAX_THEME_PACKAGE_BYTES, requestSignal),
    readResponse(checksumUrl, 4096, requestSignal),
  ]);
  const checksum = /^([a-f0-9]{64})(?:\s|$)/i
    .exec(new TextDecoder().decode(checksumBytes).trim())?.[1]
    ?.toLowerCase();
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  const actual = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (!checksum || checksum !== actual)
    throw new Error(
      "The downloaded theme pack failed its checksum check. Try downloading it again.",
    );
  requestSignal.throwIfAborted();
  const themes = await importVerifiedThemePackage(
    bytes,
    {
      publisher: namespace,
      name,
      version: extension.version,
    },
    requestSignal,
  );
  requestSignal.throwIfAborted();
  return themes.map((theme) => ({
    ...theme,
    collection: {
      id: `open-vsx:${extension.id}`,
      name: extension.name.slice(0, 100),
    },
  }));
}

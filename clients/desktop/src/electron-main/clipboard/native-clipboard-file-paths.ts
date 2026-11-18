import { fileURLToPath } from "node:url";

export const NATIVE_FILE_CLIPBOARD_FORMATS = [
  "code/file-list",
  "public.file-url",
  "NSFilenamesPboardType",
] as const;

export interface NativeClipboardBufferReader {
  readBuffer(format: string): Buffer;
}

interface BinaryPlistContext {
  readonly bytes: Uint8Array;
  readonly offsetSize: number;
  readonly objectRefSize: number;
  readonly objectCount: number;
  readonly topObject: number;
  readonly offsetTableOffset: number;
}

interface BinaryPlistLength {
  readonly value: number;
  readonly byteLength: number;
}

type BinaryPlistValue = string | readonly BinaryPlistValue[];

const MAX_BINARY_PLIST_DEPTH = 64;

/**
 * Reads only the native formats that carry local file selections on macOS.
 * Chromium deliberately omits VS Code's `code/file-list` flavor from DOM
 * paste events, so this remains an explicit user-paste fallback in the
 * renderer rather than a general clipboard inspection API.
 */
export function readNativeClipboardFilePaths(
  clipboard: NativeClipboardBufferReader,
): readonly string[] {
  return uniquePaths(
    NATIVE_FILE_CLIPBOARD_FORMATS.flatMap((format) => {
      try {
        return parseNativeClipboardFilePaths(
          format,
          clipboard.readBuffer(format),
        );
      } catch {
        return [];
      }
    }),
  );
}

export function parseNativeClipboardFilePaths(
  format: string,
  bytes: Uint8Array,
): readonly string[] {
  if (format === "code/file-list" || format === "public.file-url") {
    return parseFileUriList(Buffer.from(bytes).toString("utf8"));
  }
  if (format === "NSFilenamesPboardType") {
    return parseFilenamePlist(bytes);
  }
  return [];
}

function parseFileUriList(value: string): readonly string[] {
  return uniquePaths(
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .flatMap(fileUriToPath),
  );
}

function fileUriToPath(value: string): readonly string[] {
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") return [];
    const path = fileURLToPath(url);
    return isAbsolutePath(path) ? [path] : [];
  } catch {
    return [];
  }
}

function parseFilenamePlist(bytes: Uint8Array): readonly string[] {
  const text = Buffer.from(bytes).toString("utf8");
  const paths = text.startsWith("bplist00")
    ? parseBinaryFilenamePlist(bytes)
    : parseXmlFilenamePlist(text);
  return uniquePaths(paths.filter(isAbsolutePath));
}

function parseXmlFilenamePlist(value: string): readonly string[] {
  return Array.from(value.matchAll(/<string>([\s\S]*?)<\/string>/g)).map(
    (match) => decodeXmlString(match[1] ?? ""),
  );
}

function decodeXmlString(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#([0-9]+);/g, (_match, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)),
    )
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseBinaryFilenamePlist(bytes: Uint8Array): readonly string[] {
  const context = binaryPlistContext(bytes);
  if (context === null) return [];
  const root = parseBinaryPlistValue(context, context.topObject, 0);
  if (!Array.isArray(root)) return [];
  return root.filter(isString);
}

function binaryPlistContext(bytes: Uint8Array): BinaryPlistContext | null {
  if (bytes.length < 40) return null;
  const trailerOffset = bytes.length - 32;
  const offsetSize = bytes[trailerOffset + 6];
  const objectRefSize = bytes[trailerOffset + 7];
  if (
    offsetSize === undefined ||
    objectRefSize === undefined ||
    offsetSize === 0 ||
    objectRefSize === 0
  ) {
    return null;
  }
  const objectCount = readUnsignedInteger(bytes, trailerOffset + 8, 8);
  const topObject = readUnsignedInteger(bytes, trailerOffset + 16, 8);
  const offsetTableOffset = readUnsignedInteger(bytes, trailerOffset + 24, 8);
  if (
    objectCount === null ||
    topObject === null ||
    offsetTableOffset === null ||
    topObject >= objectCount ||
    offsetTableOffset >= trailerOffset
  ) {
    return null;
  }
  return {
    bytes,
    offsetSize,
    objectRefSize,
    objectCount,
    topObject,
    offsetTableOffset,
  };
}

function parseBinaryPlistValue(
  context: BinaryPlistContext,
  objectIndex: number,
  depth: number,
): BinaryPlistValue | null {
  if (
    depth > MAX_BINARY_PLIST_DEPTH ||
    objectIndex < 0 ||
    objectIndex >= context.objectCount
  ) {
    return null;
  }
  const tableEntry =
    context.offsetTableOffset + objectIndex * context.offsetSize;
  const offset = readUnsignedInteger(
    context.bytes,
    tableEntry,
    context.offsetSize,
  );
  if (offset === null || offset >= context.offsetTableOffset) return null;
  const marker = context.bytes[offset];
  if (marker === undefined) return null;
  const type = marker >> 4;
  const length = binaryPlistLength(context.bytes, offset, marker & 0x0f);
  if (length === null) return null;
  const contentOffset = offset + length.byteLength;
  if (type === 0x5) {
    return readAsciiString(context.bytes, contentOffset, length.value);
  }
  if (type === 0x6) {
    return readUtf16beString(context.bytes, contentOffset, length.value);
  }
  if (type !== 0xa) return null;
  const referencesLength = length.value * context.objectRefSize;
  if (contentOffset + referencesLength > context.offsetTableOffset) return null;
  return Array.from({ length: length.value }, (_value, index) => {
    const reference = readUnsignedInteger(
      context.bytes,
      contentOffset + index * context.objectRefSize,
      context.objectRefSize,
    );
    return reference === null
      ? null
      : parseBinaryPlistValue(context, reference, depth + 1);
  }).filter(isBinaryPlistValue);
}

function binaryPlistLength(
  bytes: Uint8Array,
  offset: number,
  markerInfo: number,
): BinaryPlistLength | null {
  if (markerInfo < 0x0f) return { value: markerInfo, byteLength: 1 };
  const integerMarker = bytes[offset + 1];
  if (integerMarker === undefined || integerMarker >> 4 !== 0x1) return null;
  const byteLength = 2 ** (integerMarker & 0x0f);
  const value = readUnsignedInteger(bytes, offset + 2, byteLength);
  return value === null ? null : { value, byteLength: byteLength + 2 };
}

function readUnsignedInteger(
  bytes: Uint8Array,
  offset: number,
  byteLength: number,
): number | null {
  if (
    byteLength === 0 ||
    byteLength > 8 ||
    offset < 0 ||
    offset + byteLength > bytes.length
  ) {
    return null;
  }
  const value = Array.from(bytes.subarray(offset, offset + byteLength)).reduce(
    (total, byte) => total * 256 + byte,
    0,
  );
  return Number.isSafeInteger(value) ? value : null;
}

function readAsciiString(
  bytes: Uint8Array,
  offset: number,
  length: number,
): string | null {
  if (offset + length > bytes.length) return null;
  return Buffer.from(bytes.subarray(offset, offset + length)).toString("ascii");
}

function readUtf16beString(
  bytes: Uint8Array,
  offset: number,
  length: number,
): string | null {
  const byteLength = length * 2;
  if (offset + byteLength > bytes.length) return null;
  return Array.from({ length }, (_value, index) => {
    const high = bytes[offset + index * 2] ?? 0;
    const low = bytes[offset + index * 2 + 1] ?? 0;
    return String.fromCharCode(high * 256 + low);
  }).join("");
}

function isBinaryPlistValue(
  value: BinaryPlistValue | null,
): value is BinaryPlistValue {
  return value !== null;
}

function isString(value: BinaryPlistValue): value is string {
  return typeof value === "string";
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

function uniquePaths(paths: readonly string[]): readonly string[] {
  return Array.from(new Set(paths));
}

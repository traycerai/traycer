import { useState } from "react";
import {
  SandboxFrame,
  type SandboxSource,
} from "@/components/sandbox/sandbox-frame";
import type { ArtifactManifestEntry } from "@/lib/sandbox/artifact-serving";
import type { SandboxStatus } from "@/lib/sandbox/bridge-host";

const INDEX = `<!doctype html><html><head><link rel="stylesheet" href="./style.css"></head>
<body><h2>Artifact files</h2><ul>
<li id="css">CSS: pending</li><li id="script">Classic script: pending</li>
<li id="json">JSON: pending</li><li id="image">PNG: pending</li>
<li id="video">Video: pending</li><li id="theme">Theme: pending</li><li id="range">Range: pending</li>
<li id="stream">9 MiB stream: pending</li></ul>
<img src="./logo.png" alt="Fixture pixel" width="32" height="32">
<video src="./clip.webm" preload="auto" controls muted autoplay loop></video>
<script src="./app.js"></script></body></html>`;

const SCRIPT = `const mark = (id, text) => { document.getElementById(id).textContent = text; };
mark('script', 'Classic script: loaded');
mark('css', getComputedStyle(document.body).getPropertyValue('--proof-css').trim() === 'loaded' ? 'CSS: loaded' : 'CSS: FAILED');
mark('theme', getComputedStyle(document.documentElement).getPropertyValue('--color-text-primary').trim() ? 'Theme: applied (change app theme to check live updates)' : 'Theme: FAILED');
const video = document.querySelector('video');
video.addEventListener('loadeddata', () => mark('video', 'Video: decoded; waiting for playback'));
video.addEventListener('playing', () => mark('video', 'Video: playing'));
video.addEventListener('error', () => mark('video', 'Video: FAILED'));
const img = document.querySelector('img');
const imageResult = () => mark('image', img.naturalWidth ? 'PNG: decoded' : 'PNG: FAILED');
if (img.complete) imageResult(); else { img.onload = imageResult; img.onerror = imageResult; }
fetch('./data.json').then(r => r.json()).then(data => mark('json', 'JSON: ' + data.text)).catch(e => mark('json', 'JSON: FAILED ' + e.message));
fetch('./big.bin', {headers: {Range: 'bytes=8388600-8388623'}}).then(async r => {
 const bytes = new Uint8Array(await r.arrayBuffer());
 const valid = r.status === 206 && bytes.length === 24 && bytes.every((value, i) => value === (8388600 + i) % 251);
 mark('range', valid ? 'Range: 206, correct 24 bytes across the 8 MiB boundary' : 'Range: FAILED');
}).catch(e => mark('range', 'Range: FAILED ' + e.message));
fetch('./big.bin').then(async r => {
 const bytes = new Uint8Array(await r.arrayBuffer());
 const valid = r.ok && bytes.length === 9 * 1024 * 1024 && bytes.every((value, i) => value === i % 251);
 mark('stream', valid ? '9 MiB stream: all bytes verified' : '9 MiB stream: FAILED');
}).catch(e => mark('stream', '9 MiB stream: FAILED ' + e.message));`;

function createFixture(): SandboxSource {
  const encoder = new TextEncoder();
  const files: Record<string, ArtifactManifestEntry> = {};
  const blobs = new Map<string, { bytes: Uint8Array; mediaType: string }>();
  const add = (path: string, bytes: Uint8Array, mediaType: string): void => {
    // These keys never leave this fixture's reader; no published blob is involved.
    const sha256 = String(blobs.size + 1).padStart(64, "0");
    blobs.set(sha256, { bytes, mediaType });
    files[path] = {
      sha256,
      byteLength: bytes.length,
      mediaType,
      status: "local-only",
    };
  };
  add("index.html", encoder.encode(INDEX), "text/html");
  add(
    "style.css",
    encoder.encode(
      `body { --proof-css: loaded; margin: 0; padding: 1em; color: var(--color-text-primary); background: var(--color-background-secondary); font-family: var(--font-sans); } video { display: block; width: 100%; max-height: 20vh; }`,
    ),
    "text/css",
  );
  add("app.js", encoder.encode(SCRIPT), "text/javascript");
  add(
    "data.json",
    encoder.encode(JSON.stringify({ text: "loaded from a relative fetch" })),
    "application/json",
  );
  add(
    "logo.png",
    Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNwWNDwHwAE5AJg886oOwAAAABJRU5ErkJggg==",
      ),
      (character) => character.charCodeAt(0),
    ),
    "image/png",
  );
  add(
    "clip.webm",
    Uint8Array.from(
      atob(
        "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",
      ),
      (character) => character.charCodeAt(0),
    ),
    "video/webm",
  );
  add(
    "big.bin",
    Uint8Array.from({ length: 9 * 1024 * 1024 }, (_, index) => index % 251),
    "application/octet-stream",
  );
  return {
    kind: "artifact",
    artifactId: "desktop-proof",
    manifest: { files },
    readSpan: (sha256, offset, length, signal) => {
      signal.throwIfAborted();
      const blob = blobs.get(sha256);
      return Promise.resolve(
        blob === undefined
          ? { unavailable: "missing" }
          : {
              bytes: blob.bytes.slice(offset, offset + length),
              totalBytes: blob.bytes.length,
              mediaType: blob.mediaType,
            },
      );
    },
    resolveOutsideReference: () => null,
  };
}

function ignore(): void {}

function ArtifactProof() {
  const [source] = useState(createFixture);
  const [status, setStatus] = useState<SandboxStatus>("loading");
  return (
    <main className="flex h-full min-h-0 w-full flex-col gap-4 overflow-auto bg-background p-4">
      <h1>Desktop artifact proof</h1>
      <p>
        Artifact bridge: {status}. The checklist below verifies relative files
        and byte ranges. Change the app theme to check live colors.
      </p>
      <SandboxFrame
        source={source}
        kind="page"
        title="Artifact proof"
        appName={null}
        networkPolicy="https-only"
        appCsp={null}
        permissions={[]}
        appRequests={null}
        className="min-h-[60vh]"
        height={null}
        onSize={ignore}
        onStatus={setStatus}
        onRequestTeardown={ignore}
        displayMode="inline"
        onBridge={null}
        ref={null}
      />
      <h2>Ordinary HTML loader</h2>
      <SandboxFrame
        source={{
          kind: "html",
          html: "<p style='color:var(--color-text-primary);font-family:var(--font-sans)'>Ordinary loader: rendered</p>",
        }}
        kind="page"
        title="Ordinary loader proof"
        appName={null}
        networkPolicy="https-only"
        appCsp={null}
        permissions={[]}
        appRequests={null}
        className="min-h-[15vh]"
        height={null}
        onSize={ignore}
        onStatus={ignore}
        onRequestTeardown={ignore}
        displayMode="inline"
        onBridge={null}
        ref={null}
      />
    </main>
  );
}

export function ArtifactProofRoute() {
  return import.meta.env.DEV ? <ArtifactProof /> : <p>404 — Not found</p>;
}

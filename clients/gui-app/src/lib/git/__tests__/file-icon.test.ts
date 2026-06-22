import { describe, expect, it } from "vitest";
import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileJson,
  FileText,
  FileType,
  FileVideo,
} from "lucide-react";
import { fileIconForPath } from "../file-icon";

describe("fileIconForPath", () => {
  it("returns FileCode for TypeScript files", () => {
    expect(fileIconForPath("app.ts")).toBe(FileCode);
    expect(fileIconForPath("component.tsx")).toBe(FileCode);
  });

  it("returns FileCode for JavaScript files", () => {
    expect(fileIconForPath("script.js")).toBe(FileCode);
    expect(fileIconForPath("component.jsx")).toBe(FileCode);
  });

  it("returns FileCode for other programming languages", () => {
    expect(fileIconForPath("main.py")).toBe(FileCode);
    expect(fileIconForPath("main.go")).toBe(FileCode);
    expect(fileIconForPath("lib.rs")).toBe(FileCode);
    expect(fileIconForPath("script.rb")).toBe(FileCode);
  });

  it("returns FileJson for JSON files", () => {
    expect(fileIconForPath("package.json")).toBe(FileJson);
    expect(fileIconForPath("data.jsonl")).toBe(FileJson);
  });

  it("returns FileText for text files", () => {
    expect(fileIconForPath("README.md")).toBe(FileText);
    expect(fileIconForPath("notes.txt")).toBe(FileText);
  });

  it("returns FileType for markup files", () => {
    expect(fileIconForPath("styles.css")).toBe(FileType);
    expect(fileIconForPath("index.html")).toBe(FileType);
  });

  it("returns FileImage for image files", () => {
    expect(fileIconForPath("screenshot.png")).toBe(FileImage);
    expect(fileIconForPath("photo.jpg")).toBe(FileImage);
  });

  it("returns FileVideo for video files", () => {
    expect(fileIconForPath("demo.mp4")).toBe(FileVideo);
    expect(fileIconForPath("screen.webm")).toBe(FileVideo);
  });

  it("returns FileAudio for audio files", () => {
    expect(fileIconForPath("track.mp3")).toBe(FileAudio);
    expect(fileIconForPath("sound.wav")).toBe(FileAudio);
  });

  it("returns FileArchive for archive files", () => {
    expect(fileIconForPath("archive.zip")).toBe(FileArchive);
    expect(fileIconForPath("backup.tar")).toBe(FileArchive);
  });

  it("returns File for unknown extensions", () => {
    expect(fileIconForPath("unknown.xyz")).toBe(File);
    expect(fileIconForPath("noext")).toBe(File);
  });

  it("handles case-insensitive extensions", () => {
    expect(fileIconForPath("Script.TS")).toBe(FileCode);
    expect(fileIconForPath("Data.JSON")).toBe(FileJson);
  });

  it("handles paths with multiple dots", () => {
    expect(fileIconForPath("/path/to/file.test.ts")).toBe(FileCode);
    expect(fileIconForPath("archive.backup.tar")).toBe(FileArchive);
  });
});

import { win32 } from "node:path";
import { expect, it } from "vitest";

import { HOST_PLATFORM } from "../platform/HostPlatform.js";
import { hostGitMetadataPath } from "./referenceSourceGitMetadataPath.js";

const windowsGitDirectory = win32.join(
  "E:\\work",
  "rea-reference-packed-owner-wgmHHj",
  ".git",
);

// isomorphic-git reads `${gitdir}/${relative}` rather than path.join.
const libraryPath = (relative: string): string =>
  `${windowsGitDirectory}/${relative}`;

it.each([
  ["config", ["config"]],
  ["packed-refs", ["packed-refs"]],
  ["refs/heads/main", ["refs", "heads", "main"]],
  ["HEAD", ["HEAD"]],
] as const)(
  "reports Windows %s with the same spelling as join",
  (relative, segments) => {
    expect(hostGitMetadataPath(libraryPath(relative), "win32")).toBe(
      win32.join(windowsGitDirectory, ...segments),
    );
  },
);

it("leaves a Windows path that join already spelled unchanged", () => {
  const head = win32.join(windowsGitDirectory, "HEAD");
  expect(hostGitMetadataPath(head, "win32")).toBe(head);
});

it("keeps Windows UNC and device prefixes while replacing the library slash", () => {
  const cases = [
    ["\\\\server\\share\\repo\\.git", "packed-refs"],
    ["\\\\?\\E:\\foo\\.git", "config"],
  ] as const;
  for (const [directory, name] of cases)
    expect(hostGitMetadataPath(`${directory}/${name}`, "win32")).toBe(
      win32.join(directory, name),
    );
});

it.each(["linux", "darwin"] as const)(
  "leaves %s paths unchanged, including backslashes and parent segments",
  (platform) => {
    const path = "/work/link/../.git/foo\\bar/packed-refs";
    expect(hostGitMetadataPath(path, platform)).toBe(path);
  },
);

it("defaults to the host captured for this process", () => {
  const path = libraryPath("packed-refs");
  expect(hostGitMetadataPath(path)).toBe(
    hostGitMetadataPath(path, HOST_PLATFORM.platform),
  );
});

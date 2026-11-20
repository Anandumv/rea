import { win32 } from "node:path";

import { HOST_PLATFORM } from "../platform/HostPlatform.js";

/**
 * Spell a path isomorphic-git built with `/` the way this host's `path.join` would.
 *
 * The library reads Git metadata as `${gitdir}/packed-refs` and `${gitdir}/config`.
 * On Windows that mixed spelling is what cleanup records, so it no longer matches
 * `join`. `win32.normalize` is the join spelling and keeps UNC and `\\?\` prefixes.
 * POSIX already uses `/`, and a backslash there is a filename character, so those
 * paths are returned unchanged.
 */
export const hostGitMetadataPath = (
  libraryPath: string,
  platform: NodeJS.Platform = HOST_PLATFORM.platform,
): string =>
  platform === "win32" ? win32.normalize(libraryPath) : libraryPath;

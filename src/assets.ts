import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, statSync } from "node:fs";

/** A file on disk, as it was when it became part of a bundle. */
export interface FileRef {
  file: string;
  size: number;
  mtimeMs: number;
}

const hashes = new Map<string, FileRef & { hash: string }>();
const chunk = Buffer.allocUnsafe(1024 * 1024);

/**
 * A hash of a file's content, for a URL that changes when the content does.
 * The file is read a piece at a time rather than held in memory, and only
 * again once it has changed, however many pages refer to it. Returns `null`
 * when there is no such file.
 */
export function hashFile(file: string): (FileRef & { hash: string }) | null {
  let stats;
  try {
    stats = statSync(file);
  } catch {
    return null;
  }
  if (!stats.isFile()) return null;

  const known = hashes.get(file);
  if (known?.size === stats.size && known.mtimeMs === stats.mtimeMs) {
    return known;
  }

  const hash = createHash("sha256");
  let fd;
  try {
    fd = openSync(file, "r");
    for (let read; (read = readSync(fd, chunk, 0, chunk.length, null)) > 0;) {
      hash.update(chunk.subarray(0, read));
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const ref = {
    file,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    hash: hash.digest("base64url").slice(0, 12),
  };
  hashes.set(file, ref);
  return ref;
}

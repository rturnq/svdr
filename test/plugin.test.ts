import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isPackageInstalled } from "../src/plugin.ts";

let dir: string;
afterAll(() => dir && rm(dir, { recursive: true, force: true }));

test("tells an installed package from an absent one", async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "svdr-pkg-"));
  await mkdir(path.join(dir, "node_modules/@scope/pkg"), { recursive: true });
  await writeFile(path.join(dir, "node_modules/@scope/pkg/package.json"), "{}");
  await mkdir(path.join(dir, "node_modules/plain"), { recursive: true });
  await writeFile(path.join(dir, "node_modules/plain/package.json"), "{}");
  await mkdir(path.join(dir, "deep/er"), { recursive: true });

  const from = path.join(dir, "deep/er");
  expect(isPackageInstalled("plain", from)).toBe(true);
  expect(isPackageInstalled("plain/sub/path.js", from)).toBe(true);
  expect(isPackageInstalled("@scope/pkg", from)).toBe(true);
  expect(isPackageInstalled("@scope/pkg/x", from)).toBe(true);
  expect(isPackageInstalled("@scope/other", from)).toBe(false);
  expect(isPackageInstalled("absent", from)).toBe(false);
  expect(isPackageInstalled("plainer", from)).toBe(false);
});

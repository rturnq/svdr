import { expect, test } from "bun:test";
import path from "node:path";
import { negotiate, parseCompression } from "../src/compression.ts";
import { parseExtensions, parseOptions, UsageError } from "../src/options.ts";

test("defaults", () => {
  expect(parseOptions([])).toEqual({
    dir: process.cwd(),
    port: 3000,
    compression: ["br", "gzip"],
    extensions: ["marko", "html"],
    http: false,
    prod: false,
  });
});

test("flags", () => {
  expect(
    parseOptions([
      "-d",
      "src",
      "-p",
      "8080",
      "-c",
      "zstd, gz",
      "-x",
      ".htm, html",
      "--http",
      "--prod",
    ]),
  ).toEqual({
    dir: path.resolve("src"),
    port: 8080,
    compression: ["zstd", "gzip"],
    extensions: ["htm", "html"],
    http: true,
    prod: true,
  });
});

test("help", () => {
  expect(parseOptions(["--help"])).toBeNull();
});

test("invalid arguments", () => {
  expect(() => parseOptions(["-p", "abc"])).toThrow(UsageError);
  expect(() => parseOptions(["-p", "70000"])).toThrow(UsageError);
  expect(() => parseOptions(["-d", "does-not-exist"])).toThrow(UsageError);
  expect(() => parseOptions(["-c", "lzma"])).toThrow(UsageError);
  expect(() => parseOptions(["-c", "none,br"])).toThrow(UsageError);
  expect(() => parseOptions(["-x", "none,html"])).toThrow(UsageError);
  expect(() => parseOptions(["-x", "a/b"])).toThrow(UsageError);
  expect(() => parseOptions(["--unknown"])).toThrow(UsageError);
});

test("parseCompression", () => {
  expect(parseCompression("none")).toEqual([]);
  expect(parseCompression("gz,br,gzip")).toEqual(["gzip", "br"]);
});

test("parseExtensions", () => {
  expect(parseExtensions("none")).toEqual([]);
  expect(parseExtensions(".html, marko,html")).toEqual(["html", "marko"]);
});

test("negotiate prefers the server's order among what the client accepts", () => {
  expect(negotiate("gzip, br", ["br", "gzip"])).toBe("br");
  expect(negotiate("gzip, br;q=0", ["br", "gzip"])).toBe("gzip");
  expect(negotiate("*", ["br", "gzip"])).toBe("br");
  expect(negotiate("identity", ["br", "gzip"])).toBeNull();
  expect(negotiate(null, ["br", "gzip"])).toBeNull();
  expect(negotiate("gzip, br", [])).toBeNull();
});

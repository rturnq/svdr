import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface MarkoToolchain {
  compiler: typeof import("@marko/compiler");
  translator: unknown;
  version: string;
  /** Whether Marko comes from the served directory rather than from svdr itself. */
  local: boolean;
}

/** Compiler options that apply to every compile. */
export const compilerConfig = {
  sourceMaps: true,
  writeVersionComment: false,
  babelConfig: {
    babelrc: false,
    configFile: false,
    browserslistConfigFile: false,
    caller: {
      name: "svdr",
      supportsStaticESM: true,
      supportsDynamicImport: true,
      supportsTopLevelAwait: true,
      supportsExportNamespaceFrom: true,
    },
  },
} as const;

/** A file inside svdr, used to resolve the packages that ship with it. */
export const builtinImporter = fileURLToPath(import.meta.url);

/**
 * Finds the `marko` package installed for a directory. This looks through
 * `node_modules` itself as Bun's own resolution falls back to its global
 * package cache, which says nothing about what the directory has installed.
 */
function findLocalMarko(dir: string) {
  for (let current = dir; ; current = path.dirname(current)) {
    const pkg = path.join(current, "node_modules", "marko", "package.json");
    if (existsSync(pkg)) return realpathSync(pkg);
    if (current === path.dirname(current)) return null;
  }
}

/**
 * Loads the Marko compiler, preferring the one installed in the served
 * directory so the compiler always matches the runtime that gets bundled.
 */
export async function loadMarko(dir: string): Promise<MarkoToolchain> {
  const localPkg = findLocalMarko(dir);
  if (localPkg) {
    const { version } = await import(localPkg);
    if (parseInt(version, 10) < 6) {
      throw new Error(
        `${path.dirname(localPkg)} contains Marko ${version}, but svdr requires Marko 6.`,
      );
    }
    // The compiler is a dependency of marko, so it is resolved from there.
    const from = path.dirname(localPkg);
    return warmUp({
      compiler: await import(Bun.resolveSync("@marko/compiler", from)),
      translator: await import(Bun.resolveSync("marko/translator", from)),
      version,
      local: true,
    });
  }

  const { version } = await import("marko/package.json");
  return warmUp({
    compiler: await import("@marko/compiler"),
    translator: await import("marko/translator"),
    version,
    local: false,
  });
}

/**
 * Compiles two trivial templates so that the compiler has initialized itself
 * before the bundler starts compiling.
 *
 * Without this, the first compiles fail under Bun with "Cannot access 'v'
 * before initialization" from Babel's `validateBrowsers`, when Rolldown calls
 * the plugin's `load` hook for several templates at once. Babel initializes
 * the module in question lazily on first use, and starting that from
 * concurrent hook callbacks trips over the half-initialized module. Plain
 * concurrent `compile` calls outside of Rolldown do not reproduce it, so the
 * interaction with Rolldown's native-to-JS callbacks is suspected; seen with
 * Bun 1.4.2, Rolldown 1.2.12 and @marko/compiler 5.42.10.
 */
async function warmUp(marko: MarkoToolchain) {
  for (const output of ["html", "dom"] as const) {
    await marko.compiler.compile(
      "<div/>",
      path.join(os.tmpdir(), "warm-up.marko"),
      {
        ...compilerConfig,
        translator: marko.translator,
        output,
      },
    );
  }
  return marko;
}

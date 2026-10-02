import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Plugin } from "rolldown";
import {
  builtinImporter,
  compilerConfig,
  type MarkoToolchain,
} from "./marko.ts";
// The module the compiled server entry imports to write the tags for a
// page's assets. The assets are only known once the client bundle has been
// built, so they are registered after the server bundle is loaded.
import linkAssetsRuntime from "./runtime/link-assets.js" with { type: "text" };

const markoExt = ".marko";
const serverEntryExt = ".server-entry.marko";
const clientEntryExt = ".client-entry.marko";
const loadEntryExt = ".load-entry.marko";
const linkAssetsId = "\0svdr:link-assets";
const tagImportReg = /^<([^>]+)>$/;
const bareImportReg = /^(?![./\0])(?![a-zA-Z]:[\\/])/;
const styleReg = /\.(?:css|less|s[ac]ss|styl(?:us)?|pcss|postcss)$/i;
const staticAssetReg =
  /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp|woff2?|ttf|otf|eot|mp[34]|webm|ogg|wav|flac|aac|pdf)$/i;

/** The export a server bundle exposes to receive the assets of its client bundle. */
export const registerAssetsExport = "$$registerAssets";

type EntryKind = "server" | "client" | "load";

export function parseEntryId(
  id: string,
): { kind: EntryKind; file: string } | null {
  for (const [ext, kind] of [
    [serverEntryExt, "server"],
    [clientEntryExt, "client"],
    [loadEntryExt, "load"],
  ] as const) {
    if (id.endsWith(ext)) {
      return { kind, file: id.slice(0, -ext.length) + markoExt };
    }
  }
  return null;
}

export const toServerEntryId = (file: string) =>
  file.slice(0, -markoExt.length) + serverEntryExt;
export const toClientEntryId = (file: string) =>
  file.slice(0, -markoExt.length) + clientEntryExt;
export const toLoadEntryId = (file: string) =>
  file.slice(0, -markoExt.length) + loadEntryExt;

export interface AssetIds {
  page: Map<string, string>;
  load: Map<string, string>;
}

export interface ModuleImports {
  static: readonly string[];
  dynamic: readonly string[];
}

export interface MarkoPluginOptions {
  /** The served directory; files inside it are addressable by URL. */
  root: string;
  marko: MarkoToolchain;
  optimize: boolean;
  /**
   * The ids the compiled server code uses to request assets, by file name.
   * Filled in by the server build so the client build knows which lazily
   * loaded templates (`import ... with { load }`) need an entry of their own.
   */
  assetIds: AssetIds;
  /** Receives the CSS of every style module the client build encounters, by module id. */
  css: Map<string, string>;
  /**
   * Receives what every module of the client build imports, by module id.
   * Style modules leave nothing behind in the bundle, so this is what tells
   * which entries need which styles.
   */
  imports: Map<string, ModuleImports>;
}

/**
 * Creates the plugins for the server and client builds of one page. The two
 * share the compiler's cache, so they are only good for a single build each.
 */
export function markoPlugins(opts: MarkoPluginOptions): {
  server: Plugin;
  client: Plugin;
} {
  const { compiler, translator } = opts.marko;
  const virtualFiles = new Map<string, string>();
  const baseConfig = {
    ...compilerConfig,
    translator,
    cache: new Map(),
    optimize: opts.optimize,
    resolveVirtualDependency(
      filename: string,
      dep: { virtualPath: string; code: string },
    ) {
      virtualFiles.set(path.resolve(filename, "..", dep.virtualPath), dep.code);
      return dep.virtualPath;
    },
    linkAssets: {
      runtime: linkAssetsId,
      onAsset(kind: "page" | "load", filename: string, assetId: string) {
        opts.assetIds[kind].set(filename, assetId);
      },
    },
  };

  const createPlugin = (isServer: boolean): Plugin => {
    const config = {
      ...baseConfig,
      output: isServer ? "html" : "dom",
    } as const;

    const loadStyle = (id: string, code: string) => {
      if (!/\.css$/i.test(id)) {
        throw new Error(
          `Unable to bundle ${id}: only plain CSS styles are supported.`,
        );
      }
      if (/\.module\.css$/i.test(id)) {
        throw new Error(
          `Unable to bundle ${id}: CSS modules are not supported.`,
        );
      }
      if (!isServer) opts.css.set(id, code);
      // Styles are served as stylesheets, so nothing of them ends up in a script.
      return { code: "", moduleType: "js", moduleSideEffects: false } as const;
    };

    return {
      name: "svdr:marko",

      buildEnd() {
        if (isServer) return;
        for (const id of this.getModuleIds()) {
          const info = this.getModuleInfo(id);
          if (!info) continue;
          opts.imports.set(id, {
            static: info.importedIds,
            dynamic: info.dynamicallyImportedIds,
          });
        }
      },

      async resolveId(source, importer, options) {
        if (source === linkAssetsId) return source;
        if (!importer) return parseEntryId(source) ? source : null;

        const tagName = tagImportReg.exec(source)?.[1];
        if (tagName) {
          const tagDef = compiler.taglib
            .buildLookup(path.dirname(importer), translator)
            .getTag(tagName);
          return tagDef && (tagDef.template || tagDef.renderer);
        }

        if (source[0] === ".") {
          const resolved = path.resolve(importer, "..", source);
          return virtualFiles.has(resolved) ? resolved : null;
        }

        if (bareImportReg.test(source)) {
          // Packages come from the served directory when installed there and
          // otherwise from the ones that ship with svdr.
          const resolveOptions = { ...options, skipSelf: true };
          return (
            (await this.resolve(source, importer, resolveOptions)) ??
            (await this.resolve(source, builtinImporter, resolveOptions))
          );
        }

        return null;
      },

      async load(id) {
        if (id === linkAssetsId) return linkAssetsRuntime;

        const virtualFile = virtualFiles.get(id);
        if (virtualFile !== undefined) {
          if (styleReg.test(id)) return loadStyle(id, virtualFile);
          return { code: virtualFile, moduleType: "js" };
        }

        if (id.endsWith(markoExt)) {
          const entry = parseEntryId(id);
          const file = entry ? entry.file : id;
          this.addWatchFile(file);

          const compiled = await compiler.compile(
            await readFile(file, "utf8"),
            file,
            entry
              ? { ...config, entry: entry.kind === "load" ? "load" : "page" }
              : config,
          );
          for (const watchFile of compiled.meta.watchFiles) {
            this.addWatchFile(watchFile);
          }

          let { code } = compiled;
          if (entry?.kind === "server") {
            code += `\nexport { register as ${registerAssetsExport} } from ${JSON.stringify(linkAssetsId)};`;
          }
          return {
            code,
            // Entries only wire modules together, they have no meaningful map.
            map: entry ? null : (compiled.map as never),
            moduleType: "js",
          };
        }

        if (styleReg.test(id)) return loadStyle(id, await readFile(id, "utf8"));

        if (staticAssetReg.test(id)) {
          const relative = path.relative(opts.root, id);
          if (relative.startsWith("..") || path.isAbsolute(relative)) {
            throw new Error(
              `Unable to bundle ${id}: imported assets must be inside the served directory.`,
            );
          }
          // The file is already served as is, so importing it gives its URL.
          const url =
            "/" + relative.split(path.sep).map(encodeURIComponent).join("/");
          return {
            code: `export default ${JSON.stringify(url)};`,
            moduleType: "js",
          };
        }

        return null;
      },
    };
  };

  return { server: createPlugin(true), client: createPlugin(false) };
}

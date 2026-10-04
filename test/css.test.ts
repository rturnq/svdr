import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  bundleStylesheet,
  findPackageStylesheet,
  minifyCss,
  rewriteCssUrls,
  scanImports,
  type Stylesheet,
} from "../src/css.ts";

const rewrite = (css: string) =>
  rewriteCssUrls(css, "/site/docs/page.marko.css", "/site");

test("rewrites references relative to the stylesheet", () => {
  const css = `
    a { background: url(./bg.svg) }
    b { background: url("../assets/img.png?v=1#frag") }
    c { background: url( 'sub/x y.png' ) }
    d { background: URL(upper.png) }
    e { background: url(   bare.png   ) }
    @import "theme.css";
    @import url(../assets/base.css) screen;
  `;
  const out = rewrite(css);
  expect(out).toContain("url(/docs/bg.svg)");
  expect(out).toContain('url("/assets/img.png?v=1#frag")');
  expect(out).toContain("url( '/docs/sub/x%20y.png' )");
  expect(out).toContain("URL(/docs/upper.png)");
  expect(out).toContain("url(   /docs/bare.png   )");
  expect(out).toContain('@import "/docs/theme.css";');
  expect(out).toContain("@import url(/assets/base.css) screen;");
});

test("leaves references alone that are not relative to the stylesheet", () => {
  const css = `
    d { background: url(/absolute.png) }
    e { background: url(data:image/png;base64,AAAA) }
    f { background: url(https://example.com/x.png) }
    g { mask: url(#clip) }
    h { background: url(../../escaped.png) }
    @import url(../outside/../../escaped.css);
  `;
  expect(rewrite(css)).toBe(css);
});

test("keeps percent-encoding as it is", () => {
  expect(rewrite('a { background: url("./my%20image.svg") }')).toBe(
    'a { background: url("/docs/my%20image.svg") }',
  );
  expect(rewrite("a { background: url(./100%25.png) }")).toBe(
    "a { background: url(/docs/100%25.png) }",
  );
});

test("decodes escapes before resolving and writes valid CSS back", () => {
  expect(rewrite("a { background: url(my\\ image.svg) }")).toBe(
    "a { background: url(/docs/my%20image.svg) }",
  );
  expect(rewrite('a { background: url("my\\20 image.svg") }')).toBe(
    'a { background: url("/docs/my%20image.svg") }',
  );
  // A result that needs quoting gets quoted.
  expect(rewrite("a { background: url(paren\\).svg) }")).toBe(
    'a { background: url("/docs/paren).svg") }',
  );
  expect(rewrite("a { background: url(\\71 uote.svg) }")).toBe(
    "a { background: url(/docs/quote.svg) }",
  );
  // A string that continues on the next line.
  expect(rewrite('a { background: url("two\\\nlines.svg") }')).toBe(
    'a { background: url("/docs/twolines.svg") }',
  );
});

test("keeps the whitespace that ends a hex escape apart from trailing whitespace", () => {
  expect(rewrite("a { b: url(icon.sv\\67 ) }")).toBe(
    "a { b: url(/docs/icon.svg) }",
  );
  expect(rewrite("a { b: url(icon.sv\\67  ) }")).toBe(
    "a { b: url(/docs/icon.svg ) }",
  );
  expect(rewrite("a { b: url(icon.svg  ) }")).toBe(
    "a { b: url(/docs/icon.svg  ) }",
  );
  expect(rewrite("a { b: url(ic\\6f n.svg) }")).toBe(
    "a { b: url(/docs/icon.svg) }",
  );
});

test("recognizes keywords spelled with escapes", () => {
  expect(rewrite("a { b: u\\72l(icon.svg) }")).toBe(
    "a { b: u\\72l(/docs/icon.svg) }",
  );
  expect(rewrite("a { b: \\75 RL(icon.svg) }")).toBe(
    "a { b: \\75 RL(/docs/icon.svg) }",
  );
  expect(rewrite('@\\69mport "theme.css";')).toBe(
    '@\\69mport "/docs/theme.css";',
  );
  // Other identifiers are not functions or imports.
  expect(rewrite("a { b: \\75rlx(icon.svg) }")).toBe(
    "a { b: \\75rlx(icon.svg) }",
  );
  expect(rewrite('@\\69mports "theme.css";')).toBe('@\\69mports "theme.css";');
});

test("recognizes imports however they are written", () => {
  expect(rewrite('@IMPORT "theme.css";')).toBe('@IMPORT "/docs/theme.css";');
  expect(rewrite('@import/**/"theme.css";')).toBe(
    '@import/**/"/docs/theme.css";',
  );
  expect(rewrite("@import /* a */ /* b */ 'theme.css' screen;")).toBe(
    "@import /* a */ /* b */ '/docs/theme.css' screen;",
  );
  expect(rewrite("@import url( /* c */ theme.css );")).toBe(
    "@import url( /* c */ /docs/theme.css );",
  );
  expect(rewrite("@imports 'x.css';")).toBe("@imports 'x.css';");
});

test("does not touch strings and comments", () => {
  const css = `
    /* url(comment.svg) and @import "comment.css" */
    a::before { content: "url(icon.svg)"; }
    b::before { content: 'say \\'url(x.svg)\\''; }
    c { background: url("real.svg") }
    d { my-url(fake.svg) }
  `;
  const out = rewrite(css);
  expect(out).toContain('/* url(comment.svg) and @import "comment.css" */');
  expect(out).toContain('content: "url(icon.svg)"');
  expect(out).toContain("content: 'say \\'url(x.svg)\\''");
  expect(out).toContain('url("/docs/real.svg")');
  expect(out).toContain("my-url(fake.svg)");
});

test("survives unfinished input", () => {
  for (const css of [
    'a { b: url("open',
    "a { b: url(open",
    "/* open",
    "@import 'x",
  ]) {
    expect(typeof rewrite(css)).toBe("string");
  }
});

/** A relative path with forward slashes, whatever the platform uses. */
const relative = (from: string, to: string) =>
  path.relative(from, to).split(path.sep).join("/");

const tmpDirs: string[] = [];
afterAll(() =>
  Promise.all(tmpDirs.map((dir) => rm(dir, { recursive: true, force: true }))),
);

async function site(files: Record<string, string>) {
  // Real path: the bundler reports the real paths of the files it reads.
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "svdr-css-")),
  );
  tmpDirs.push(root);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  return root;
}

const bundle = (
  root: string,
  file: string,
  code?: string,
  cssModules = false,
) =>
  bundleStylesheet({
    file: path.join(root, file),
    code,
    root,
    cssModules,
  });

test("inlines local imports with their urls made relative to the root", async () => {
  const root = await site({
    "styles/base.css":
      '@import "./deep/x.css" layer(deep);\n.base { background: url(base.png) }\n',
    "styles/deep/x.css": ".x { background: url(./x.png) }\n",
    "docs/page.css":
      '@import "../styles/base.css";\n@import url(print.css) print;\nbody { background: url(./bg.png) }\n',
    "docs/print.css": ".print { color: black }\n",
  });
  const { css, files } = await bundle(root, "docs/page.css");
  expect(css).not.toContain("@import");
  expect(css).toMatch(/url\("?\/styles\/base.png"?\)/);
  expect(css).toMatch(/url\("?\/styles\/deep\/x.png"?\)/);
  expect(css).toMatch(/url\("?\/docs\/bg.png"?\)/);
  expect(css).toMatch(/@layer deep\s*{/);
  expect(css).toMatch(/@media print\s*{/);
  expect(css.indexOf(".x")).toBeLessThan(css.indexOf(".base"));
  expect(css.indexOf(".base")).toBeLessThan(css.indexOf("body"));
  expect(files.map((file) => relative(root, file)).sort()).toEqual([
    "docs/print.css",
    "styles/base.css",
    "styles/deep/x.css",
  ]);
});

/** Read a retained dependency exactly as the browser would follow its URL. */
function imported(sheet: Stylesheet, url: string) {
  const asset = sheet.assets.find(
    (asset) => "/_svdr/" + asset.fileName === url,
  );
  expect(asset).toBeDefined();
  return asset!.css;
}

test("preserves direct and indirect remote import order", async () => {
  const root = await site({
    "a.css": ".a { color: red }",
    "child.css":
      '@import "https://example.com/remote.css"; .child { color: blue }',
  });
  for (const tail of ['"https://example.com/remote.css"', '"./child.css"']) {
    const sheet = await bundle(
      root,
      "page.css",
      `@import "./a.css"; @import ${tail}; body { margin: 0 }`,
    );
    const rules = scanImports(sheet.css);
    expect(sheet.hasImports).toBe(true);
    expect(rules).toHaveLength(2);
    expect(imported(sheet, rules[0]!.target)).toContain(".a");
    if (tail.includes("child")) {
      expect(scanImports(imported(sheet, rules[1]!.target))[0]!.target).toBe(
        "https://example.com/remote.css",
      );
    } else {
      expect(rules[1]!.target).toBe("https://example.com/remote.css");
    }
    expect(sheet.css.indexOf("body")).toBeGreaterThan(rules[1]!.end);
  }
});

test("ignores imports in comments and reads imports across them", async () => {
  const root = await site({ "a.css": ".a { color: red }" });
  const sheet = await bundle(
    root,
    "page.css",
    '/* @import "https://example.com/comment.css"; */\n@import/**/"https://fonts.example/f.css";\n@import /* local */ "./a.css";\nbody { margin: 0 }',
  );
  const rules = scanImports(sheet.css);
  expect(rules).toHaveLength(2);
  expect(rules[0]!.target).toBe("https://fonts.example/f.css");
  expect(imported(sheet, rules[1]!.target)).toContain(".a");
});

test("ignores a query or fragment on an imported file", async () => {
  const root = await site({ "a.css": ".a { color: red }\n" });
  const { css } = await bundle(
    root,
    "page.css",
    '@import "./a.css?v=1";\n@import "a.css#x";\n',
  );
  expect(css).toContain(".a");
});

test("serves files a stylesheet refers to that cannot be served from where they are", async () => {
  const root = await site({
    "node_modules/fonts/package.json":
      '{ "name": "fonts", "style": "fonts.css" }',
    "node_modules/fonts/fonts.css":
      '@font-face { src: url(./f.woff2) format("woff2"), url("missing.woff") }\n',
    "node_modules/fonts/f.woff2": "woff2 bytes",
    "assets/local.png": "png bytes",
    "page.css":
      '@import "fonts";\nbody { background: url(./assets/local.png) }\n',
  });
  const emitted: string[] = [];
  const { css } = await bundleStylesheet({
    file: path.join(root, "page.css"),
    root,
    cssModules: false,
    emitAsset(file) {
      if (!existsSync(file)) return null;
      emitted.push(relative(root, file));
      return `/_svdr/assets/${path.basename(file)}`;
    },
  });
  expect(emitted).toEqual(["assets/local.png", "node_modules/fonts/f.woff2"]);
  expect(css).toContain("/_svdr/assets/f.woff2");
  // Local assets are isolated alongside package assets...
  expect(css).toMatch(/url\("?\/_svdr\/assets\/local.png"?\)/);
  // ...and one that does not exist is left to fail where it is.
  expect(css).toMatch(/url\("?\/node_modules\/fonts\/missing.woff"?\)/);
});

test("enters packages through their exports", async () => {
  const root = await site({
    "node_modules/exported/package.json": JSON.stringify({
      name: "exported",
      main: "index.js",
      exports: {
        ".": { style: "./dist/main.css", default: "./index.js" },
        "./theme": "./dist/theme.css",
        "./parts/*": "./dist/parts/*.css",
        "./package.json": "./package.json",
      },
    }),
    "node_modules/exported/index.js": "module.exports = {}",
    "node_modules/exported/index.css": ".wrong {}",
    "node_modules/exported/dist/main.css": ".main {}",
    "node_modules/exported/dist/theme.css": ".theme {}",
    "node_modules/exported/dist/parts/button.css": ".button {}",
    "node_modules/exported/dist/parts/hidden.css": ".hidden {}",
    "node_modules/jsmain/package.json":
      '{ "name": "jsmain", "main": "index.js" }',
    "node_modules/jsmain/index.js": "module.exports = {}",
    "node_modules/jsmain/index.css": ".jsmain {}",
  });
  const find = (specifier: string) => {
    const file = findPackageStylesheet(specifier, [root]);
    return file && relative(root, file);
  };
  expect(find("exported")).toBe("node_modules/exported/dist/main.css");
  expect(find("exported/theme")).toBe("node_modules/exported/dist/theme.css");
  expect(find("exported/parts/button")).toBe(
    "node_modules/exported/dist/parts/button.css",
  );
  // Not exported, even though the file exists.
  expect(find("exported/dist/parts/hidden.css")).toBeNull();
  expect(find("exported/index.css")).toBeNull();
  // A main that is a script is not a stylesheet.
  expect(find("jsmain")).toBe("node_modules/jsmain/index.css");
  expect(find("nowhere")).toBeNull();
});

test("imports a package's stylesheet by name", async () => {
  const root = await site({
    "node_modules/pretty/package.json":
      '{ "name": "pretty", "main": "index.js", "style": "pretty.css" }',
    "node_modules/pretty/pretty.css": ".pretty { color: pink }\n",
    "node_modules/pretty/extra/more.css": ".more { color: plum }\n",
    "node_modules/@scope/pkg/package.json": '{ "name": "@scope/pkg" }',
    "node_modules/@scope/pkg/index.css": ".scoped { color: navy }\n",
    "local.css": ".local { color: gray }\n",
    "docs/page.css":
      '@import "pretty";\n@import "pretty/extra/more";\n@import "@scope/pkg";\n@import "../local.css";\n',
  });
  const { css } = await bundle(root, "docs/page.css");
  expect(css).toContain(".pretty");
  expect(css).toContain(".more");
  expect(css).toContain(".scoped");
  expect(css).toContain(".local");
  // A package that is not installed is not fetched from anywhere.
  expect(bundle(root, "page.css", '@import "left-pad";')).rejects.toThrow(
    /Cannot find the stylesheet "left-pad"/,
  );
});

test("reports an import that cannot be found", async () => {
  const root = await site({});
  expect(bundle(root, "page.css", '@import "./missing.css";')).rejects.toThrow(
    /Cannot find the stylesheet ".\/missing.css"/,
  );
});

test("leaves a stylesheet without imports as it is written", async () => {
  const root = await site({});
  const code = "body {\n  color:   red;\n}\n";
  expect((await bundle(root, "page.css", code)).css).toBe(code);
});

test("preserves layer declarations before imports and semicolons in remote URLs", async () => {
  const root = await site({ "a.css": ".a { color: red }" });
  const fonts =
    "https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap";
  const sheet = await bundle(
    root,
    "page.css",
    `@charset "utf-8";\n/*! license */\n@layer base, theme;\n@import url("${fonts}") layer(theme);\n@import "./a.css" layer(base);`,
  );
  expect(sheet.css.indexOf("@layer base, theme;")).toBeLessThan(
    sheet.css.indexOf("@import"),
  );
  expect(scanImports(sheet.css)[0]!.target).toBe(fonts);
  const minified = minifyCss(sheet.css, "combined.css");
  expect(minified.indexOf("@layer base,theme;")).toBeLessThan(
    minified.indexOf("@import"),
  );
  expect(minified).toContain(fonts);
});

test("leaves url() imports to the bundler", async () => {
  const root = await site({
    "node_modules/pkg/package.json": '{ "name": "pkg", "style": "pkg.css" }',
    "node_modules/pkg/pkg.css":
      '@import url("./base.css");\n.pkg { color: red }\n',
    "node_modules/pkg/base.css": ".base { color: blue }\n",
  });
  const emitted: string[] = [];
  const { css } = await bundleStylesheet({
    file: path.join(root, "page.css"),
    code: '@import "pkg";\n',
    root,
    cssModules: false,
    emitAsset(file) {
      emitted.push(relative(root, file));
      return `/_svdr/assets/${path.basename(file)}`;
    },
  });
  expect(emitted).toEqual([]);
  expect(css).toContain(".base");
  expect(css).toContain(".pkg");
});

test("serves assets of packages above the served directory", async () => {
  const project = await site({
    "node_modules/fonts/package.json":
      '{ "name": "fonts", "style": "fonts.css" }',
    "node_modules/fonts/fonts.css": "@font-face { src: url(./font.woff2) }\n",
    "node_modules/fonts/font.woff2": "woff2",
    "public/page.css": '@import "fonts";\n',
  });
  const root = path.join(project, "public");
  const emitted: string[] = [];
  const { css } = await bundleStylesheet({
    file: path.join(root, "page.css"),
    root,
    cssModules: false,
    emitAsset(file) {
      emitted.push(relative(project, file));
      return `/_svdr/assets/${path.basename(file)}`;
    },
  });
  expect(emitted).toEqual(["node_modules/fonts/font.woff2"]);
  expect(css).toContain("/_svdr/assets/font.woff2");
});

test("resolves a linked package's imports from where it really is", async () => {
  const project = await site({
    "pkgs/linked/package.json": '{ "name": "linked", "style": "linked.css" }',
    "pkgs/linked/linked.css": '@import "dep";\n.linked { color: red }\n',
    "pkgs/linked/node_modules/dep/package.json": '{ "name": "dep" }',
    "pkgs/linked/node_modules/dep/index.css": ".dep { version: own }\n",
    "site/node_modules/dep/package.json": '{ "name": "dep" }',
    "site/node_modules/dep/index.css": ".dep { version: site }\n",
    "site/page.css": '@import "linked";\n',
  });
  await symlink(
    path.join(project, "pkgs/linked"),
    path.join(project, "site/node_modules/linked"),
  );
  const root = path.join(project, "site");
  const { css, files } = await bundle(root, "page.css");
  expect(css).toContain("version: own");
  expect(css).not.toContain("version: site");
  expect(files.map((file) => relative(project, file))).toEqual([
    "pkgs/linked/linked.css",
    "pkgs/linked/node_modules/dep/index.css",
  ]);
});

test("picks the most specific export pattern", async () => {
  const root = await site({
    "node_modules/pkg/package.json": JSON.stringify({
      name: "pkg",
      exports: { "./*": "./generic/*.css", "./theme/*": "./themes/*.css" },
    }),
    "node_modules/pkg/generic/theme/dark.css": ".generic {}",
    "node_modules/pkg/themes/dark.css": ".theme {}",
  });
  expect(relative(root, findPackageStylesheet("pkg/theme/dark", [root])!)).toBe(
    "node_modules/pkg/themes/dark.css",
  );
});

test("retains each repeated import and every path through a shared dependency", async () => {
  const root = await site({
    "shared.css":
      '@import "https://example.com/remote.css"; .shared { color: red }',
    "a.css": '@import "./shared.css";',
    "b.css": '@import "./shared.css";',
  });
  for (const [a, b] of [
    ["shared.css", "shared.css"],
    ["a.css", "b.css"],
  ]) {
    const sheet = await bundle(
      root,
      "page.css",
      `@import "./${a}" screen; @import "./${b}" print;`,
    );
    const rules = scanImports(sheet.css);
    expect(rules.map((rule) => rule.conditions)).toEqual(["screen", "print"]);
    for (const rule of rules) {
      let css = imported(sheet, rule.target);
      if (!css.includes("https://"))
        css = imported(sheet, scanImports(css)[0]!.target);
      expect(scanImports(css)[0]!.target).toBe(
        "https://example.com/remote.css",
      );
    }
  }
});

test("leaves nested media and supports conditions intact", async () => {
  const root = await site({
    "child.css":
      '@import "https://example.com/remote.css" supports(display: grid) screen; .child { color: red }',
  });
  for (const condition of [
    "not print",
    "(hover) or (color)",
    'supports(font-family: "x)y")',
  ]) {
    const sheet = await bundle(
      root,
      "page.css",
      `@import "./child.css" ${condition};`,
    );
    const [rule] = scanImports(sheet.css);
    expect(rule!.conditions).toBe(condition);
    const child = imported(sheet, rule!.target);
    expect(scanImports(child)[0]!.conditions).toBe(
      "supports(display: grid) screen",
    );
    expect(() => minifyCss(sheet.css, "page.css")).not.toThrow();
    expect(() => minifyCss(child, "child.css")).not.toThrow();
  }
});

test("keeps remote and local rules in the same anonymous layer", async () => {
  const root = await site({
    "child.css":
      '@import "https://example.com/remote.css"; .child { color: red !important }',
  });
  const sheet = await bundle(root, "page.css", '@import "./child.css" layer;');
  const [rule] = scanImports(sheet.css);
  expect(rule!.conditions).toBe("layer");
  const child = imported(sheet, rule!.target);
  expect(scanImports(child)[0]!.conditions).toBe("");
  expect(child).toContain(".child");
  expect(child).not.toContain("@layer");
});

test("does not remove repeated remote imports", async () => {
  const root = await site({});
  const code =
    '@import "https://example.com/a.css"; @import "https://example.com/b.css"; @import "https://example.com/a.css";';
  const sheet = await bundle(root, "page.css", code);
  expect(scanImports(sheet.css).map((rule) => rule.target)).toEqual([
    "https://example.com/a.css",
    "https://example.com/b.css",
    "https://example.com/a.css",
  ]);
});

test("retained graphs handle cycles and invalidate transitive dependency URLs", async () => {
  const root = await site({
    "a.css": '@import "./b.css"; .a { color: red }',
    "b.css": '@import "https://example.com/remote.css"; @import "./a.css";',
  });
  const first = await bundle(root, "a.css");
  const child = imported(first, scanImports(first.css)[0]!.target);
  const back = scanImports(child)[1]!.target;
  expect(imported(first, back)).toBe(first.css);
  expect((await bundle(root, "a.css")).css).toBe(first.css);
  await writeFile(
    path.join(root, "b.css"),
    '@import "https://example.com/other.css"; @import "./a.css";',
  );
  const next = await bundle(root, "a.css");
  expect(next.css).not.toBe(first.css);
  expect(next.files).toContain(path.join(root, "b.css"));
});

test("null export targets block conditions, arrays, and extension fallback", async () => {
  const root = await site({
    "node_modules/blocked/package.json": JSON.stringify({
      exports: {
        ".": { style: null, default: "./index.css" },
        "./array": [null, "./index.css"],
        "./private": null,
        "./private.css": "./index.css",
        "./available.css": { browser: "./missing.css", style: "./index.css" },
      },
    }),
    "node_modules/blocked/index.css": ".unexpected { color: red }",
  });
  for (const specifier of ["blocked", "blocked/array", "blocked/private"]) {
    expect(findPackageStylesheet(specifier, [root])).toBeNull();
    expect(bundle(root, "page.css", `@import "${specifier}";`)).rejects.toThrow(
      "Cannot find the stylesheet",
    );
  }
  expect(findPackageStylesheet("blocked/available", [root])).toBe(
    path.join(root, "node_modules/blocked/index.css"),
  );
});

test("bundles imports however they are spelled", async () => {
  const root = await site({
    "node_modules/pkg/package.json": '{ "name": "pkg", "style": "pkg.css" }',
    "node_modules/pkg/pkg.css": ".pkg { color: red }\n",
    "local file.css": ".local { color: blue }\n",
  });
  const { css } = await bundle(
    root,
    "page.css",
    '@\\69mport "pkg";\n@import "./local%20file.css";\n',
  );
  expect(css).toContain(".pkg");
  expect(css).toContain(".local");
  expect(css).not.toContain("@");
});

test("CSS module composition stays valid beside remote imports", async () => {
  const root = await site({
    "base.module.css": ".base { composes: globalName from global; color: red }",
    "child.module.css":
      '.child { composes: base from "./base.module.css"; color: blue }',
  });
  const sheet = await bundle(
    root,
    "page.module.css",
    '@import "https://example.com/remote.css"; .middle { composes: child from "./child.module.css"; } .box { composes: middle; color: green }',
    true,
  );
  const classes = (
    await import(
      "data:text/javascript;base64," + Buffer.from(sheet.js!).toString("base64")
    )
  ).default;
  const names = classes.box.split(" ");
  expect(names).toHaveLength(5);
  expect(names).toContain("globalName");
  const allCss = [sheet.css, ...sheet.assets.map((asset) => asset.css)].join(
    "\n",
  );
  for (const name of names.filter((name: string) => name !== "globalName")) {
    expect(allCss).toContain(`.${name}`);
  }
  for (const css of [sheet.css, ...sheet.assets.map((asset) => asset.css)]) {
    expect(() => minifyCss(css, "module.css")).not.toThrow();
  }
  const first = scanImports(sheet.css)[0]!;
  const child = imported(sheet, first.target);
  expect(imported(sheet, scanImports(child)[0]!.target)).toContain(
    "color: red",
  );
});

test("CSS modules retain repeated conditional imports and layer order", async () => {
  const root = await site({
    "child.module.css":
      '@import "https://example.com/remote.css"; .child { color: red }',
  });
  const sheet = await bundle(
    root,
    "page.module.css",
    '@layer base, theme; @import "./child.module.css" layer(theme) screen; @import "./child.module.css" layer(theme) print; .box { color: blue }',
    true,
  );
  expect(scanImports(sheet.css).map((rule) => rule.conditions)).toEqual([
    "layer(theme) screen",
    "layer(theme) print",
  ]);
  expect(sheet.css.indexOf("@layer base, theme")).toBeLessThan(
    sheet.css.indexOf("@import"),
  );
  expect(sheet.js).toContain('"box"');
  expect(() => minifyCss(sheet.css, "module.css")).not.toThrow();
});

test("retained asset URLs distinguish plain CSS, modules, and minified output", async () => {
  const root = await site({ "child.css": ".child { color: red }" });
  const options = {
    root,
    file: path.join(root, "page.css"),
    cssModules: false,
    code: '@import "https://example.com/remote.css"; @import "./child.css";',
  };
  const plain = await bundleStylesheet(options);
  const modules = await bundleStylesheet({ ...options, cssModules: true });
  const minified = await bundleStylesheet({ ...options, minifyAssets: true });
  expect(
    new Set([plain.fileName, modules.fileName, minified.fileName]).size,
  ).toBe(3);
  expect(minified.assets.every((asset) => !asset.css.includes("\n"))).toBe(
    true,
  );
});

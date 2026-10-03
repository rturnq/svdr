import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Bundler } from "../src/bundler.ts";
import { scanImports } from "../src/css.ts";
import { loadMarko } from "../src/marko.ts";

const directories: string[] = [];
afterAll(() =>
  Promise.all(
    directories.map((root) => rm(root, { recursive: true, force: true })),
  ),
);

async function site(files: Record<string, string>) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "svdr-bundle-")),
  );
  directories.push(root);
  for (const [name, code] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), code);
  }
  return root;
}

const render = async (bundler: Bundler, root: string) =>
  String(
    await bundler.pages
      .get(path.join(root, "index.marko"))!
      .template!.render({}),
  );
const cssBody = (bundler: Bundler, url: string) => {
  const asset = bundler.assets.get(url);
  expect(asset?.type).toBe("text/css; charset=utf-8");
  return Buffer.from(asset!.body).toString();
};

test("rebuilds when a package imports mapping changes or is removed", async () => {
  const root = await site({
    "package.json": JSON.stringify({
      type: "module",
      imports: { "#label": "./a.js" },
    }),
    "a.js": 'export const label = "A";',
    "b.js": 'export const label = "B";',
    "index.marko": 'import { label } from "#label";\n<p>${label}</p>',
  });
  const bundler = new Bundler({
    root,
    marko: await loadMarko(root),
    prod: false,
  });
  try {
    expect((await bundler.scan()).error).toBeUndefined();
    expect(await render(bundler, root)).toContain("<p>A</p>");
    const manifest = path.join(root, "package.json");
    await writeFile(
      manifest,
      JSON.stringify({ type: "module", imports: { "#label": "./b.js" } }),
    );
    const update = await bundler.update([manifest]);
    expect(update.build).toBeDefined();
    expect(update.build!.error).toBeUndefined();
    expect(update.bundled.has(manifest)).toBe(true);
    expect(await render(bundler, root)).toContain("<p>B</p>");
    await rm(manifest);
    expect((await bundler.update([manifest])).build?.error).toBeDefined();
  } finally {
    await bundler.close();
  }
});

for (const prod of [false, true]) {
  test(`preserves import boundaries and duplicates in ${prod ? "production" : "development"}`, async () => {
    const root = await site({
      "index.marko":
        'import "./before.css";\nimport "./remote.css";\nimport "./after.css";\n<p/>',
      "before.css": ".before { color: red }",
      "remote.css":
        '@layer base, theme; @import "https://example.com/a.css" layer(theme); @import "https://example.com/b.css"; @import "https://example.com/a.css" layer(theme); @import "./child.css" layer;',
      "child.css":
        '@import "https://example.com/child.css"; .child { color: blue !important }',
      "after.css": ".after { color: green }",
    });
    const bundler = new Bundler({ root, marko: await loadMarko(root), prod });
    try {
      expect((await bundler.scan()).error).toBeUndefined();
      const html = await render(bundler, root);
      const urls = Array.from(
        html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g),
        (match) => match[1]!,
      );
      expect(urls).toHaveLength(3);
      const [before, remote, after] = urls.map((url) => cssBody(bundler, url));
      expect(before).toContain(".before");
      expect(after).toContain(".after");
      const rules = scanImports(remote!);
      expect(rules.map((rule) => rule.target).slice(0, 3)).toEqual([
        "https://example.com/a.css",
        "https://example.com/b.css",
        "https://example.com/a.css",
      ]);
      expect(remote!.indexOf("@layer")).toBeLessThan(
        remote!.indexOf("@import"),
      );
      expect(rules[3]!.conditions).toBe("layer");
      const child = cssBody(bundler, rules[3]!.target);
      expect(child).toContain(".child");
      expect(scanImports(child)[0]!.conditions).toBe("");
      if (prod) {
        expect(remote).not.toContain("\n");
        expect(child).not.toContain("\n");
      }
      // Editing a retained child changes the entry URL and its dependency URL.
      await writeFile(
        path.join(root, "child.css"),
        '@import "https://example.com/child.css"; .child { color: purple !important }',
      );
      expect(
        (await bundler.update([path.join(root, "child.css")])).build?.error,
      ).toBeUndefined();
      const nextHtml = await render(bundler, root);
      expect(nextHtml).not.toContain(urls[1]!);
      const nextUrls = Array.from(
        nextHtml.matchAll(/<link rel="stylesheet" href="([^"]+)"/g),
        (match) => match[1]!,
      );
      const nextChild = scanImports(cssBody(bundler, nextUrls[1]!))[3]!.target;
      expect(nextChild).not.toBe(rules[3]!.target);
      expect(cssBody(bundler, nextChild)).toContain("purple");
    } finally {
      await bundler.close();
    }
  });
}

test("cyclic CSS uses the same URL for the linked entry and its back edge", async () => {
  const root = await site({
    "index.marko": 'import "./a.css";\n<p/>',
    "a.css": '@import "./b.css"; .a { color: red }',
    "b.css": '@import "https://example.com/remote.css"; @import "./a.css";',
  });
  const bundler = new Bundler({
    root,
    marko: await loadMarko(root),
    prod: false,
  });
  try {
    expect((await bundler.scan()).error).toBeUndefined();
    const html = await render(bundler, root);
    const url = /<link rel="stylesheet" href="([^"]+)"/.exec(html)![1]!;
    const childUrl = scanImports(cssBody(bundler, url))[0]!.target;
    expect(scanImports(cssBody(bundler, childUrl))[1]!.target).toBe(url);
  } finally {
    await bundler.close();
  }
});

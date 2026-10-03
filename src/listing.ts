import { assetsPrefix, assetUrl, type Asset } from "./bundler.ts";

/** Local time in the local language. */
const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});

/** The page at the assets prefix, listing every bundled file. */
export function renderListing(assets: ReadonlyMap<string, Asset>): string {
  const sorted = [...assets].sort(([a], [b]) => a.localeCompare(b));
  const total = sorted.reduce((sum, [, asset]) => sum + asset.body.length, 0);
  const rows = sorted.map(([url, asset]) => {
    const name = url.slice(assetsPrefix.length);
    return (
      `<tr><td><a href="${Bun.escapeHTML(assetUrl(name))}">${Bun.escapeHTML(name)}</a></td>` +
      `<td class="size">${formatSize(asset.body.length)}</td>` +
      `<td><time datetime="${asset.updated.toISOString()}">${dateFormat.format(asset.updated)}</time></td></tr>`
    );
  });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bundled files</title>
<style>
body { font-family: system-ui, sans-serif; margin: 2rem; }
table { border-collapse: collapse; }
th, td { padding: 0.25rem 1.5rem 0.25rem 0; text-align: left; }
th { border-bottom: 1px solid; }
.size { text-align: right; font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
<h1>Bundled files</h1>
${
  sorted.length
    ? `<p>${sorted.length} file${sorted.length === 1 ? "" : "s"}, ${formatSize(total)} in total before compression.</p>
<table>
<thead><tr><th>File</th><th class="size">Size</th><th>Last updated</th></tr></thead>
<tbody>
${rows.join("\n")}
</tbody>
</table>`
    : "<p>No files have been bundled.</p>"
}
</body>
</html>
`;
}

function formatSize(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} kB`;
}

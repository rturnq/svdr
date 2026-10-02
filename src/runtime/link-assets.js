let assets = {};
const kSeen = Symbol();
const escape = (value) =>
  String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;");

export function register(value) {
  assets = value;
}

export function flush(g, type, assetId) {
  const entry = assets[assetId];
  if (!entry) return "";
  const seen = (g[kSeen] ||= new Set());
  const nonce = g.cspNonce ? ` nonce="${escape(g.cspNonce)}"` : "";
  let html = "";
  for (const [tag, url] of type === "block" ? entry.block : entry.defer) {
    if (seen.has(url)) continue;
    seen.add(url);
    const src = escape(url);
    switch (tag) {
      case "style":
        html += `<link rel="stylesheet" href="${src}"${nonce}>`;
        break;
      case "preload":
        html += `<link rel="modulepreload" href="${src}"${nonce}>`;
        break;
      case "script":
        html += `<script type="module" src="${src}"${nonce}></script>`;
        break;
    }
  }
  return html;
}

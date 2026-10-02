// The socket is served next to this script, under the same name without the extension.
const url = new URL(import.meta.url);
url.pathname = url.pathname.replace(/\.js$/, "");
url.protocol = url.protocol.replace("http", "ws");
url.search = "";
let lost = false;

function connect() {
  const socket = new WebSocket(url);
  socket.onopen = () => {
    // The server was restarted, so anything may have changed.
    if (lost) location.reload();
  };
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    switch (message.type) {
      case "reload":
        location.reload();
        break;
      case "styles":
        swapStyles(message);
        break;
      case "error":
        console.error("[svdr] " + message.message);
        break;
    }
  };
  socket.onclose = () => {
    lost = true;
    setTimeout(connect, 1000);
  };
}

function swapStyles({ styles, files }) {
  for (const link of document.querySelectorAll('link[rel~="stylesheet"]')) {
    const current = new URL(link.href);
    if (current.origin !== location.origin) continue;
    const path = decodeURI(current.pathname);
    const replaced = styles.find(([from]) => from === path);
    if (replaced) {
      swap(link, encodeURI(replaced[1]));
    } else if (files.includes(path)) {
      // The URL stays the same, so the query is what makes the browser fetch it again.
      swap(link, current.pathname + "?v=" + Date.now());
    }
  }
}

function swap(link, href) {
  const next = link.cloneNode();
  next.href = href;
  // The old stylesheet stays until the new one is ready to avoid a flash of unstyled content.
  next.onload = next.onerror = () => link.remove();
  link.after(next);
}

connect();

// Trip Budget service worker
// A "service worker" is a small script the browser keeps running in the background for this website.
// This one saves a copy of the app on the phone, so it opens even with no signal at all.
//
// How it works:
// 1. The first time you open the website, "install" saves the app's files into a cache.
// 2. After that, every time the app asks for a file, "fetch" answers straight from the cache
//    (instant, and works offline), then quietly downloads a fresh copy for next time.
// 3. If that fresh copy of the app is different, the page is told, and shows "Update ready".
//
// Your expenses are NOT stored here: they stay in the app's own storage, as before.

const CACHE = "trip-budget-v2";   // change this name whenever the list of files below changes
const APP_FILES = [
  "./index.html",
  "./manifest.webmanifest",
  "./icon-180.png",
  "./icon-192.png",
  "./icon-512.png"
];
// The fonts come from Google, so we keep a copy of those too.
// FONT_CSS must be exactly the same address as the fonts <link> in index.html.
const FONT_HOSTS = ["https://fonts.googleapis.com", "https://fonts.gstatic.com"];
const FONT_CSS = "https://fonts.googleapis.com/css2?family=Onest:wght@400;500;600;700&display=swap";

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(async cache => {
        await cache.addAll(APP_FILES);
        await cacheFonts(cache);
      })
      .then(() => self.skipWaiting())   // start working straight away
  );
});

// Save the fonts' stylesheet and every font file it points to
async function cacheFonts(cache) {
  try {
    const cssResponse = await fetch(FONT_CSS, { mode: "cors" });
    if (!cssResponse.ok) return;
    const css = await cssResponse.clone().text();
    await cache.put(FONT_CSS, cssResponse);
    const fontFiles = [...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map(match => match[1]);
    await Promise.all(fontFiles.map(file =>
      fetch(file, { mode: "cors" }).then(response => (response.ok ? cache.put(file, response) : null))));
  } catch (err) {
    // No problem: the fonts get saved the next time the app is opened with a connection
  }
}

self.addEventListener("activate", event => {
  // Delete caches from older versions of this file (e.g. "trip-budget-v0")
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())   // take charge of pages that are already open
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  const ours = url.origin === self.location.origin;
  const font = FONT_HOSTS.includes(url.origin);
  if (!ours && !font) return;   // anything else goes to the internet as normal

  if (request.mode === "navigate") {
    // Opening the app (any address in this folder) always uses the saved index.html
    event.respondWith(fromCacheThenUpdate(event, "./index.html", true));
  } else {
    event.respondWith(fromCacheThenUpdate(event, request, false));
  }
});

// Answer from the cache if we can, and refresh the cache from the internet in the background
async function fromCacheThenUpdate(event, key, isPage) {
  const cache = await caches.open(CACHE);
  // ignoreSearch: our own files match whatever "?..." follows them. Fonts need their exact address.
  const cached = await cache.match(key, { ignoreSearch: !isFontRequest(key), ignoreVary: true });
  // A response can only be read once. `cached` is about to be handed to the browser,
  // so keep a second copy now for comparing with the fresh download later.
  const cachedCopy = isPage && cached ? cached.clone() : null;

  const refresh = fetch(event.request)
    .then(async response => {
      // "opaque" = a file from another website (the Google Fonts stylesheet) that we can store but not read
      if (response && (response.ok || (!isPage && response.type === "opaque"))) {
        if (cachedCopy) {
          const [oldText, newText] = await Promise.all([cachedCopy.text(), response.clone().text()]);
          if (oldText !== newText) tellPagesAboutUpdate(event);
        }
        await cache.put(key, response.clone());
      }
      return response;
    })
    .catch(() => null);   // no signal: that's fine, we have the cached copy

  if (cached) {
    event.waitUntil(refresh);   // let the background refresh finish
    return cached;
  }
  // Nothing saved yet (the very first visit): we have to wait for the internet
  const response = await refresh;
  if (response) return response;
  return isPage
    ? new Response("<h1>Offline</h1><p>Open Trip Budget once with an internet connection first.</p>",
        { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } })
    : Response.error();
}

function isFontRequest(key) {
  const address = typeof key === "string" ? key : key.url;
  return FONT_HOSTS.some(host => address.startsWith(host));
}

async function tellPagesAboutUpdate(event) {
  const pages = await self.clients.matchAll({ type: "window" });
  // When the app is being opened, the new page doesn't exist yet: wait for it, then tell it too
  if (event.resultingClientId) {
    const opening = await self.clients.get(event.resultingClientId);
    if (opening && !pages.some(page => page.id === opening.id)) pages.push(opening);
  }
  pages.forEach(page => page.postMessage({ type: "app-updated" }));
}

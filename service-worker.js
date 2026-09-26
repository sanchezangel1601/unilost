const CACHE_NAME = "unilost-v1.6.0";

const FILES_TO_CACHE = [
    "./",
    "./index.html",
    "./style.css",
    "./app.js",
    "./manifest.json",
    "./node_modules/@azure/msal-browser/lib/msal-browser.min.js",
    "./icons/icon-192.png",
    "./icons/icon-512.png"
];

self.addEventListener("install", event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(FILES_TO_CACHE))
    );

    self.skipWaiting();
});

self.addEventListener("activate", event => {
    event.waitUntil(
        caches.keys().then(cacheNames =>
            Promise.all(
                cacheNames
                    .filter(name => name !== CACHE_NAME)
                    .map(name => caches.delete(name))
            )
        )
    );

    self.clients.claim();
});

self.addEventListener("fetch", event => {
    const requestUrl = new URL(event.request.url);
    if (requestUrl.origin === self.location.origin && requestUrl.pathname.endsWith("/auth-config.js")) {
        event.respondWith(fetch(event.request, { cache: "no-store" }).catch(() => new Response(
            'window.UNILOST_AUTH_CONFIG = { clientId: "", authority: "https://login.microsoftonline.com/organizations", redirectUri: "", institutionalEmail: "22090889@alumno.utmetropolitana.edu.mx" };',
            { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" } }
        )));
        return;
    }

    if (requestUrl.origin === self.location.origin && requestUrl.pathname.startsWith("/api/")) {
        event.respondWith(fetch(event.request).catch(() => new Response(
            JSON.stringify({ error: "Sin conexión. El cambio permanece en la cola local." }),
            { status: 503, headers: { "Content-Type": "application/json" } }
        )));
        return;
    }

    if (event.request.method !== "GET") {
        return;
    }
    event.respondWith(
        caches.match(event.request)
            .then(cachedResponse => {
                if (cachedResponse) {
                    return cachedResponse;
                }

                return fetch(event.request);
            })
            .catch(() => caches.match("./index.html"))
    );
});

async function readStoreValues(database, storeName) {
    return new Promise((resolve, reject) => {
        const request = database.transaction(storeName, "readonly").objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function syncOfflineQueue() {
    const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open("unilost-offline", 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    const [records, settings] = await Promise.all([
        readStoreValues(database, "objects"),
        readStoreValues(database, "settings")
    ]);
    const token = settings.find(setting => setting.key === "token")?.value;
    if (!token) {
        return;
    }

    const pending = records.filter(record => record.syncStatus === "pending" && !record.deleted);
    const deletedIds = records.filter(record => record.deleted).map(record => record.id);
    if (pending.length === 0 && deletedIds.length === 0) {
        return;
    }

    const response = await fetch("./api/objects/sync", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ objects: pending, deletedIds })
    });
    if (!response.ok) {
        throw new Error("No se pudo sincronizar la cola offline.");
    }
    const result = await response.json();
    const acceptedIds = new Set(result.acceptedIds);
    const removedIds = new Set(result.deletedIds);
    const transaction = database.transaction("objects", "readwrite");
    const objectStore = transaction.objectStore("objects");
    records.forEach(record => {
        if (removedIds.has(record.id)) {
            objectStore.delete(record.id);
        } else if (acceptedIds.has(record.id)) {
            objectStore.put({ ...record, syncStatus: "synced" });
        }
    });
    result.objects.forEach(remote => {
        const local = records.find(record => record.id === remote.id);
        if (!local || local.syncStatus === "synced") {
            objectStore.put({ ...remote, syncStatus: "synced", deleted: false });
        }
    });
    await new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
    });
}

self.addEventListener("sync", event => {
    if (event.tag === "unilost-sync") {
        event.waitUntil(syncOfflineQueue());
    }
});

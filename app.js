const form = document.getElementById("objectForm");
const objectsContainer = document.getElementById("objectsContainer");
const emptyMessage = document.getElementById("emptyMessage");
const mineContainer = document.getElementById("mineContainer");
const mineEmpty = document.getElementById("mineEmpty");
const mineCount = document.getElementById("mineCount");
const searchInput = document.getElementById("search");
const counter = document.getElementById("counter");
const filterButtons = document.querySelectorAll(".filter");
const navButtons = document.querySelectorAll(".nav-link");
const pageViews = document.querySelectorAll(".page-view");
const installButton = document.getElementById("installButton");
const shareButton = document.getElementById("shareButton");
const loginView = document.getElementById("loginView");
const appView = document.getElementById("appView");
const loginForm = document.getElementById("loginForm");
const registerButton = document.getElementById("registerButton");
const microsoftLoginButton = document.getElementById("microsoftLoginButton");
const microsoftMessage = document.getElementById("microsoftMessage");
const institutionEmail = document.getElementById("institutionEmail");
const registerForm = document.getElementById("registerForm");
const registerMessage = document.getElementById("registerMessage");
const backToLoginButton = document.getElementById("backToLoginButton");
const loginMessage = document.getElementById("loginMessage");
const currentUser = document.getElementById("currentUser");
const syncStatus = document.getElementById("syncStatus");
const logoutButton = document.getElementById("logoutButton");
const detailDialog = document.getElementById("detailDialog");
const detailContent = document.getElementById("detailContent");
const closeDetail = document.getElementById("closeDetail");
const photoInput = document.getElementById("photo");
const imagePreview = document.getElementById("imagePreview");
const previewImage = document.getElementById("previewImage");

let objects = [];
let currentFilter = "Todos";
let activeUser = localStorage.getItem("unilost_session") || "";
let previewImageUrl = null;
let databasePromise = null;
let syncInProgress = false;
let msalApplication = null;

const authConfig = window.UNILOST_AUTH_CONFIG || {};
institutionEmail.textContent = authConfig.institutionalEmail || "";

function openDatabase() {
    if (!databasePromise) {
        databasePromise = new Promise((resolve, reject) => {
            const request = indexedDB.open("unilost-offline", 1);
            request.onupgradeneeded = () => {
                const database = request.result;
                if (!database.objectStoreNames.contains("objects")) {
                    database.createObjectStore("objects", { keyPath: "id" });
                }
                if (!database.objectStoreNames.contains("settings")) {
                    database.createObjectStore("settings", { keyPath: "key" });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }
    return databasePromise;
}

async function databaseRequest(storeName, mode, operation) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, mode);
        const request = operation(transaction.objectStore(storeName));
        let result;
        if (request) {
            request.onsuccess = () => { result = request.result; };
            request.onerror = () => reject(request.error);
        }
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || new Error("No se pudo guardar en el dispositivo."));
    });
}

function getStoredObjects() {
    return databaseRequest("objects", "readonly", store => store.getAll());
}

function saveStoredObject(object) {
    return databaseRequest("objects", "readwrite", store => store.put(object));
}

function saveStoredObjects(records) {
    return databaseRequest("objects", "readwrite", store => records.forEach(record => store.put(record)));
}

function deleteStoredObject(id) {
    return databaseRequest("objects", "readwrite", store => store.delete(id));
}

function getStoredSetting(key) {
    return databaseRequest("settings", "readonly", store => store.get(key));
}

function saveStoredSetting(key, value) {
    return databaseRequest("settings", "readwrite", store => store.put({ key, value }));
}

function deleteStoredSetting(key) {
    return databaseRequest("settings", "readwrite", store => store.delete(key));
}

function getAccounts() {
    return JSON.parse(localStorage.getItem("unilost_accounts")) || {};
}

async function apiRequest(endpoint, options = {}) {
    const token = localStorage.getItem("unilost_token");
    const headers = { ...(options.headers || {}) };
    if (options.body) {
        headers["Content-Type"] = "application/json";
    }
    if (token) {
        headers.Authorization = `Bearer ${token}`;
    }

    let response;
    try {
        response = await fetch(endpoint, { ...options, headers });
    } catch {
        const error = new Error("No hay conexión con el servidor. La información permanece guardada en este dispositivo.");
        error.isNetworkError = true;
        throw error;
    }

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(result.error || "No se pudo completar la solicitud.");
        error.status = response.status;
        throw error;
    }
    return result;
}

function setSyncStatus(state, message) {
    syncStatus.className = `sync-pill ${state}`;
    syncStatus.textContent = message;
}

async function requestBackgroundSync() {
    if (!("serviceWorker" in navigator) || !("SyncManager" in window)) {
        return;
    }
    try {
        const registration = await navigator.serviceWorker.ready;
        await registration.sync.register("unilost-sync");
    } catch {
        // Online events and app startup remain as the fallback.
    }
}

async function loadObjects() {
    const records = await getStoredObjects();
    const byId = new Map(records.map(record => [record.id, record]));
    const legacyData = localStorage.getItem("unilost_objects");
    if (legacyData) {
        try {
            JSON.parse(legacyData).forEach(record => {
                if (!byId.has(record.id)) {
                    byId.set(record.id, { ...record, syncStatus: "pending", deleted: false });
                }
            });
            localStorage.removeItem("unilost_objects");
        } catch {
            localStorage.removeItem("unilost_objects");
        }
    }

    if (localStorage.getItem("unilost_token") && navigator.onLine) {
        try {
            const remote = await apiRequest("/api/objects");
            remote.objects.forEach(record => {
                const local = byId.get(record.id);
                if (!local || local.syncStatus !== "pending") {
                    byId.set(record.id, { ...record, syncStatus: "synced", deleted: false });
                }
            });
        } catch (error) {
            setSyncStatus("pending", "Sincronización pendiente");
        }
    }

    await saveStoredObjects([...byId.values()]);
    objects = [...byId.values()].filter(record => !record.deleted);
}

async function syncPendingObjects() {
    if (syncInProgress) {
        return;
    }
    if (!navigator.onLine) {
        setSyncStatus("offline", "Sin conexión · guardado en el dispositivo");
        return;
    }
    if (!localStorage.getItem("unilost_token")) {
        setSyncStatus("device", "Solo en este dispositivo");
        return;
    }

    syncInProgress = true;
    setSyncStatus("syncing", "Sincronizando…");
    try {
        const records = await getStoredObjects();
        const pending = records.filter(record => record.syncStatus === "pending" && !record.deleted);
        const deletedIds = records.filter(record => record.deleted).map(record => record.id);
        if (pending.length === 0 && deletedIds.length === 0) {
            setSyncStatus("synced", "Sincronizado");
            syncInProgress = false;
            return;
        }

        const result = await apiRequest("/api/objects/sync", {
            method: "POST",
            body: JSON.stringify({ objects: pending, deletedIds })
        });
        const accepted = new Set(result.acceptedIds);
        const storedById = new Map(records.map(record => [record.id, record]));
        for (const id of accepted) {
            const record = storedById.get(id);
            if (record) {
                record.syncStatus = "synced";
                await saveStoredObject(record);
            }
        }
        for (const id of result.deletedIds) {
            await deleteStoredObject(id);
            storedById.delete(id);
        }
        for (const remote of result.objects) {
            const local = storedById.get(remote.id);
            if (!local || local.syncStatus === "synced") {
                storedById.set(remote.id, { ...remote, syncStatus: "synced", deleted: false });
            }
        }
        await saveStoredObjects([...storedById.values()]);
        objects = [...storedById.values()].filter(record => !record.deleted);
        renderObjects();
        setSyncStatus("synced", "Sincronizado");
    } catch (error) {
        setSyncStatus("pending", "Cambios pendientes de sincronizar");
        console.warn("Sincronización pendiente:", error.message);
    } finally {
        syncInProgress = false;
    }
}

function showApp(username) {
    activeUser = username;
    loginView.classList.add("hidden");
    appView.classList.remove("hidden");
    currentUser.textContent = username;
    setPage("explore");
}

function showLogin(message = "") {
    loginView.classList.remove("hidden");
    appView.classList.add("hidden");
    registerForm.classList.add("hidden");
    loginForm.classList.remove("hidden");
    loginMessage.textContent = message;
}

async function login(username, token = "") {
    localStorage.setItem("unilost_session", username);
    if (token) {
        localStorage.setItem("unilost_token", token);
        await saveStoredSetting("token", token);
    }
    showApp(username);
    await loadObjects();
    renderObjects();
    await syncPendingObjects();
}

loginForm.addEventListener("submit", async event => {
    event.preventDefault();

    const username = document.getElementById("username").value.trim();
    const password = document.getElementById("password").value;
    const accounts = getAccounts();

    try {
        const session = await apiRequest("/api/login", {
            method: "POST",
            body: JSON.stringify({ identity: username, password })
        });
        await login(session.username, session.token);
    } catch (error) {
        if (accounts[username] && accounts[username] === password) {
            await login(username);
            return;
        }
        loginMessage.textContent = error.message;
    }
});

microsoftLoginButton.addEventListener("click", async () => {
    if (!authConfig.clientId) {
        microsoftMessage.textContent = "Falta configurar el Application (client) ID de Microsoft Entra en auth-config.js.";
        return;
    }
    if (!window.msal?.PublicClientApplication) {
        microsoftMessage.textContent = "No se pudo cargar el servicio de Microsoft. Revisa tu conexión e inténtalo otra vez.";
        return;
    }

    microsoftLoginButton.disabled = true;
    microsoftMessage.textContent = "Conectando con Microsoft…";
    try {
        if (!msalApplication) {
            msalApplication = new window.msal.PublicClientApplication({
                auth: {
                    clientId: authConfig.clientId,
                    authority: authConfig.authority,
                    redirectUri: authConfig.redirectUri || window.location.origin
                },
                cache: { cacheLocation: "localStorage" }
            });
            await msalApplication.initialize();
        }

        const loginResult = await msalApplication.loginPopup({
            scopes: ["User.Read"],
            prompt: "select_account",
            loginHint: authConfig.institutionalEmail
        });
        const graphToken = loginResult.accessToken || (await msalApplication.acquireTokenSilent({
            scopes: ["User.Read"],
            account: loginResult.account
        })).accessToken;
        const session = await apiRequest("/api/microsoft/login", {
            method: "POST",
            body: JSON.stringify({ accessToken: graphToken })
        });
        microsoftMessage.textContent = "";
        await login(session.username, session.token);
    } catch (error) {
        microsoftMessage.textContent = error.message || "No se pudo iniciar sesión con Microsoft.";
    } finally {
        microsoftLoginButton.disabled = false;
    }
});

registerButton.addEventListener("click", () => {
    loginMessage.textContent = "";
    loginForm.classList.add("hidden");
    registerForm.classList.remove("hidden");
});

backToLoginButton.addEventListener("click", () => {
    registerMessage.textContent = "";
    registerForm.classList.add("hidden");
    loginForm.classList.remove("hidden");
});

registerForm.addEventListener("submit", async event => {
    event.preventDefault();
    const username = document.getElementById("registerUsername").value.trim();
    const email = document.getElementById("registerEmail").value.trim();
    const password = document.getElementById("registerPassword").value;
    const confirmation = document.getElementById("confirmPassword").value;

    if (password !== confirmation) {
        registerMessage.textContent = "Las contraseñas no coinciden.";
        return;
    }

    registerMessage.textContent = "Creando cuenta...";
    try {
        const session = await apiRequest("/api/register", {
            method: "POST",
            body: JSON.stringify({ username, email, password })
        });
        registerForm.reset();
        await login(session.username, session.token);
    } catch (error) {
        registerMessage.textContent = error.message;
    }
});

logoutButton.addEventListener("click", async () => {
    if (localStorage.getItem("unilost_token")) {
        try {
            await apiRequest("/api/logout", { method: "POST" });
        } catch {
            // Clearing local credentials still prevents offline sync after logout.
        }
    }
    localStorage.removeItem("unilost_session");
    localStorage.removeItem("unilost_token");
    await deleteStoredSetting("token");
    loginForm.reset();
    showLogin();
});

async function saveObjects() {
    const storedObjects = objects.map(object => ({
        ...object,
        syncStatus: object.syncStatus || "pending",
        updatedAt: object.updatedAt || new Date().toISOString()
    }));
    objects = storedObjects;
    await saveStoredObjects(storedObjects);
    await requestBackgroundSync();
    await syncPendingObjects();
}

function createObjectCard(object, canDelete = false) {
    const card = document.createElement("article");
    card.className = "object-card";

    const statusClass = object.type === "Perdido" ? "lost" : "found";
    const statusIcon = object.type === "Perdido" ? "⌕" : "✓";
    const ownerName = object.owner ? escapeHTML(object.owner) : "Comunidad UniLost";

    card.innerHTML = `
        <div class="object-visual ${statusClass}"><span>${statusIcon}</span><small>${escapeHTML(object.type)}</small></div>
        <div class="object-card-body">
            <div class="object-card-meta"><span class="status ${statusClass}">${escapeHTML(object.type)}</span><span>${escapeHTML(object.date)}</span></div>
            <h3>${escapeHTML(object.name)}</h3>
            <p class="object-location"><span aria-hidden="true">⌖</span> ${escapeHTML(object.location)}</p>
            <p class="object-description">${escapeHTML(object.description)}</p>
            <div class="object-card-footer"><span class="owner-avatar">${ownerName.charAt(0).toUpperCase()}</span><span class="owner-name">${ownerName}</span><button class="detail-button" type="button">Ver detalles <span aria-hidden="true">→</span></button></div>
            ${canDelete ? '<button class="delete-button" type="button">Eliminar publicación</button>' : ""}
        </div>
    `;

    if (object.image) {
        const image = document.createElement("img");
        image.src = object.image;
        image.alt = object.name;
        card.querySelector(".object-visual").prepend(image);
        card.querySelector(".object-visual").classList.add("has-image");
    }

    card.querySelector(".detail-button").addEventListener("click", () => showDetails(object));
    if (canDelete) {
        card.querySelector(".delete-button").addEventListener("click", () => deleteObject(object.id));
    }
    return card;
}

function renderObjects() {
    const search = searchInput.value.toLowerCase().trim();
    const matchesQueryAndFilter = object => {
        const matchesSearch =
            object.name.toLowerCase().includes(search) ||
            object.location.toLowerCase().includes(search) ||
            object.description.toLowerCase().includes(search);
        const matchesFilter = currentFilter === "Todos" || object.type === currentFilter;
        return matchesSearch && matchesFilter;
    };
    const filteredObjects = objects.filter(matchesQueryAndFilter);
    const userObjects = objects.filter(object =>
        (!object.owner || object.owner === activeUser) && matchesQueryAndFilter(object)
    );

    objectsContainer.innerHTML = "";
    mineContainer.innerHTML = "";
    counter.textContent = `${filteredObjects.length} objeto(s)`;
    mineCount.textContent = userObjects.length;

    filteredObjects.forEach(object => objectsContainer.appendChild(createObjectCard(object)));
    userObjects.forEach(object => mineContainer.appendChild(createObjectCard(object, true)));
    emptyMessage.classList.toggle("hidden", filteredObjects.length > 0);
    mineEmpty.classList.toggle("hidden", userObjects.length > 0);
}

function setPage(pageName) {
    pageViews.forEach(view => view.classList.toggle("hidden", view.id !== `${pageName}Page`));
    navButtons.forEach(button => {
        const isActive = button.dataset.page === pageName;
        button.classList.toggle("active", isActive);
        if (isActive) {
            button.setAttribute("aria-current", "page");
        } else {
            button.removeAttribute("aria-current");
        }
    });
}

function showDetails(object) {
    const statusClass = object.type === "Perdido" ? "lost" : "found";
    const ownerName = object.owner ? escapeHTML(object.owner) : "Comunidad UniLost";
    detailContent.innerHTML = `
        <div class="detail-visual ${statusClass}"><span>${object.type === "Perdido" ? "⌕" : "✓"}</span></div>
        <div class="detail-body">
            <span class="status ${statusClass}">${escapeHTML(object.type)}</span>
            <h2>${escapeHTML(object.name)}</h2>
            <p class="detail-description">${escapeHTML(object.description)}</p>
            <dl class="detail-facts"><div><dt>Ubicación</dt><dd>${escapeHTML(object.location)}</dd></div><div><dt>Fecha del reporte</dt><dd>${escapeHTML(object.date)}</dd></div><div><dt>Publicado por</dt><dd>${ownerName}</dd></div></dl>
        </div>
    `;
    if (object.image) {
        const image = document.createElement("img");
        image.src = object.image;
        image.alt = object.name;
        detailContent.querySelector(".detail-visual").prepend(image);
        detailContent.querySelector(".detail-visual").classList.add("has-image");
    }
    detailDialog.showModal();
}

function compressImage(file) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        const reader = new FileReader();

        reader.onerror = () => reject(new Error("No se pudo leer la imagen."));
        image.onerror = () => reject(new Error("El formato de la imagen no es válido."));
        reader.onload = () => {
            image.onload = () => {
                const scale = Math.min(1, 1000 / Math.max(image.naturalWidth, image.naturalHeight));
                const canvas = document.createElement("canvas");
                canvas.width = Math.round(image.naturalWidth * scale);
                canvas.height = Math.round(image.naturalHeight * scale);
                canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL("image/jpeg", 0.76));
            };
            image.src = reader.result;
        };
        reader.readAsDataURL(file);
    });
}

photoInput.addEventListener("change", () => {
    const file = photoInput.files[0];
    if (previewImageUrl) {
        URL.revokeObjectURL(previewImageUrl);
    }
    if (!file) {
        imagePreview.classList.add("hidden");
        previewImageUrl = null;
        return;
    }
    previewImageUrl = URL.createObjectURL(file);
    previewImage.src = previewImageUrl;
    imagePreview.classList.remove("hidden");
});

form.addEventListener("submit", async event => {
    event.preventDefault();

    let image = "";
    if (photoInput.files[0]) {
        try {
            image = await compressImage(photoInput.files[0]);
        } catch (error) {
            alert(error.message);
            return;
        }
    }

    const newObject = {
        id: Date.now().toString(),
        type: form.querySelector('input[name="type"]:checked').value,
        name: document.getElementById("name").value.trim(),
        description: document.getElementById("description").value.trim(),
        location: document.getElementById("location").value.trim(),
        date: document.getElementById("date").value,
        owner: activeUser,
        image,
        syncStatus: "pending",
        updatedAt: new Date().toISOString()
    };

    objects.unshift(newObject);
    await saveObjects();
    form.reset();
    imagePreview.classList.add("hidden");
    previewImage.src = "";
    if (previewImageUrl) {
        URL.revokeObjectURL(previewImageUrl);
        previewImageUrl = null;
    }
    renderObjects();
    setPage("mine");
});

async function deleteObject(id) {
    const confirmDelete = confirm("¿Deseas eliminar este registro?");

    if (!confirmDelete) {
        return;
    }

    const record = (await getStoredObjects()).find(object => object.id === id);
    if (record) {
        record.deleted = true;
        record.syncStatus = "pending";
        record.updatedAt = new Date().toISOString();
        await saveStoredObject(record);
    }
    objects = objects.filter(object => object.id !== id);
    renderObjects();
    await requestBackgroundSync();
    await syncPendingObjects();
}

searchInput.addEventListener("input", renderObjects);

navButtons.forEach(button => {
    button.addEventListener("click", () => setPage(button.dataset.page));
});

document.querySelectorAll("[data-go-page]").forEach(button => {
    button.addEventListener("click", () => setPage(button.dataset.goPage));
});

closeDetail.addEventListener("click", () => detailDialog.close());
detailDialog.addEventListener("click", event => {
    if (event.target === detailDialog) {
        detailDialog.close();
    }
});

filterButtons.forEach(button => {
    button.addEventListener("click", () => {
        filterButtons.forEach(btn => btn.classList.remove("active"));
        button.classList.add("active");

        currentFilter = button.dataset.filter;
        renderObjects();
    });
});

function escapeHTML(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("service-worker.js")
            .then(() => {
                console.log("Service Worker registrado correctamente.");
            })
            .catch(error => {
                console.error("Error al registrar Service Worker:", error);
            });
    });
}

let deferredPrompt = null;

window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    deferredPrompt = event;
    installButton.classList.remove("hidden");
});

installButton.addEventListener("click", async () => {
    if (!deferredPrompt) {
        return;
    }

    deferredPrompt.prompt();

    const { outcome } = await deferredPrompt.userChoice;
    console.log(`Instalación: ${outcome}`);

    deferredPrompt = null;
    installButton.classList.add("hidden");
});

shareButton.addEventListener("click", async () => {
    const shareData = {
        title: document.title,
        text: "Consulta UniLost: objetos perdidos y encontrados.",
        url: window.location.href
    };

    try {
        if (navigator.share) {
            await navigator.share(shareData);
            return;
        }

        await navigator.clipboard.writeText(shareData.url);
        alert("URL copiada. Ya puedes compartirla.");
    } catch (error) {
        if (error.name !== "AbortError") {
            alert(`Copia este enlace para compartir UniLost: ${shareData.url}`);
        }
    }
});

window.addEventListener("online", () => {
    setSyncStatus("syncing", "Conexión restablecida…");
    syncPendingObjects();
});

document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
        syncPendingObjects();
    }
});

async function initializeApp() {
    const savedSession = localStorage.getItem("unilost_session");
    if (!savedSession) {
        showLogin();
        setSyncStatus(navigator.onLine ? "device" : "offline", navigator.onLine ? "Solo en este dispositivo" : "Sin conexión");
        return;
    }

    showApp(savedSession);
    try {
        await loadObjects();
        renderObjects();
        await syncPendingObjects();
    } catch (error) {
        setSyncStatus("pending", "Datos locales disponibles");
        console.error("No se pudieron abrir los datos locales:", error);
    }
}

initializeApp();

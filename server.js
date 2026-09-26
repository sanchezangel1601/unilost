const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { promisify } = require("node:util");

const scrypt = promisify(crypto.scrypt);
const root = __dirname;
const storeDirectory = process.env.UNILOST_DATA_DIR
    ? path.resolve(process.env.UNILOST_DATA_DIR)
    : path.join(root, ".unilost-data");
const storePath = path.join(storeDirectory, "store.json");
const maximumRequestBytes = 24 * 1024 * 1024;
const contentTypes = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml"
};

async function readStore() {
    try {
        const store = JSON.parse(await fs.readFile(storePath, "utf8"));
        store.users ||= [];
        store.objects ||= [];
        store.sessions ||= [];
        return store;
    } catch (error) {
        if (error.code !== "ENOENT") {
            throw error;
        }
        return { users: [], objects: [], sessions: [] };
    }
}

async function writeStore(store) {
    await fs.mkdir(storeDirectory, { recursive: true });
    const temporaryPath = `${storePath}.tmp`;
    await fs.writeFile(temporaryPath, JSON.stringify(store), "utf8");
    await fs.rename(temporaryPath, storePath);
}

function sendJson(response, statusCode, body) {
    response.writeHead(statusCode, {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        "X-Content-Type-Options": "nosniff"
    });
    response.end(JSON.stringify(body));
}

async function readJson(request) {
    const chunks = [];
    let totalBytes = 0;
    for await (const chunk of request) {
        totalBytes += chunk.length;
        if (totalBytes > maximumRequestBytes) {
            const error = new Error("La solicitud excede el límite de tamaño.");
            error.statusCode = 413;
            throw error;
        }
        chunks.push(chunk);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        const error = new Error("El cuerpo de la solicitud no es JSON válido.");
        error.statusCode = 400;
        throw error;
    }
}

function getAuthenticatedUser(request, store) {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (!token) {
        return null;
    }
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const session = store.sessions.find(candidate => candidate.tokenHash === tokenHash);
    if (!session || Date.parse(session.expiresAt) <= Date.now()) {
        return null;
    }
    return store.users.find(user => user.username === session.username) || null;
}

async function newSession(store, username) {
    const token = crypto.randomBytes(32).toString("base64url");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    store.sessions = store.sessions.filter(session => Date.parse(session.expiresAt) > Date.now());
    store.sessions.push({
        tokenHash,
        username,
        expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString()
    });
    await writeStore(store);
    return { token, username };
}

async function handleApi(request, response, pathname) {
    const store = await readStore();

    if (request.method === "POST" && pathname === "/api/logout") {
        const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
        if (token) {
            const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
            store.sessions = store.sessions.filter(session => session.tokenHash !== tokenHash);
            await writeStore(store);
        }
        return sendJson(response, 200, { ok: true });
    }

    if (request.method === "POST" && pathname === "/api/register") {
        const body = await readJson(request);
        const username = String(body.username || "").trim();
        const email = String(body.email || "").trim().toLowerCase();
        const password = String(body.password || "");
        const normalizedUsername = username.toLowerCase();

        if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
            return sendJson(response, 400, { error: "El usuario debe tener entre 3 y 32 caracteres: letras, números, punto, guion o guion bajo." });
        }
        if (!/^\S+@\S+\.\S+$/.test(email)) {
            return sendJson(response, 400, { error: "Escribe un correo electrónico válido." });
        }
        if (password.length < 8) {
            return sendJson(response, 400, { error: "La contraseña debe tener al menos 8 caracteres." });
        }
        if (store.users.some(user => user.username.toLowerCase() === normalizedUsername || user.email === email)) {
            return sendJson(response, 409, { error: "Ese usuario o correo ya está registrado." });
        }

        const salt = crypto.randomBytes(16).toString("hex");
        const passwordHash = (await scrypt(password, salt, 64)).toString("hex");
        store.users.push({ username, email, salt, passwordHash, createdAt: new Date().toISOString() });
        await writeStore(store);
        return sendJson(response, 201, await newSession(store, username));
    }

    if (request.method === "POST" && pathname === "/api/login") {
        const body = await readJson(request);
        const identity = String(body.identity || "").trim().toLowerCase();
        const password = String(body.password || "");
        const user = store.users.find(candidate =>
            candidate.username.toLowerCase() === identity || candidate.email === identity
        );
        if (!user || !user.salt || !user.passwordHash) {
            return sendJson(response, 401, { error: "Usuario/correo o contraseña incorrectos." });
        }
        const passwordHash = (await scrypt(password, user.salt, 64)).toString("hex");
        const expected = Buffer.from(user.passwordHash, "hex");
        const actual = Buffer.from(passwordHash, "hex");
        if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
            return sendJson(response, 401, { error: "Usuario/correo o contraseña incorrectos." });
        }
        return sendJson(response, 200, await newSession(store, user.username));
    }

    if (request.method === "POST" && pathname === "/api/microsoft/login") {
        const body = await readJson(request);
        const graphToken = String(body.accessToken || "");
        if (graphToken.length < 100 || graphToken.length > 12000) {
            return sendJson(response, 400, { error: "No se recibió un token Microsoft válido." });
        }

        let graphResponse;
        try {
            graphResponse = await fetch("https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName", {
                headers: { Authorization: `Bearer ${graphToken}` }
            });
        } catch {
            return sendJson(response, 503, { error: "Microsoft Graph no está disponible. Inténtalo de nuevo." });
        }
        if (!graphResponse.ok) {
            return sendJson(response, 401, { error: "Microsoft no pudo validar la cuenta. Vuelve a iniciar sesión." });
        }

        const microsoftUser = await graphResponse.json();
        const email = String(microsoftUser.mail || microsoftUser.userPrincipalName || "").trim().toLowerCase();
        if (!email.endsWith("@alumno.utmetropolitana.edu.mx")) {
            return sendJson(response, 403, { error: "Usa una cuenta institucional @alumno.utmetropolitana.edu.mx." });
        }

        let user = store.users.find(candidate => candidate.email === email);
        if (!user) {
            user = {
                username: email,
                email,
                provider: "microsoft",
                microsoftId: microsoftUser.id,
                displayName: String(microsoftUser.displayName || email).slice(0, 120),
                createdAt: new Date().toISOString()
            };
            store.users.push(user);
            await writeStore(store);
        }
        return sendJson(response, 200, await newSession(store, user.username));
    }

    const user = getAuthenticatedUser(request, store);
    if (!user) {
        return sendJson(response, 401, { error: "Inicia sesión para sincronizar tus datos." });
    }

    if (request.method === "GET" && pathname === "/api/objects") {
        return sendJson(response, 200, {
            objects: store.objects,
            username: user.username
        });
    }

    if (request.method === "POST" && pathname === "/api/objects/sync") {
        const body = await readJson(request);
        const incomingObjects = Array.isArray(body.objects) ? body.objects : [];
        const deletedIds = Array.isArray(body.deletedIds) ? body.deletedIds : [];
        const now = new Date().toISOString();
        const acceptedIds = [];

        for (const incoming of incomingObjects) {
            if (!incoming || typeof incoming.id !== "string" || incoming.id.length > 100) {
                continue;
            }
            if (incoming.image && (!incoming.image.startsWith("data:image/") || incoming.image.length > 18_000_000)) {
                continue;
            }
            const existing = store.objects.findIndex(object => object.id === incoming.id);
            const record = {
                id: incoming.id,
                type: incoming.type === "Encontrado" ? "Encontrado" : "Perdido",
                name: String(incoming.name || "").slice(0, 140),
                description: String(incoming.description || "").slice(0, 3000),
                location: String(incoming.location || "").slice(0, 240),
                date: String(incoming.date || "").slice(0, 40),
                owner: user.username,
                image: incoming.image || "",
                updatedAt: now
            };
            if (existing >= 0) {
                if (store.objects[existing].owner !== user.username) {
                    continue;
                }
                store.objects[existing] = record;
            } else {
                store.objects.unshift(record);
            }
            acceptedIds.push(record.id);
        }

        const deleted = new Set(deletedIds.map(String));
        store.objects = store.objects.filter(object => !(object.owner === user.username && deleted.has(object.id)));
        await writeStore(store);
        return sendJson(response, 200, { acceptedIds, deletedIds: [...deleted], objects: store.objects });
    }

    return sendJson(response, 404, { error: "Ruta de API no encontrada." });
}

async function serveStatic(response, pathname) {
    let relativePath;
    try {
        relativePath = decodeURIComponent(pathname === "/" ? "/index.html" : pathname).slice(1);
    } catch {
        response.writeHead(400);
        return response.end("Solicitud inválida.");
    }

    if (relativePath === "auth-config.js") {
        const config = {
            clientId: process.env.MICROSOFT_CLIENT_ID || "",
            authority: process.env.MICROSOFT_AUTHORITY || "https://login.microsoftonline.com/organizations",
            redirectUri: process.env.MICROSOFT_REDIRECT_URI || "",
            institutionalEmail: "22090889@alumno.utmetropolitana.edu.mx"
        };
        response.writeHead(200, {
            "Cache-Control": "no-store",
            "Content-Type": "text/javascript; charset=utf-8",
            "X-Content-Type-Options": "nosniff"
        });
        response.end(`window.UNILOST_AUTH_CONFIG = ${JSON.stringify(config)};`);
        return;
    }

    const allowedFiles = new Set([
        "index.html", "style.css", "app.js", "manifest.json", "service-worker.js", "README.md",
        "node_modules/@azure/msal-browser/lib/msal-browser.min.js",
        "icons/icon-192.png", "icons/icon-512.png"
    ]);
    if (!allowedFiles.has(relativePath)) {
        response.writeHead(404);
        return response.end("No encontrado.");
    }

    try {
        const filePath = path.join(root, relativePath);
        const content = await fs.readFile(filePath);
        response.writeHead(200, {
            "Cache-Control": relativePath === "service-worker.js" ? "no-cache" : "public, max-age=0, must-revalidate",
            "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
            "X-Content-Type-Options": "nosniff"
        });
        response.end(content);
    } catch {
        response.writeHead(404);
        response.end("No encontrado.");
    }
}

const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, "http://localhost");
    try {
        if (requestUrl.pathname === "/health" && request.method === "GET") {
            sendJson(response, 200, { status: "ok" });
        } else if (requestUrl.pathname.startsWith("/api/")) {
            await handleApi(request, response, requestUrl.pathname);
        } else if (request.method === "GET" || request.method === "HEAD") {
            await serveStatic(response, requestUrl.pathname);
        } else {
            sendJson(response, 405, { error: "Método no permitido." });
        }
    } catch (error) {
        sendJson(response, error.statusCode || 500, {
            error: error.statusCode ? error.message : "Error interno del servidor."
        });
        if (!error.statusCode) {
            console.error(error);
        }
    }
});

const port = Number(process.env.PORT || 3000);
server.listen(port, "0.0.0.0", () => {
    console.log(`UniLost disponible en http://localhost:${port}`);
    console.log(`Las cuentas y publicaciones se guardan en ${storePath}`);
});
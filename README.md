# UniLost

PWA para reportar, explorar y sincronizar objetos perdidos y encontrados.

## Iniciar la aplicación

Requiere Node.js 20 o posterior y las dependencias instaladas. En la carpeta del proyecto ejecuta:

```text
npm.cmd install
npm.cmd start
```

Si npm está instalado pero no está en el PATH en Windows, usa `npm.cmd`. Abre `http://localhost:3000`. También puedes ejecutar `node server.js` después de instalar dependencias. No uses Live Server para el flujo completo: Live Server solo entrega archivos estáticos y no incluye la API que crea cuentas y sincroniza publicaciones.

## Accesos

El acceso institucional usa Microsoft SSO y valida la identidad con Microsoft Graph. También se conserva una cuenta UniLost local para desarrollo. No hay contraseña Microsoft guardada en el proyecto.

Para activar Microsoft SSO:

1. En Microsoft Entra, registra una aplicación como **Single-page application (SPA)**.
2. Agrega como redirect URI la URL exacta de la app, por ejemplo `http://localhost:3000` para desarrollo. Al publicar, agrega también la URL HTTPS pública.
3. En **API permissions**, agrega el permiso delegado Microsoft Graph `User.Read` y solicita el consentimiento institucional si el tenant lo requiere.
4. Configura el **Application (client) ID** como variable de entorno `MICROSOFT_CLIENT_ID` en el servidor. Para probar localmente en PowerShell: `$env:MICROSOFT_CLIENT_ID = "tu-client-id"` antes de ejecutar `node server.js`.
5. Sirve la aplicación y API bajo el mismo origen y usa HTTPS en producción.

La integración usa MSAL Browser con flujo de autorización PKCE. El servidor consulta `/me` en Microsoft Graph y acepta únicamente cuentas `@alumno.utmetropolitana.edu.mx`. Microsoft puede requerir que el administrador de la universidad autorice la app.

Para crear una cuenta UniLost local, selecciona **Crear una cuenta** y registra usuario, correo y contraseña de al menos 8 caracteres.

Las contraseñas se guardan como hashes `scrypt` en el servidor. Los datos persistentes se escriben en `.unilost-data/store.json`; esa carpeta no se publica como contenido web. Para cambiarla, establece `UNILOST_DATA_DIR` antes de iniciar el servidor.

## Uso sin conexión

- La app y sus recursos se guardan en la caché del Service Worker después de abrirla una vez con conexión.
- Los reportes, eliminaciones e imágenes se guardan localmente en IndexedDB.
- Las fotos se reducen antes de guardarse para limitar el espacio utilizado.
- Los cambios hechos sin conexión quedan marcados como pendientes. La app los envía cuando vuelve la conexión; también usa Background Sync cuando el navegador lo soporta.
- Los cambios enviados desde otros dispositivos aparecen al iniciar sesión y sincronizar.

El inicio de sesión/registro y la primera carga requieren conexión con el servidor. Para trabajar offline, inicia sesión y abre la app al menos una vez antes de perder Internet. Los datos locales antiguos de `localStorage` se importan a IndexedDB al iniciar.

## Publicar en Internet

`localhost` solo es accesible desde tu equipo. El archivo `render.yaml` configura el despliegue en Render: Node, chequeo de salud, HTTPS administrado y un disco persistente para cuentas, sesiones y publicaciones.

1. El proyecto está publicado en `https://github.com/sanchezangel1601/unilost`. No subas `node_modules`, `.unilost-data` ni archivos `.env`; están excluidos en `.gitignore`.
2. En Render elige **New > Blueprint**, conecta ese repositorio y confirma los valores de `render.yaml`.
3. En las variables de entorno del servicio, introduce el **Application (client) ID** de Microsoft Entra como `MICROSOFT_CLIENT_ID`.
4. Cuando Render dé la URL `https://...onrender.com`, agrega esa URL sin barra final como redirect URI tipo **Single-page application (SPA)** en Entra. Configura el permiso delegado Microsoft Graph `User.Read` y el consentimiento que exija la universidad.
5. Vuelve al servicio Render y confirma el despliegue. La app y la API comparten origen y la base de datos vive en `/var/data`.

Render requiere un plan de pago que admita disco persistente (el Blueprint usa `0.5c-512mb`) y cobra también el almacenamiento. Revisa los precios actuales antes de confirmar el Blueprint. No elimines el disco `unilost-data` sin una copia de seguridad. Para otro hosting, configura `PORT`, `UNILOST_DATA_DIR` y `MICROSOFT_CLIENT_ID`, y monta almacenamiento persistente en `UNILOST_DATA_DIR`.

Después del despliegue, comparte la URL HTTPS de Render. La autenticación Microsoft no funcionará hasta que la universidad autorice el registro de la aplicación y esté configurado `MICROSOFT_CLIENT_ID`.

## Prueba de la PWA

En Chrome o Edge, abre DevTools (`F12`) y revisa **Application > Manifest** y **Service Workers**. Para probar offline, inicia sesión primero, carga la app, activa el modo Offline y crea un reporte con foto. Al volver a Online, la cola se sincroniza mientras la app esté abierta; con Background Sync compatible también puede completarse en segundo plano.

# Purifica Tu Ambiente CRM — v5.3.31 (base crm6, limpieza + facturación + roles corregidos + Google Calendar + despliegue Railway/VPS + WhatsApp QR corregido + volumen compartido + reintento de arranque + multimedia por LID + id de mensaje normalizado + envío y descarga por escaneo + envío sin falsa alarma + envío una sola vez + mimetype de media + segundo servicio sin sobrescribir + verificación por remitente + 5 reintentos de arranque + configuración de Google Calendar y Telegram en el CRM + limpieza de caché de WhatsApp + seguimiento automático de clientes + imagen o video en el seguimiento + pago manual de factura corregido + campañas personalizadas en Seguimiento + diagnóstico y reintento de envío de multimedia + separación preparación/envío de multimedia + envío manual de multimedia + seguridad endurecida FASE 1: críticos y altos de la auditoría + seguridad FASE 2: medios de la auditoría + presencia real + seguridad FASE 3: bajos de la auditoría + revocación de tokens + corrección urgente: Chrome para el usuario node + corrección urgente: permiso denegado en el volumen + corrección de los 5 hallazgos altos de la auditoría 2026-11-09 + rendimiento para 30 usuarios + refresco en tiempo real del chat)

## v5.3.31 — Corrección: las imágenes (y cualquier mensaje) no aparecían hasta refrescar (2026-11-09)

**Qué pasaba:** en producción, al enviar o recibir una imagen (o cualquier mensaje) en un chat con muchos mensajes, no aparecía hasta refrescar la página a mano. El mensaje sí se enviaba y se guardaba.

**Causa:** el refresco del historial del chat abierto dependía del CONTEO de mensajes de la lista. La v5.3.30 puso un tope de 50 mensajes por conversación en la lista, así que en chats con 50+ mensajes el conteo deja de cambiar al llegar uno nuevo (entra uno, sale el más viejo) y el refresco no se disparaba nunca. No era un problema de la imagen en sí: era el tope de 50 combinado con el disparador por conteo.

**Corrección (solo `components/ChatInbox.tsx`):** el refresco ahora depende del id del último mensaje de la lista, que cambia con cada mensaje nuevo esté o no el chat en el tope. La guarda que evita refetcheos de más (si el último mensaje ya es el mismo, no se refetchea) sigue igual.

**Plan de pruebas tras desplegar v5.3.31:**
1. Abrir el chat con Virtual Zone (que tiene más de 50 mensajes) y enviar una imagen: debe aparecer sola en unos segundos, sin refrescar.
2. Recibir una imagen en ese mismo chat: debe aparecer sola (la descarga tarda unos segundos según el tamaño, eso es normal).
3. Enviar un texto en ese chat: también debe aparecer solo.
4. El botón "Cargar mensajes anteriores" sigue funcionando igual.

**Pendiente honesto:** el refresco en tiempo real no se puede probar en este entorno (sin WhatsApp real); la corrección está verificada por lectura del código + compilación + arranque, y la prueba real es en producción con el chat de Virtual Zone.

## v5.3.30 — Rendimiento para 30 usuarios (prueba de estrés 2026-11-09)

**Qué se midió:** con 30 usuarios a la vez y 1000 mensajes, el sistema aguantaba, pero los limitadores por IP bloqueaban a toda una oficina con 429 tras ~570 peticiones en 15 min, el pool de 10 conexiones llevaba el p95 de Mensajes a 3,3 s, y la lista de chats traía TODOS los mensajes de cada conversación (216 KB y creciendo).

**Mejoras:**
- **Limitadores por usuario, no por IP:** `apiLimiter` (600/15 min) y `waSendLimiter` (30/15 min) usan ahora `keyGenerator` con `user:<id>` para las peticiones autenticadas; las rutas públicas (login, branding, health, webhooks) siguen por IP. OJO: `app.use('/api', apiLimiter)` se movió para DESPUÉS de `authMiddleware` — antes estaba antes de la autenticación y `req.user` siempre era undefined, así que el key por usuario no se habría aplicado. El bloqueo de login por fuerza bruta no cambia (sigue por correo+IP).
- **Pool de Postgres a 25 conexiones** (antes el valor por defecto de `pg`, 10).
- **Tope de 50 mensajes por conversación en GET /api/chats** (los más recientes, con función ventana, sin N+1: siguen siendo 3 consultas) + **nuevo GET /api/chats/:id/messages** (paginado: `?limit=200`, máx 500, `?before=<id>` para cargar hacia atrás, mismo alcance por rol que el envío). El chat abierto carga el historial completo al abrirse y tiene botón "Cargar mensajes anteriores". Sin este endpoint nuevo, los mensajes viejos habrían quedado inalcanzables en la vista (no existía endpoint de detalle: el historial venía entero de la lista).

**Plan de pruebas tras desplegar v5.3.30:**
1. Entrar como asesor y como operador: la navegación no debe dar 429 (antes, con varios usuarios en la misma red, sí).
2. Abrir un chat con muchos mensajes: se ven los últimos, y el botón "Cargar mensajes anteriores" trae los viejos.
3. Enviar 31 mensajes seguidos desde el inbox: el 31 debe dar 429 (el límite de envíos sigue siendo 30/15 min por usuario).
4. Intentar 6 logins fallidos seguidos: el bloqueo por fuerza bruta debe seguir funcionando.

**Pendiente honesto:** el tope por conversación y el endpoint nuevo no se probaron contra una base de datos real con miles de mensajes (sin DB real aquí); la consulta de ventana es SQL estándar de Postgres, pero conviene abrir un chat largo en producción y comprobar que el historial carga y el botón trae los anteriores.

## v5.3.29 — Corrección de los 5 hallazgos ALTOS (auditoría de seguridad 2026-11-09)

La auditoría de la v5.3.28 encontró 43 hallazgos (0 críticos, 5 altos, 18 medios, 20 bajos). Esta versión corrige solo los 5 altos; los medios y bajos quedan para la siguiente ronda.

- **H-A1 — Facturas sin alcance:** `POST /api/invoices` ya no crea facturas de servicios ajenos. Ahora carga `advisor, operators` del servicio y aplica `getRoleScope` + `invoiceInScope` (404 si es de otro), igual que ya hacían los pagos y los links de pago, y antes de responder `already_exists` o de reservar el número FAC-XXXX.
- **H-A2 — Alcance por nombre, no por id:** al arrancar, la base deduplica nombres de empleados repetidos (al 2º y siguientes se les añade ` (2)`, ` (3)`…) y crea un índice único `employees_name_unique` sobre `lower(trim(name))` (idempotente, `IF NOT EXISTS`). `POST /api/staff` y `PUT /api/staff/:id` rechazan con 400 un nombre que ya use otro empleado. La refactorización grande a `advisor_id` queda para medio plazo.
- **H-A3 — Mensajes en los logs:** el log de mensaje entrante ya no lleva el contenido (solo teléfono y tipo). Los eventos de seguimiento fallido ya no guardan nombre ni teléfono del cliente (solo el id del seguimiento). Los logs nunca llevan el texto de los mensajes.
- **H-A4 — `trust proxy` configurable:** `server.js` usa `TRUST_PROXY=1` solo si la variable vale `1`; por defecto 0 (seguro para VPS con el puerto expuesto directo). El Dockerfile fija `TRUST_PROXY=1` (el edge de Railway ES un proxy real) y `docker-compose.yml` lo sobreescribe a `TRUST_PROXY: ${TRUST_PROXY:-0}` (las variables de `environment:` en compose ganan al ENV de la imagen). Si el VPS tiene un reverse proxy real delante, se pone `TRUST_PROXY=1` en el `.env`. Documentado también en `.env.example`.
- **H-A5 — Clave débil por defecto:** `.env.example` deja `POSTGRES_PASSWORD` y `ADMIN_PASSWORD` vacíos (con comentario); `docker-compose.yml` exige `POSTGRES_PASSWORD` con `${POSTGRES_PASSWORD:?Falta POSTGRES_PASSWORD en .env}` (falla rápido con mensaje claro) en el servicio db y en PGPASSWORD del respaldo; `install.sh` e `install.bat` generan una contraseña aleatoria larga si se deja vacío, exigen mínimo 12 caracteres si se escribe una, y la imprimen al final para guardarla; y el servidor NO arranca si se intenta crear el admin inicial con `cambia-esta-clave` o con menos de 12 caracteres (error fatal + `process.exit(1)`; si el admin ya existe, la variable no se usa).

**Plan de pruebas tras desplegar v5.3.29:**
1. Login normal como admin (la cookie y la revocación no cambiaron).
2. Como asesor, intentar crear una factura del servicio de otro asesor → 404 y el consecutivo FAC-XXXX no se consume.
3. Crear dos empleados con el mismo nombre (con distinta mayúscula) → el segundo da 400.
4. Recibir un mensaje de WhatsApp y revisar el log: no debe aparecer el texto del mensaje.
5. En VPS con compose, mandar un login con `X-Forwarded-For` falso → el bloqueo por fuerza bruta debe seguir contando la IP real (no una nueva por cada cabecera).
6. Instalación nueva con Enter en las claves → el instalador genera claves largas y las imprime al final; `docker compose up` sin `POSTGRES_PASSWORD` en `.env` falla con el mensaje claro.
7. WhatsApp: enviar un texto y una foto a Virtual Zone (el envío manual de multimedia no se tocó).

**Pendiente honesto:** la imagen Docker no se pudo construir en este entorno (sin Docker aquí), así que el `ENV TRUST_PROXY=1` del Dockerfile y el override de compose solo se probarán en el despliegue. El arranque sin DB y el build se verificaron igual que en las versiones anteriores.

## v5.3.28 — Corrección urgente: permiso denegado en el volumen (2026-11-08)

**Qué pasó:** la v5.3.27 sí arregló lo de Chrome (el error "Could not find Chrome" desapareció del log), pero WhatsApp siguió caído con dos errores nuevos: el arranque de "alejo ochoa" fallaba con Code: 21 (Chrome no podía bloquear su perfil) y la instancia nueva "sdfgh" fallaba con `EACCES: permission denied, mkdir '/app/data/session-wa-session-sdfghj'`.

**Causa:** el volumen de Railway (`/app/data`) fue creado cuando la app corría como root, así que pertenece a root. Al pasar la app a correr como usuario `node` (B8, v5.3.26), `node` no puede escribir en el volumen: ni crear la carpeta de sesión de una instancia nueva (EACCES directo) ni escribir el bloqueo del perfil de Chrome de la sesión existente (Code: 21). El `chown` del Dockerfile solo arregla los directorios de la imagen, no el volumen montado en ejecución.

**Corrección (solo Dockerfile + `entrypoint.sh` nuevo):**
- El contenedor arranca como root SOLO para arreglar el dueño de los directorios que la app escribe (`/app/data`, `/app/uploads`, `/app/backups`, `/app/.wwebjs_auth`, `/app/.cache/puppeteer`) y luego baja privilegios: la app sigue corriendo como `node` (B8 se mantiene, el proceso de la app nunca corre como root).
- El `chown` solo se hace si el dueño no es `node`, para no re-recorrer el volumen en cada arranque.
- Se quitó el `USER node` del Dockerfile (el entrypoint es quien baja los privilegios); el `ENTRYPOINT` es `/app/entrypoint.sh` y el `CMD` sigue siendo `npm start`.

**La instancia "alejo ochoa":** la sesión sigue guardada en el volumen (36.1 MB, carpeta `session-wa-session-alejo`). Para recuperarla sin escanear QR de nuevo: borra la instancia de prueba "sdfgh" y vuelve a agregar una instancia con el ID `alejo` (el mismo de antes). Si al agregarla pide QR, escanea una sola vez; si restaura la sesión, entra directo.

**Plan de pruebas tras desplegar v5.3.28:**
1. En Estado del Sistema, WhatsApp debe pasar de "Roto" a conectado (1 de 1 instancias) sin escanear QR, si se recupera la sesión de "alejo".
2. Enviar un texto de prueba a Virtual Zone y confirmar que llega.
3. Si vuelve a salir EACCES o Code: 21 en el log, mandar el log: el entrypoint deja constancia en el arranque.

**Pendiente honesto:** la imagen Docker no se pudo construir en este entorno (sin Docker aquí); el entrypoint se probó en sintaxis y en simulación (chown + bajar a usuario node), pero la prueba real es el despliegue en Railway.

## v5.3.27 — Corrección urgente: WhatsApp caído por Chrome no encontrado (2026-11-08)

**Qué pasó:** al desplegar la v5.3.26 en Railway, WhatsApp quedó en ERROR ("Could not find Chrome (ver. 145.0.7632.77)"). La sesión estaba intacta en el volumen (36.1 MB), pero el navegador no arrancaba, así que ni enviaba ni recibía nada.

**Causa:** el cambio B8 de la v5.3.26 (Docker multi-etapa + app como usuario `node`). Puppeteer descarga Chrome al instalarse en `$PUPPETEER_CACHE_DIR`, o en `~/.cache/puppeteer` si no está definido. El `npm ci` de ejecución corría como root y Chrome quedaba en `/root/.cache/puppeteer`, pero la app corre como `node` y lo buscaba en `/home/node/.cache/puppeteer`. El servidor no tiene `executablePath` fijo: depende de esa resolución.

**Corrección (solo Dockerfile):**
- Etapa de ejecución: `ENV PUPPETEER_CACHE_DIR=/app/.cache/puppeteer` antes del `npm ci --omit=dev`, así Chrome se descarga dentro de `/app`, que ya es de `node` por el `chown -R node:node /app`. La variable queda en la imagen, así que en ejecución Puppeteer lo encuentra ahí.
- Etapa de build: `ENV PUPPETEER_SKIP_DOWNLOAD=true` (el build de Vite no necesita Chrome).

**Plan de pruebas tras desplegar v5.3.27:**
1. En Estado del Sistema, WhatsApp debe pasar de "Roto" a conectado (1 de 1 instancias) sin escanear QR (la sesión está guardada en el volumen).
2. En Canales WhatsApp, la instancia "alejo ochoa" debe salir sin ERROR.
3. Enviar un texto de prueba a Virtual Zone y confirmar que llega.
4. Si vuelve a salir "Could not find Chrome" en el log, el problema no es este: revisar que la imagen se reconstruyó (el cambio de `package.json` a 5.3.27 invalida la caché de Docker desde el `COPY package*.json`).

**Pendiente honesto:** la imagen Docker no se pudo construir en este entorno (sin Docker aquí), así que el `npm ci` de ejecución con el caché nuevo solo se probará en el despliegue de Railway. El arranque sin DB y el build se verificaron igual que en las versiones anteriores.

## Seguridad endurecida — FASE 1 (v5.3.24, 2026-11-08)

Auditoría de seguridad fuerte de la v5.3.23: 35 hallazgos (2 críticos, 7 altos, 15 medios, 11 bajos; informe en `SECURITY-AUDIT-5.3.23.md`). Esta versión corrige los **2 críticos y los 7 altos, más M8 (marca blanca visible)**. No cambia funcionalidad ni textos (salvo los de marca, ver M8) ni el envío manual de multimedia de la v5.3.23.

- **C1 (crítico) — un líder de ventas podía escalar privilegios.** `requireAdminOrLeader` (server.js) solo bloqueaba crear con rol `admin` y miraba el `parent_id` del objetivo, pero dejaba: crear cuentas `sales_agent` u `operator` con `parent_id` propio, ascender a sus asesores a `sales_agent`, y editar/cambiar la contraseña de un `operator` o `sales_agent` que colgara de él. Regla ahora cerrada: el líder SOLO crea/edita/desactiva **asesores (`advisor`) de su red directa** (su `parent_id` debe ser su propio id); nunca puede tocar al admin, a otro líder ni a un operador, ni como objetivo ni como rol nuevo, ni cambiar el director de nadie. El admin no tiene estas restricciones.
- **C2 (crítico) — JWT_SECRET débil en producción.** El código ya generaba un secreto efímero si faltaba y los instaladores (`install.sh` / `install.bat`) ya generan uno aleatorio de 32 bytes hex cuando `JWT_SECRET=` está vacío en `.env` (verificado: `.env.example` lo trae vacío). **Lo que falta es acción del usuario en Railway (ver abajo): rotar el secreto y cambiar la contraseña de admin.** Sin eso, la corrección de código no basta.
- **A1 (alto) — XSS almacenado por subida de archivos.** `waMediaUpload` no tenía `fileFilter` y la extensión salía del nombre original si el mimetype no estaba en el mapa: un `.html` con `Content-Type: audio/x-aac` quedaba guardado como `.html` y servido en el origen del CRM. Ahora: (1) `fileFilter` con lista blanca (`WA_ALLOWED_UPLOAD_MIMES` = claves de `WA_MIME_EXT`: imagen, audio, video, pdf, doc/docx, xls/xlsx, txt) rechaza lo demás con 400 **antes** de escribir a disco; (2) `waMediaExtFromMime` devuelve `null` si el mimetype no está en la lista (nunca usa el nombre original); (3) `/uploads` se sirve con `X-Content-Type-Options: nosniff`, `Content-Type` forzado desde la lista blanca de extensiones y `Content-Security-Policy: sandbox` (un `.html` o `.svg` que llegara a disco no ejecuta scripts en el origen). Las revisiones de mimetype que ya existían en los 3 endpoints (chat, campañas, seguimiento) quedan como segunda capa. La descarga entrante de WhatsApp sigue guardando con `.bin` si el mimetype es desconocido (no se pierde el archivo).
- **A2 (alto) — gestión de WhatsApp sin control de rol.** `POST /api/wa/instances`, `PATCH /api/wa/instances/:id/channel`, `GET /api/wa/qr/:id`, `DELETE /api/wa/instances/:id`, `GET /api/wa/instances` y `GET /api/wa/meta/status` ahora son solo admin. Antes cualquier empleado podía borrar la instancia (con `logout()` en el teléfono), cambiar el canal o leer el QR y escanearlo con su número. Además el QR ya no se emite a todos los sockets: `io.to('global_admin').emit('wa_qr', ...)` (la página Canales WhatsApp ya era solo admin en la interfaz).
- **A3 (alto) — servicios reescribibles por cualquiera.** `POST /api/services` (upsert por id) y `POST /api/services/update-deal` no tenían control de rol ni de alcance. Ahora: el operario no crea, edita ni cambia estados (403); el asesor solo los suyos y con su nombre forzado como asesor; el líder solo los de su red; el admin todo. El `deal_status` debe ser uno de los 6 válidos y todos los montos (`initialValue`, `additionalValue`, `totalValue`, `advances`, `expenses`, `operatorPayment`, `netProfit`) deben ser números no negativos. El recálculo completo de totales en el servidor sigue siendo un pendiente (ya documentado) y NO se toca aquí.
- **A4 (alto) — fuga de datos entre roles.** Verificado en el código: `GET /api/leads`, `GET /api/services`, `GET /api/ranking` y `GET /api/stats/commissions` **ya** aplicaban `getRoleScope` en v5.2 (la auditoría se equivocó en esos cuatro; no se tocan). El único sin alcance era `GET /api/staff`: cualquier empleado veía a todo el personal (correos, roles, comisiones, jefes). Ahora: admin ve todo; el líder, a sí mismo y a su red directa; el asesor y el operario, solo a sí mismos.
- **A5 (alto) — JWT en localStorage + Tailwind CDN + sin CSP.** (1) El token ya no vive en `localStorage`: el login lo emite en cookie `HttpOnly; SameSite=Strict; 24 h` (`crm_token`, `Secure` cuando la petición llega por HTTPS) y el frontend ya no guarda ni manda ningún token (`lib/api.ts` usa `credentials: 'same-origin'`; `getToken`/`setToken` eliminados; la sesión se restaura con `GET /api/auth/me` y se cierra con `POST /api/auth/logout`). `Authorization: Bearer` se sigue aceptando como respaldo para clientes de API externos. Socket.io lee la cookie en el handshake (con `auth.token` como respaldo) y el cliente usa `withCredentials: true`. (2) CSP activa en helmet: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' wss:; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`. `style-src 'unsafe-inline'` es necesario porque React y framer-motion ponen estilos en línea (`style={{...}}`); sin él se rompe la interfaz. (3) Tailwind compilado en local: se eliminó el `<script src="https://cdn.tailwindcss.com">` y su config inline de `index.html`; ahora hay `tailwind.config.js` (colores `brand` como variables CSS `--brand-*`), `postcss.config.js`, `index.css` (`@tailwind` + valores por defecto de las variables + la hoja de impresión de facturas) e `import './index.css'` en `index.tsx`. `lib/branding.ts` ya no inyecta un `<style>` con las clases brand-* (la CSP lo bloquearía): actualiza solo las variables `--brand-*` y Tailwind genera las clases desde ellas. Verificado en el CSS construido: contiene las utilidades usadas (`.bg-slate-50`, `.flex`, `.bg-brand-600` como `rgb(var(--brand-600) / ...)`, `.bg-brand-500/20` como `rgb(var(--brand-500) / .2)`, `:root` con los canales RGB). Detalle: con un `var()` simple Tailwind NO genera las clases con opacidad (`/20`), así que las variables guardan canales RGB separados y el color se declara `rgb(var(--brand-500) / <alpha-value>)` (patrón documentado de Tailwind v3; comprobado en prueba mínima). No se encontró ninguna clase construida dinámicamente en el frontend (los dos `p-${` eran falsos positivos de `skip-${id}`). Subida probada de extremo a extremo con JWT de prueba: el `.html` con mimetype `audio/x-aac` da 400 y la foto real sube con 200 y se sirve con `Content-Security-Policy: sandbox` + `nosniff` + `Content-Type: image/jpeg`.
- **A6 (alto) — prospectos reasignables por otros asesores.** `POST /api/leads/update` bloqueaba al operario pero no comprobaba alcance. Ahora, antes de abrir la transacción: si el prospecto existe debe pertenecer al alcance del llamante (403 si no); si cambia el asesor, solo el admin o el líder de esa red, y el nuevo asesor debe ser de su equipo (un asesor no puede reasignarse prospectos); al crear, el asesor se fuerza desde el JWT. Si el id no existe, 404 (antes devolvía éxito sin tocar nada).
- **A7 (alto) — multer 1.x vulnerable.** Subido a **multer 2.5.0** (`package.json` + `npm install`). API verificada sin cambios para lo que usa la app (`diskStorage`, `memoryStorage`, `fileFilter`, `limits`, `.single`). Las 10 vulnerabilidades altas de 1.x (DoS + bypass del límite de tamaño) quedan cerradas.
- **M8 (medio) — marca blanca visible.** El mensaje por defecto de seguimiento decía "Purifica Tu Ambiente" y llegaba así por WhatsApp a los clientes de un revendido. Ahora el mensaje por defecto usa `{{empresa}}` y `renderFollowupMessage` lo reemplaza con el nombre de la marca configurada (o `'CRM'` si no hay marca). El valor por defecto de marca pasa a ser neutro (`company_name: 'CRM'`) en `BRANDING_DEFAULTS` (servidor) y `DEFAULT_BRANDING` (frontend): la marca real de Purifica vive en la tabla `settings` de su instalación, así que su instalación no cambia; una instalación revendida sin personalizar muestra "CRM". Los otros fallos de marca (`{{empresa}}` de campañas, nombre de empresa en la exportación DIAN y descripción del pago PayU) usan ahora `'CRM'` como neutro. La ayuda de variables del seguimiento incluye `{{empresa}}`.

**Lo que el usuario debe hacer en Railway para C2 (obligatorio antes de alquilar):**

1. Generar un secreto largo aleatorio (mínimo 64 caracteres hex, p. ej. con `openssl rand -hex 32`) y ponerlo en la variable `JWT_SECRET` del servicio `crmpurifica` en Railway (distinto de cualquier contraseña; nunca en capturas ni en el repo).
2. Cambiar la contraseña del administrador en el CRM (Equipo → admin → cambiar contraseña).
3. Volver a iniciar sesión: al rotar el secreto, todos los tokens viejos dejan de valer.

**Plan de pruebas tras desplegar v5.3.24:**

1. Entrar con el admin: debe pedir login (la cookie vieja no existe) y al entrar todo debe verse igual (mismos colores y estilos: Tailwind compilado).
2. Recargar la página: la sesión debe seguir (cookie + `/api/auth/me`), sin parpadeo de login.
3. Salir (cerrar sesión) y volver a entrar.
4. Subir una foto desde Mensajes y un video en una campaña: deben llegar como antes (multer 2.x + fileFilter).
5. Intentar subir un archivo `.html` renombrado o con mimetype raro: debe dar 400 y no guardarse.
6. Con una cuenta de asesor: intentar abrir `/api/staff` desde la consola debe devolver solo su propia fila; intentar crear un usuario admin debe dar 403.
7. Con una cuenta de líder: crear un asesor de su equipo debe funcionar; crear un admin, un líder o un operador debe dar 403.

**Pendiente honesto:** los 15 medios y 11 bajos de la auditoría NO se corrigen en esta versión (FASE 2): rate limiting, `/uploads` con autenticación, política de contraseñas, respaldos cifrados, webhook Meta sin secreto, etc. Tampoco se probó con base de datos real (sin Postgres en este entorno): el login, la cookie, el socket y los alcances por rol están verificados por lectura de código y arranque, no con usuarios reales. La rotación del secreto en Railway es acción del usuario (ver arriba).

## Seguridad endurecida — FASE 2 (v5.3.25, 2026-11-08)

Esta versión corrige los **15 hallazgos MEDIOS** de la auditoría (`SECURITY-AUDIT-5.3.23.md`), más el bug de presencia reportado por el usuario (los asesores aparecían ACTIVOS con la sesión cerrada). No cambia funcionalidad ni textos (salvo los de marca blanca indicados) ni el envío manual de multimedia de la v5.3.23 ni el login por cookie de la v5.3.24.

- **M1 (medio) — notas de clientes sin alcance.** `GET /api/notes/:phone` y `POST /api/notes` no comprobaban nada: cualquiera con el teléfono leía o sobrescribía la nota de cualquier cliente. Ahora ambas usan `phoneInScope(req, phone)`: admin siempre; operador solo clientes de sus servicios asignados; asesor/líder solo si hay un servicio o prospecto con su nombre (o de su red) o una conversación sin asesor asignado (mismo patrón que `GET /api/chats`).
- **M2 (medio) — plantillas sin control de rol.** `POST /api/templates` y `DELETE /api/templates/:id` ahora son solo admin. El `GET` queda para todos (las plantillas se usan al escribir). Nota: se usa `requireAdmin` y no `requireAdminOrLeader` porque ese middleware es específico de personal (lee `req.params.id` como id de empleado y `req.body.role`): con un id de plantilla lo interpretaría mal.
- **M3 (medio) — cualquiera cambiaba el estado en línea de cualquier empleado.** `POST /api/staff/status` ignoraba el rol y usaba el `id` del cuerpo. Ahora cada uno solo cambia SU propio estado (JWT); el admin puede cambiar el de cualquiera y el líder solo el de sus subordinados directos.
- **M4 (medio) — cualquiera marcaba como completos los recordatorios de otro.** `POST /api/reminders/:id/complete` ahora aplica la misma comprobación que el DELETE: solo el creador (`created_by`) o un admin; si no existe, 404.
- **M5 (medio) — webhook Meta sin firma.** Si `META_WA_APP_SECRET` no está configurado, el POST de `/api/webhooks/meta` ahora se **rechaza con 403** (antes aceptaba los eventos sin verificar y cualquiera con la URL inyectaba mensajes falsos). El GET de verificación (hub challenge) no cambia, y el canal QR no se toca. Si usas Meta Cloud API, el secreto es obligatorio (ver `.env.example`).
- **M6 (medio) — sin rate limiting salvo el login.** Nueva dependencia `express-rate-limit` (v8): `app.set('trust proxy', 1)` (solo el primer proxy, el router de Railway; sin esto `req.ip` sería la IP del proxy y todos los usuarios compartirían el límite) y limitadores: global 600 peticiones/15 min por IP en toda `/api`; envíos de WhatsApp 30/15 min (chat, campañas, seguimiento — el envío masivo de una campaña es UNA petición, el bucle es del servidor); subidas 60/15 min; creación de usuarios y cambio de contraseña 20/15 min; cambios de ajustes 60/15 min; webhooks públicos 300/15 min. El login mantiene su bloqueo por correo+IP (5 fallos/10 min → 429 por 15 min).
- **M7 (medio) — ajustes operativos editables por cualquiera.** `reassignment_timeout` y `daily_capacity` pasan a `ADMIN_ONLY_SETTINGS` y se validan (enteros: 1–1440 minutos y 1–500 respectivamente). Antes un operario podía poner `daily_capacity` en 0 y bloquear la agenda. Ojo: un líder que usaba la pestaña Distribución de Equipo para cambiarlos ahora recibe 403; solo el admin los cambia.
- **M8 (medio, resto) — marca blanca.** Lo del mensaje de seguimiento ya se corrigió en Fase 1. Ahora: el subtítulo del Dashboard y el encabezado del Excel contable usan el nombre de la marca configurada (antes "Purifica Tu Ambiente" fijo); el archivo Excel de clientes se llama `DB_Clientes_<marca>_<fecha>.xlsx`; el mensaje de prueba de Telegram y el evento de prueba de Google Calendar usan la marca; el log de arranque dice "CRM Real-Time ON"; los respaldos se llaman `<marca>-<fecha>.sql.gz[.enc]` y el trabajo de respaldo de `docker-compose.yml` usa `crm-backup-<fecha>.sql.gz`. El título estático de `index.html` pasa a neutro (`CRM`; la marca lo reescribe al cargar). Los valores por defecto de marca ya eran neutros (`'CRM'`) desde la Fase 1. Quedan como estaban (no visibles para el usuario): el nombre de la base de datos por defecto, la clave de caché `purifica_branding` y los comentarios del código.
- **M9 (medio) — `/uploads` público sin autenticación.** Las fotos y vídeos de los clientes eran descargables por cualquiera con la URL. Ahora `/uploads/wa-media/*` exige sesión válida (cookie HttpOnly o Bearer, igual que la API) y `/uploads/logo.*` sigue público (la página de login lo muestra sin sesión). El frontend manda la cookie en cada `<img>`/`<video>` (same-origin), así que las vistas previas de Mensajes siguen cargando. Las cabeceras seguras de la Fase 1 (nosniff + Content-Type de lista blanca + CSP sandbox) se mantienen en ambos montajes.
- **M10 (medio) — un asesor enviaba WhatsApp a cualquier cliente.** `POST /api/chats/:id/messages` bloqueaba al operario pero no comprobaba alcance. Ahora usa `conversationInScope` (mismo patrón que `GET /api/chats`): admin todo; operador solo conversaciones de sus servicios; asesor/líder solo las suyas, las de su red o sin asignar; lo demás 403 con `{ success: false, sent: false, error }`.
- **M11 (medio) — sin política de contraseñas ni cambio propio.** Nueva `validatePassword`: mínimo 8 caracteres, al menos una letra y un número, y rechaza las más comunes (`123456`, `password`, `admin123`, `purifica`, etc.). Se aplica al crear (`POST /api/staff`) y al cambiar (`PUT /api/staff/:id`) contraseñas. Nuevo endpoint `POST /api/auth/change-password` (contraseña actual + nueva; verifica la actual con bcrypt; con límite de 20/15 min). La contraseña inicial del admin por variables de entorno sigue siendo decisión del instalador.
- **M12 (medio) — respaldos sin cifrar.** `runBackup` ahora cifra con AES-256-GCM y la clave `BACKUP_ENCRYPTION_KEY` (64 caracteres hex, p. ej. `openssl rand -hex 32`): el archivo queda como `<marca>-<fecha>.sql.gz.enc` con formato `[IV 16B][cifrado][tag 16B]`. Sin clave, el respaldo se guarda SIN cifrar y queda registrado el aviso en los eventos y en el log (nunca falla en silencio). El resultado y `last_backup` incluyen `encrypted: true/false`. Para leerlo: `BACKUP_ENCRYPTION_KEY=<clave> node scripts/decrypt-backup.js <archivo>.enc` (nuevo script) y luego `gunzip -c <archivo>.sql.gz | psql "$DATABASE_URL"`. Guarda la clave FUERA del servidor: sin ella el respaldo no se puede leer. Nota: el trabajo de respaldo de `docker-compose.yml` (pg_dump directo) NO cifra; el cifrado es el del respaldo del servidor.
- **M13 (medio) — enlace de adjuntos sin validar.** Nuevo `lib/safeUrl.ts` (`isSafeUrl`: solo `/uploads/` o `https://`; `isSafeImageSrc`: además `data:image/` para el QR). El enlace de descarga de documentos de `ChatInbox` solo se renderiza si la URL es segura (y lleva `rel="noopener noreferrer"`); la imagen del mensaje igual; las vistas previas de medios de Campañas y Seguimiento y el QR de Canales WhatsApp también se validan; el logo de Personalización igual.
- **M14 (medio) — dependencias Express/Socket.io con DoS.** Subidas en bloque con `overrides` en `package.json` (Express se queda en 4.x; la 5.x es un cambio mayor): `qs` 6.17.1, `body-parser` 1.20.9, `path-to-regexp` 0.1.13, `engine.io` 6.6.11, `socket.io-parser` 4.2.7, `ws` 8.22.2, `lodash` 4.18.1, `glob` 14.0.4. Verificado con `npm install` + arranque + login + chat.
- **M15 (medio) — `/api/settings` completo a no-admines.** El GET ya borraba los 6 secretos; ahora además borra `meta_wa_phone_number_id` y a los no-admines solo les devuelve las claves que su interfaz necesita: `daily_capacity`, `reassignment_timeout`, `company_nit`, `company_regime`, `dian_resolution_number`, `dian_resolution_range`, `dian_resolution_date`, `invoice_default_type`. Los secretos y ajustes de admin (seguimiento, Google, Telegram, Meta) solo los ve el admin.
- **Presencia real (bug reportado por el usuario).** La columna `is_online` nacía en `TRUE` y nada la apagaba: todo el personal se veía "activo" con la sesión cerrada. Ahora: el default es `FALSE` (CREATE TABLE + `ALTER TABLE ... SET DEFAULT FALSE` en `initDB`, que corre sobre bases existentes); al arrancar el servidor se apagan todos (`UPDATE employees SET is_online = false`); el login exitoso enciende el flag; el logout lo apaga (el endpoint ahora es público y verifica el token él mismo para poder apagarlo aunque esté expirado); el socket lo enciende al conectar y lo apaga al desconectar solo si al usuario no le queda ningún otro socket (otra pestaña abierta). `POST /api/staff/status` sigue funcionando (M3) y la llamada del frontend al montar sigue siendo coherente (pone true). La lista de personal ya leía `is_online`, no cambia su significado.

**Plan de pruebas tras desplegar v5.3.25:**

1. Entrar con el admin y con un asesor: todo debe verse igual; las fotos y videos de Mensajes deben seguir cargando (M9).
2. Con un asesor: abrir las notas de un cliente de otro asesor debe dar 403 (M1); enviar un mensaje a su conversación debe dar 403 (M10).
3. Intentar subir un archivo `.html`: debe dar 400 (ya era así en Fase 1; el fileFilter no cambió).
4. Crear un empleado con contraseña `123456`: debe dar 400 (M11); cambiar la propia contraseña con `POST /api/auth/change-password` debe funcionar.
5. Presencia: entrar con un asesor → aparece activo en Equipo; cerrar sesión → aparece inactivo; cerrar la pestaña sin cerrar sesión → aparece inactivo al desconectar el socket; un empleado nuevo (creado por el admin) aparece inactivo hasta que entra (M-presencia).
6. Respaldo: pulsar "Respaldar ahora" en Estado del Sistema sin `BACKUP_ENCRYPTION_KEY` → el archivo queda `.sql.gz` SIN cifrar y hay un aviso en los eventos (M12); con la clave puesta → queda `.sql.gz.enc` y `scripts/decrypt-backup.js` lo lee.
7. Meta: con `META_WA_APP_SECRET` vacío, un POST a `/api/webhooks/meta` debe dar 403 (M5). El QR no se toca.
8. Ajustes: con un operario, intentar poner `daily_capacity` en 0 debe dar 403 (M7); `GET /api/settings` con un asesor no debe traer `followup_*` ni `telegram_*` ni `google_*` (M15).

**Pendiente honesto:** los 11 bajos de la auditoría se corrigen en la FASE 3 (v5.3.26). Tampoco se probó con base de datos real (sin Postgres en este entorno): la presencia, el cifrado de respaldos, los alcances y los limiters están verificados por lectura de código y arranque, no con usuarios reales. `GET /api/reminders/:phone` tiene el mismo patrón sin alcance que M1 (notas) y no se tocó en esta fase: queda anotado para la Fase 3. El respaldo de `docker-compose.yml` (pg_dump directo) no cifra (se cifra en la Fase 3).

## Seguridad endurecida — FASE 3 (v5.3.26, 2026-11-08)

Esta versión corrige los **11 hallazgos BAJOS** de la auditoría (`SECURITY-AUDIT-5.3.23.md`) y los **2 pendientes que la Fase 2 dejó anotados**. Con ella queda cerrada la auditoría completa (35 hallazgos: 2 críticos + 7 altos + 15 medios + 11 bajos). No cambia funcionalidad ni textos (salvo los de marca blanca indicados) ni el envío manual de multimedia de la v5.3.23, ni el login por cookie de la v5.3.24, ni la presencia de la v5.3.25.

- **B1 (bajo) — `/api/health` público revelaba la versión y el estado de WhatsApp.** Ahora sin sesión solo devuelve `{ ok }` (suficiente para el HEALTHCHECK de Docker y de Railway, que solo miran el 200). Un admin autenticado (cookie o Bearer) sí ve el detalle completo (versión, DB, uptime, WhatsApp).
- **B2 (bajo) — el middleware era fail-open si la base de datos fallaba.** Si la consulta de usuario activo/rol falla (DB caída), ahora devuelve **503** en vez de dejar pasar: antes, con la DB caída, el token de un usuario desactivado seguía funcionando en los endpoints que no necesitan DB (`/api/wa/*`, `/api/system/*`). El login y `/api/health` ya manejaban la DB caída por su cuenta y no se tocan.
- **B3 (bajo) — sin revocación de tokens.** Nueva columna `token_version` en `employees` (CREATE TABLE + `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` en `initDB`, corre sobre bases existentes). El login firma el token con `tv` (versión actual); el middleware y el handshake del socket la comparan con la base de datos y rechazan con 401 los tokens con versión vieja. El **logout** sube la versión (además de borrar la cookie y apagar la presencia): un token robado o copiado deja de valer aunque no haya expirado. **Cambiar la contraseña** (propia o por admin/líder en Equipo) también sube la versión; al cambiar la propia se emite un token nuevo para que la sesión continúe sin entrar de nuevo. Los tokens emitidos antes de la v5.3.26 no traen `tv` y se tratan como versión 0: siguen valiendo hasta la primera revocación del usuario. Ojo: quien esté con sesión abierta al desplegar esta versión seguirá dentro; su token muere en el primer logout o cambio de contraseña.
- **B4 (bajo) — restos de marca blanca menores.** La clave de caché de marca pasa de `purifica_branding` a `crm_branding` (la marca se vuelve a cargar del servidor en la próxima visita); cuando no hay logo subido se muestran las **iniciales de la empresa** (`lib/branding.ts: companyInitials`) en el menú y en el login, en vez del icono fijo; la ciudad por defecto de los formularios de servicio y de prospecto pasa de `'Bogotá'` a vacía (con placeholder "Ciudad"); el comentario viejo de `App.tsx` que mencionaba la clave antigua se actualiza. Quedan como estaban (solo internos, no visibles): el nombre de la base de datos por defecto (`purifica` en `server.js` y `docker-compose.yml` — cambiarlo rompería instalaciones existentes) y los comentarios históricos del código.
- **B5/B9 (bajo) — inyección de fórmulas en la exportación a Excel.** Nuevo `lib/excel.ts` (`sanitizeExcelCell` / `sanitizeExcelRow`): los valores de texto que empiecen por `= + - @` (o tabulador/retorno) se prefijan con apóstrofe (`'`) para que Excel los trate como texto y no como fórmula. Se aplica a la exportación de clientes (`ClientsList.tsx`) y al reporte contable (`Dashboard.tsx`); los números pasan tal cual. Sobre B9: `xlsx` 0.18.5 sigue siendo la última versión publicada (CVE-2023-30533 y CVE-2024-22363 sin arreglo del autor); el riesgo real aquí es bajo porque solo se usa para **exportar**, nunca parsea archivos subidos. Si algún día se parsean uploads, hay que reemplazarla por ExcelJS.
- **B6 (bajo) — PayU comparaba la firma con `===`.** Ahora usa `crypto.timingSafeEqual` con comprobación de longitud, igual que Wompi. Sin firma válida sigue sin marcarse pagado (verificado en la auditoría).
- **B7 (bajo) — `GET /api/chats` sin límite y con N+1.** Ahora pagina con `clampPagination` (por defecto 50, máximo 200; la consulta de conversaciones tiene un tope duro de 1000) y carga los mensajes y los conteos de tareas de la página con **2 consultas únicas** (antes 2 por conversación). La respuesta cambia a `{ data, total, page, limit, totalUnread }` como leads/services; el frontend acepta ambas formas (arreglo viejo o el objeto nuevo) y usa `totalUnread` para el contador de no leídos.
- **B8 (bajo) — Docker corría como root y la imagen llevaba las devDependencies.** `Dockerfile` ahora es multi-etapa: la etapa de build instala todo y compila el frontend; la etapa de runtime instala solo producción (`npm ci --omit=dev`) y la app corre como usuario **`node`** (no root). La imagen de runtime lleva `server.js`, `scripts/` y `dist/`; los directorios que la app escribe (`/app/uploads`, `/app/.wwebjs_auth`, `/app/backups`) se crean con dueño `node`, así que los volúmenes nuevos heredan ese dueño. Nota para instalaciones existentes: los volúmenes creados con la imagen vieja pertenecen a root; si la app no puede escribir tras actualizar, ejecutar una vez `docker compose run --rm --user root app chown -R node:node /app/uploads /app/backups /app/.wwebjs_auth`. No se pudo construir la imagen Docker en este entorno (no hay Docker); el Dockerfile se revisó con cuidado.
- **B10 (bajo) — `proxy-addr` 2.0.7 con crítica condicional.** Sube a **2.0.8** por `overrides` en `package.json` (es dependencia transitiva de Express). Hoy no es explotable: `trust proxy` sigue en `1` (solo el primer proxy, puesto en la Fase 2 para el rate limiting) y no se sube.
- **B11 (bajo) — `rel` sin `noopener` y `autocomplete`.** El único enlace con `target="_blank"` (`ChatInbox.tsx`, descarga de adjuntos) ya llevaba `rel="noopener noreferrer"` desde la Fase 2 (M13); no había más. Se añade `autoComplete`: `username` / `current-password` en el login, `new-password` en la contraseña nueva de Equipo. Los campos de secretos de Personalización y Canales ya tenían `autoComplete="off"`.
- **Pendiente Fase 2 (1) — `GET /api/reminders/:phone` sin alcance.** Ahora usa `phoneInScope(req, phone)` como las notas (M1): admin siempre; operador solo clientes de sus servicios; asesor/líder solo si hay servicio/prospecto con su nombre (o de su red) o conversación sin asesor.
- **Pendiente Fase 2 (2) — el respaldo de `docker-compose.yml` no cifraba.** Nuevo `scripts/backup-compose.js` (Node, sin shell): `pg_dump` + gzip y, si `BACKUP_ENCRYPTION_KEY` está configurada y es válida, cifrado AES-256-GCM con el mismo formato que el respaldo del servidor (`[IV 16B][cifrado][tag 16B]`, `scripts/decrypt-backup.js` para leerlo); sin clave queda SIN cifrar con aviso. El servicio `backup` de `docker-compose.yml` ahora usa la imagen de la app (que lleva `pg_dump` + node) con `command: ["node", "scripts/backup-compose.js"]` y pasa `BACKUP_ENCRYPTION_KEY` y `BACKUP_KEEP_DAYS` del `.env` (ver `.env.example`).

**Plan de pruebas tras desplegar v5.3.26:**

1. Entrar con el admin y con un asesor: todo debe verse igual (el menú y el login muestran las iniciales de la empresa si no hay logo).
2. Sin sesión, `GET /api/health` debe devolver solo `{ "ok": true }` (sin versión); con sesión de admin debe traer versión, DB y WhatsApp (B1).
3. Cerrar sesión y volver a usar el token viejo (p. ej. recargar con la cookie vieja): debe dar 401 (B3). Cambiar la propia contraseña debe seguir funcionando y no sacar de la sesión (B3).
4. Crear un servicio o prospecto sin escribir ciudad: el campo empieza vacío; al guardar con ciudad, se guarda bien (B4).
5. Exportar clientes y el reporte contable: deben bajar igual; un cliente con nombre que empiece por `=` debe salir como texto, no como fórmula (B5/B9).
6. Mensajes: el inbox carga igual; con muchos chats, la respuesta viene paginada (`{ data, total, ... }`) y el contador de no leídos sigue correcto (B7).
7. Recordatorios: con un asesor, pedir los recordatorios de un cliente de otro asesor debe dar 403 (pendiente Fase 2).
8. En VPS con Docker: `docker compose up -d --build` debe levantar; la app corre como `node` (`docker compose exec app whoami` → `node`); `docker compose --profile backup run --rm backup` con `BACKUP_ENCRYPTION_KEY` en `.env` debe dejar un `.sql.gz.enc` legible con `scripts/decrypt-backup.js` (B8 + pendiente Fase 2).

**Pendiente honesto:** la auditoría completa queda cerrada en código (35/35 hallazgos). Sin probar con base de datos real (sin Postgres ni Docker en este entorno): la revocación de tokens (logout/cambio de contraseña/socket), el fail-closed con la DB caída, la paginación de chats, el cifrado del respaldo de docker-compose y la imagen Docker multi-etapa están verificados por lectura de código, typecheck, build y arranque sin DB, no con usuarios reales. El secreto débil de producción (C2) sigue siendo decisión del usuario en Railway: no rotar por ahora en la prueba.

## Envío manual de multimedia (v5.3.23, 2026-11-08)

**Qué probó el log de la 5.3.22 (2026-11-08, 20:42–20:45 UTC):** foto image/jpeg 331 KB a las 20:44:06 y video video/mp4 2365 KB a las 20:44:38: en AMBOS la línea dice **"preparación: OK (type=image/video; mimetype=image/jpeg o video/mp4; filehash=sí)"**. `processMediaData` FUNCIONA: el archivo se prepara y se sube bien. La preparación queda descartada. El fallo está en el ENVÍO, al construir el mensaje. El stack ampliado a 10 líneas lo muestra completo (idéntico en foto y video, normal y como documento): `at s (gXHQbmRh8og.js:85:180) | at I (...js:4915:5475) | at Object.m [as getSender] (...js:4915:2945) | at Object.$ [as getValidatedSender] (...js:1429:6820) | at i.initialize (...js:1424:24884) | at t.a [as constructor] (...js:35:774) | at new t (...js:33:3760) | at ...js:1046:3920 | at Generator.next`. Es decir: al construir el modelo del mensaje (`new t` → `initialize` → `getValidatedSender` → `getSender`) WhatsApp calcula el REMITENTE del mensaje y el getter memoizado recibe un id undefined y lanza.

**La hipótesis del campo del medio que sobrescribe id/from:** en el `sendMessage` inyectado de la librería (`node_modules/whatsapp-web.js/src/util/Injected/Utils.js`, `window.WWebJS.sendMessage`), el objeto del mensaje se construye así: `id: newMsgKey, ack: 0, body, from: from, to: chat.id, ..., type: 'chat'` y DESPUÉS se esparcen `...mediaOptions` y `...(mediaOptions.toJSON ? mediaOptions.toJSON() : {})`. Si el resultado de `processMediaData` (o su `toJSON`) trae un campo `id`, `from`, `sender`, `author` o `participant`, SOBRESCRIBE el id/from correctos del mensaje, y al construir el modelo el remitente sale undefined → el error exacto del log. Por eso el texto plano (sin esparcido de medio) funciona y la foto/video (con esparcido) fallan, y por eso el reintento como documento falla igual (usa el mismo `sendMessage`).

**El envío manual con los campos id/from/to al final:** en el envío por escaneo, para media de tipo image/video/document, ya NO se usa `window.WWebJS.sendMessage`. En su lugar se replica el `sendMessage` inyectado con el orden corregido: (a) `processMediaData` (la preparación de la 5.3.22 queda dentro: si falla, no se intenta el envío y el log dice `processMediaData falló`); (b) `from` y `newMsgKey` construidos exactamente como el inyectado (`chat.id.isLid() ? lidUser : meUser`, `WAWebMsgKey.newId()`, `new WAWebMsgKey({from, to: chat.id, id: newId, participant, selfDir: 'out'})`, participant solo si el chat es grupo o estado); (c) el mensaje se construye con los esparcidos del medio PRIMERO (`...md` y `...(md.toJSON ? md.toJSON() : {})`), luego `...ephemeralFields`, y AL FINAL `id: newMsgKey, ack: 0, body: (md.preview || ''), from, to: chat.id, local: true, self: 'out', t, isNewMsg: true, type: (md.type || 'chat'), caption`; (d) se envía con `WAWebSendMsgChatAction.addAndSendMsgToChat(chat, message)` y se devuelve el mensaje crudo (sin `Msg.get`, que lanza para este LID), para que la verificación existente (mensaje-crudo / último-mensaje) funcione igual que con el texto.

**Qué se registra (claves del medio):** el log del fallo por escaneo incluye ahora las CLAVES (solo los nombres de campo, no los valores) de `md` y de `md.toJSON()` y si entre ellas están `id`, `from`, `sender`, `author` o `participant` (por ejemplo `claves del medio: [...]; claves toJSON: [...]; sobrescribe: id, from`). Esto confirma el mecanismo en el próximo log. También se registran el error del envío manual y, si se usó, el del último recurso.

**Reintentos:** si el envío manual (forceDocument=false) lanza el error del getter Y la comprobación de mensajes recientes no encuentra nuestro mensaje, se reintenta UNA vez el envío MANUAL con forceDocument=true (solo image/video; document ya va así). Si el envío manual lanza un error DISTINTO del getter, se intenta UNA vez el `window.WWebJS.sendMessage` original como último recurso. El camino de texto (sin media) sigue usando `window.WWebJS.sendMessage` como hasta ahora, sin tocarlo. Los tipos sticker/audio/ptt siguen por el `sendMessage` original. El camino por id (`client.sendMessage`) NO se toca.

**Plan de pruebas tras desplegar v5.3.23:**

1. Una foto desde Mensajes y ver si llega.
2. Un video desde Mensajes, o reintentar la campaña del video, y ver si llega.
3. Mandar el log con la línea del envío por escaneo (claves del medio y si el envío fue manual).



## Separación preparación/envío de multimedia (v5.3.22, 2026-11-08)

**Qué probó el log de la 5.3.21 (2026-11-08, 15:03–15:09 UTC):** la 5.3.21 está en vivo y su diagnóstico funcionó: el log mostró el medio (image/webp 42 KB, image/jpeg 331 KB, video/mp4 1938 KB — archivos normales), el LID de la cuenta y el stack. El **LID de la cuenta SÍ está resuelto: 53786529792040@lid; yo: 573222468509@c.us** — esa hipótesis queda descartada (la clave del mensaje nuevo sale con `from` válido). El **reintento como documento TAMBIÉN falló con el error y el stack idénticos** (mismo `s` en gXHQbmRh8og.js:85:180 llamado desde `I` en el bundle es_LA ...js:4915:5475) — así que NO es la vista previa/miniatura de la foto o el video. El texto plano desde el CRM SÍ se envía (verificado por último-mensaje) y recibir multimedia SÍ funciona (imagen y video entrantes se descargaron bien, mediaStage=RESOLVED, directPath=sí). El fallo es idéntico para imagen y video, en escaneo (normal y documento) y en los dos caminos por id (LID y @c.us). El stack actual solo mostró 2 frames porque se recortó a 3 líneas.

**Qué separa este diagnóstico (preparación vs envío):** el `sendMessage` inyectado de WhatsApp Web hace dos cosas en una sola llamada: primero `processMediaData` (crear el archivo desde el base64, `prepRawMedia`, subida MMS a los servidores de WhatsApp) y luego la construcción del mensaje + `addAndSendMsgToChat` + el `Msg.get` final. El error opaco del getter no decía en cuál de las dos fallaba. En esta versión, el envío por escaneo llama a `window.WWebJS.processMediaData` **POR SEPARADO, antes** del `sendMessage`, con las mismas opciones del envío normal (forceSticker:false, forceGif:false, forceVoice:false, forceDocument: igual que el envío, forceMediaHd:false, sendToChannel:false, sendToStatus:false), dentro de su propio try/catch. El camino de texto (sin media) no hace esta preparación ni se toca.

**Qué significa cada resultado posible:**

- **Si falla `processMediaData`:** el problema está en la preparación o la subida MMS del medio (crear el archivo, la preparación del medio crudo o la subida a los servidores de WhatsApp). En ese caso NO se intenta el `sendMessage` ni el reintento como documento (fallarían igual) y el log dice `processMediaData falló: <mensaje>` con su stack de hasta 10 líneas. El error del envío pasa a ser ese.
- **Si la preparación sale BIEN y falla el envío:** la preparación y la subida MMS funcionan; el problema está en la construcción del mensaje o en el `addAndSendMsgToChat` (o en el `Msg.get` final, aunque ese ya no debería ser porque el texto sí se envía y llega). El log dice `preparación: OK (type=...; mimetype=...; filehash=sí/no)` y luego el error del envío con su stack de hasta 10 líneas.

**Otros cambios en esta versión:**

- El stack capturado pasa de 3 a 10 líneas en el error del envío (`sendStack`) y en el del reintento como documento (`retryStack`): el log de la 5.3.21 solo mostró 2 frames (`s` e `I`) y no se veía nada debajo de `I`.
- La línea de log "envío por escaneo ... falló:" incluye ahora el resultado de la preparación (OK con type/mimetype/filehash, o FALLÓ con su error y stack) además del LID y el stack del envío.
- El reintento como documento sigue existiendo (solo en el camino de escaneo, solo para image/video): salta cuando la preparación sale bien pero el envío normal falla con el error del getter. No hay reintento como documento en el camino por id.

**Costo del diagnóstico (doble subida):** cuando la preparación por separado sale bien, el `sendMessage` normal vuelve a llamar a `processMediaData` por dentro, así que el medio se sube a los servidores de WhatsApp **dos veces** en ese caso (una en la preparación de diagnóstico y otra en el envío). Es el precio de separar las dos fases; cuando el diagnóstico diga en qué fase está el fallo, se podrá quitar la llamada extra. Si la preparación falla, no hay doble subida porque no se intenta el envío.

**Plan de pruebas tras desplegar v5.3.22:**

1. Una foto desde Mensajes y ver si llega (normal o como documento).
2. Un video desde Mensajes, o reintentar la campaña del video, y ver si llega.
3. Mandar el log con la línea de preparación: ahí debe decir si `processMediaData` salió OK o FALLÓ (con su stack de hasta 10 líneas), y si el envío falló después, con su propio stack.

## Envío saliente de multimedia: diagnóstico y reintento como documento (v5.3.21, 2026-11-08)

**Qué pasaba:** en producción, enviar foto o video desde Mensajes (y desde una campaña) fallaba siempre con el error opaco "Data passed to getter must include an id property (it's how we memoize) but got undefined" y el mensaje no llegaba al teléfono. Recibir multimedia sí funciona. En la era v5.3.13 ese mismo error aparecía y la foto SÍ llegaba (el error saltaba después de enviar, en el `Msg.get` final); ahora el fallo ocurre ANTES de transmitir, en el procesamiento del medio o en el envío mismo dentro de la página. El error no decía en qué paso fallaba.

**Qué se añadió (diagnóstico):**

1. En el envío por escaneo, antes de enviar se registra si la cuenta tiene usuario LID resuelto (`getMaybeMeLidUser()` / `getMaybeMePnUser()`): el `sendMessage` inyectado construye la clave del mensaje nuevo con `from: chat.id.isLid() ? lidUser : meUser`, y si el LID no está resuelto esa clave sale rota. La línea de log "envío por escaneo ... falló:" ahora incluye el LID de la cuenta (o "sin LID") y el fragmento del stack (primeras 3 líneas), que dice en qué paso dentro de la página falló.
2. Cuando un envío lleva medio, el log registra antes de intentarlo su mimetype y su tamaño en KB.
3. La verificación por último mensaje registra ahora también el total de mensajes en `chat.msgs`, no solo los revisados: distingue "colección casi vacía" (sesión fresca, solo 1 mensaje en memoria) de "el mensaje no está".

**Qué se añadió (intento de arreglo — reintento como documento):** solo en el camino de escaneo, solo para imagen o video (el documento ya se manda así, y sticker/audio quedan fuera): si el envío normal de media lanza el error del getter Y la comprobación de mensajes recientes no encuentra nuestro mensaje, se reintenta UNA sola vez con `sendMediaAsDocument: true`. Como documento se salta la generación de vista previa/miniatura del medio, que es uno de los pasos que pueden estar fallando. Queda en el log como "tras reintento como documento" si sale, o con su error si también falla (en ese caso se reporta el error original). No hay reintento en el camino por id, para no multiplicar intentos.

**Plan de pruebas tras desplegar v5.3.21:**

1. Enviar UN texto plano desde Mensajes y decir si llega (discriminador: si el texto llega, el problema es el medio; si no, es el envío en esta sesión).
2. Enviar una foto desde Mensajes y ver si llega (normal o como documento).
3. Reintentar la campaña del video y ver si llega.
4. Mandar el log después de esas pruebas: ahora debe decir el mimetype y el tamaño del medio, si la cuenta tiene LID resuelto, y el stack del error.

## Campañas personalizadas en Seguimiento (v5.3.20, 2026-11-08)

**Qué es:** dentro de Seguimiento hay ahora dos pestañas: **Seguimiento automático** (lo de antes) y **Campañas**. La diferencia: el seguimiento automático avisa por un servicio vencido; la campaña la crea el admin cuando quiere, escogiendo los clientes de la lista, para mandarles una promoción o un aviso personalizado.

**Cómo funciona:**

1. En la pestaña Campañas, se crea la campaña: nombre, mensaje con variables `{{nombre}}` (nombre del cliente) y `{{empresa}}` (nombre de la empresa desde Personalización), y una imagen o un video opcional (máximo 25 MB, mismo tope que el chat).
2. Se escogen los clientes con buscador (por nombre o teléfono) y casillas, o “Seleccionar todos los visibles”. Máximo **100 clientes por campaña** (v1): es un tope anti-bloqueo, porque enviar cientos de mensajes seguidos por QR es lo que hace que WhatsApp marque el número como spam.
3. Crear la campaña NO la envía: queda en borrador y se manda con el botón **Enviar** cuando el admin quiera.
4. El envío va **en segundo plano** con pausa de **8 s entre clientes** (100 clientes son ~13 min): la respuesta no espera, y la lista se actualiza sola cada 5 s mientras la campaña está enviando. Cada mensaje queda en la conversación de Mensajes como uno propio más, con el nombre del cliente y la imagen o el video si tenía.
5. El historial muestra cada campaña con enviados/total y fallidos, con botones para ver los destinatarios (y su estado), reintentar los fallidos y eliminar. Si el servidor se reinicia a mitad de un envío, los que quedan en “pendiente” se pueden reenviar con Enviar/Reintentar (no se reanuda solo).
6. Eliminar una campaña no borra el archivo de la imagen o el video: los mensajes ya enviados apuntan a esa URL y borrarlo rompería sus vistas previas.

**Plan de pruebas tras desplegar v5.3.20:**

1. Crear una campaña con 2 clientes (Virtual Zone + otro), mensaje con `{{nombre}}` e imagen, y enviarla: deben llegar los 2 mensajes con su nombre y la imagen, y verse en Mensajes.
2. El historial debe mostrar 2/2 enviados.
3. Crear una campaña sin medio y enviarla: debe llegar solo texto.

## Pago manual de factura: error “FOR UPDATE cannot be applied to the nullable side of an outer join” (v5.3.19, 2026-11-08)

**Qué pasaba:** al pulsar “Registrar pago” en una factura (por ejemplo FAC-0001, $120.000) salía el error de Postgres `FOR UPDATE cannot be applied to the nullable side of an outer join` y el pago NO se guardaba: la factura seguía en pendiente con saldo $120.000. Le pasaba a CUALQUIER factura, no solo a FAC-0001: era un bug latente desde que se hizo la facturación, nunca se había probado un pago manual contra Postgres real.

**Por qué:** el endpoint `POST /api/invoices/:id/payments` bloqueaba la fila con `SELECT i.*, s.advisor, s.operators FROM invoices i LEFT JOIN services s ON s.id = i.service_id WHERE i.id = $1 FOR UPDATE`. Un `FOR UPDATE` sin lista `OF` intenta bloquear TODAS las tablas de la consulta, incluido el lado anulable del `LEFT JOIN` (services, que puede no tener fila), y Postgres lo prohíbe. El catch hacía ROLLBACK, así que no se guardaba nada.

**El arreglo (cambio mínimo, server.js línea 5404):** `FOR UPDATE` → `FOR UPDATE OF i`. Solo se bloquea la fila de `invoices`, que es la que necesita el bloqueo; `services` solo se lee para el alcance por rol (advisor/operators) y no necesita bloquearse. El resto del endpoint no se tocó: validaciones de estado, `Math.min` contra el saldo, INSERT en `payments`, recálculo de balance y estado con `invoiceStatusFor`, COMMIT, `recordEvent` y `notifyUpdate` quedan exactamente igual. Los otros tres `FOR UPDATE` del archivo (líneas ~5279, ~5448 y ~5584) son sobre una sola tabla y son correctos; se dejaron como están. No hay ningún otro `LEFT JOIN` + `FOR UPDATE` en `server.js`.

**Plan de pruebas tras desplegar v5.3.19:**

1. Registrar el pago de $120.000 en FAC-0001: debe quedar PAGADO con saldo $0 y cobrado $120.000.
2. Registrar un abono parcial en otra factura: debe quedar PARCIAL con el saldo restante.

## Imagen o video en el seguimiento, cambiable cuando se quiera (v5.3.18, 2026-11-08)

**Qué es:** el seguimiento puede llevar UNA imagen o un video, el mismo para todos los avisos. Se sube en la página Seguimiento (ajustes, sección “Imagen o video del seguimiento”) y se manda junto con el mensaje de texto (el texto va como pie de la imagen o del video). Cuando se quiere mandar otra promoción, se sube otro archivo y listo: no hay que tocar nada más.

**Cómo funciona:**

- Ajustes nuevos (en `POST /api/settings`, solo admin, no son secretos): `followup_media_url` (ruta `/uploads/wa-media/<archivo>`, vacía = sin medio) y `followup_media_type` (`'image'` | `'video'` | `''`). El servidor solo acepta URLs dentro de `/uploads/wa-media/`.
- Subida (`POST /api/followups/media`, solo admin): reutiliza el mismo multer del chat (disco a `uploads/wa-media/`, tope 25 MB) y solo admite imagen o video (nada de audio ni documentos en esta versión). Devuelve `{ url, type, mimetype }` y el frontend guarda las dos claves de ajuste. Quitar (`POST /api/followups/media/remove`, solo admin) solo vacía los ajustes: **el archivo NO se borra del disco**, porque los mensajes ya enviados apuntan a esa URL y borrarlo rompería sus vistas previas en Mensajes.
- El medio se lee de settings **en el momento del envío**, no al crear el pendiente: si se cambia la promoción, los pendientes que aún no se han enviado llevan la nueva. El texto del mensaje sí queda congelado en la fila, como antes. Al enviar, la fila guarda también la `attachment_url` (columna nueva en `followups`, con `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` para las bases de v5.3.17).
- El envío reutiliza el flujo del inbox (`sendWhatsAppMessage` con `media` + `handleIncomingWhatsApp` con `type` y `attachmentUrl`): por QR la imagen o el video salen con `MessageMedia` y el texto como pie; por Meta, por enlace público (si no hay URL pública, Meta no acepta media). En Mensajes el aviso se ve como imagen o video con su texto, como un mensaje propio más. Si el archivo no existe o no se puede leer, el aviso sale **solo con texto** (warn en el log): el recordatorio no se pierde por una promoción borrada o movida.

**Plan de pruebas tras desplegar v5.3.18:**

1. En Seguimiento, subir una imagen y enviar un pendiente: debe llegar la imagen con el texto y verse en Mensajes.
2. Cambiarla por un video y enviar otro pendiente: debe llegar el video con el texto.
3. Quitarla y enviar otro pendiente: debe llegar solo el texto.
4. En modo automático, comprobar que el envío lleva el medio que esté configurado en ese momento.

## Seguimiento automático de clientes y adiós a Auditoría & Limpieza (v5.3.17, 2026-11-08)

**Qué se borró:** el módulo “Auditoría & Limpieza” (`components/AuditModule.tsx`, su caso en `App.tsx` y su entrada en el menú). Solo buscaba servicios duplicados (mismo teléfono y misma fecha) y dejaba borrarlos uno por uno; sin duplicados se veía vacío y parecía que no hacía nada. El endpoint `GET /api/stats/overview` SE QUEDA (lo usa el Dashboard); solo se borró la pantalla. En su lugar, en el menú, quedó **Seguimiento** (solo admin).

**Cómo funciona el seguimiento:** cuando un servicio con estado REALIZADO o PAGADO cumple el intervalo configurado (por defecto 3 meses desde la fecha del trabajo), el CRM crea un pendiente en la tabla `followups` y, según el modo, lo envía por WhatsApp:

- **Modo manual (por defecto):** el trabajo diario solo crea los pendientes. El admin los ve en Seguimiento, puede editar el mensaje de cada uno y pulsar Enviar (o “Enviar todos los pendientes”), o Omitir el que no quiera mandar.
- **Modo automático:** el trabajo diario crea los pendientes y los envía solo a la hora configurada, con pausa de 8 s entre envíos. Si un envío falla queda en “Fallido” con botón Reintentar.

**Personalizable por el admin (página Seguimiento, ajustes guardados en settings, solo admin):**

- `followup_enabled` (activado o no, por defecto apagado), `followup_months` (1–12, por defecto 3), `followup_mode` (`manual` | `auto`, por defecto `manual`), `followup_hour` (0–23, por defecto 9, hora de Bogotá) y `followup_message` (plantilla con variables `{{nombre}}`, `{{servicio}}`, `{{fecha}}` y `{{meses}}`). Plantilla por defecto: “Hola {{nombre}}, soy de Purifica Tu Ambiente. Hace {{meses}} meses hicimos la limpieza de {{servicio}} en tu hogar y ya es hora de otra limpieza. ¿Te agendo una visita esta semana?”
- El trabajo diario corre a la hora configurada (mismo patrón que el respaldo diario) y se reprograma tras cada corrida, así que cambiar la hora no necesita reinicio. El botón “Buscar pendientes ahora” (`POST /api/followups/run-now`) ejecuta el escaneo sin esperar a mañana.

**Una sola vez por servicio:** `followups.service_id` es UNIQUE y el escaneo salta los servicios que ya tienen fila, así que un cliente nunca recibe dos veces el aviso por el mismo trabajo. Los enviados no se pueden reenviar desde la lista (solo los fallidos se reintentan).

**El mensaje queda en la conversación:** el envío reutiliza el flujo del inbox (`sendWhatsAppMessage` + `handleIncomingWhatsApp` con sender `agent`): el mensaje aparece en Mensajes como uno propio más, con su `external_id`, y el dedup por `external_id` / eco de 60 s evita copias dobles. Por QR se puede enviar en cualquier momento (sin la regla de 24 h de la API de Meta); si la conversación ya tenía canal Meta, sale por Meta.

**Endpoints (todos solo admin en v1):** `GET /api/followups?status=&limit=100`, `POST /api/followups/:id/send` (body opcional `{ message }` para enviar el texto editado), `POST /api/followups/:id/skip`, `POST /api/followups/send-all` (todos los pendientes, pausa de 8 s), `POST /api/followups/run-now`.

**Plan de pruebas tras desplegar v5.3.17:**

1. En Seguimiento, poner intervalo 3 meses y modo manual, activar el seguimiento, guardar y pulsar “Buscar pendientes ahora”: debe aparecer la lista de pendientes (servicios REALIZADO/PAGADO de hace 3 meses o más).
2. Editar el mensaje de un pendiente y enviarlo: debe llegar una sola vez al cliente y aparecer en Mensajes como mensaje propio.
3. Poner modo automático y una hora cercana, esperar al día siguiente (o a la hora): debe enviarse solo y quedar en “Enviados”.
4. Confirmar que “Auditoría & Limpieza” ya no aparece en el menú y que en su lugar está “Seguimiento”.

## Limpiar la caché de WhatsApp sin borrar la sesión ni las fotos (v5.3.16, 2026-11-08)

**El problema:** el volumen de Railway está casi lleno (81 % de 0.5 GB en
Trial) y el usuario lo quiere limpio para enseñárselo al cliente. Lo que
más pesa en ese volumen es el perfil de Chrome de la sesión de WhatsApp
(sus cachés crecen con el uso), más las fotos subidas.

**Qué hay en el volumen (`/app/data`, env `PERSIST_DIR=/app/data`):**

- La sesión de WhatsApp: carpetas `session-wa-session-<id>/` (LocalAuth).
  Sus credenciales viven en archivos de la sesión (Local Storage /
  IndexedDB / raíz de la sesión).
- La media subida: `uploads/wa-media/` (las fotos, audios y videos del
  historial de chats).

**Por qué NO hay que borrar el volumen desde Railway:** borrar el volumen
borra la sesión de WhatsApp Y todas las fotos, y obliga a reescanear el QR
desde cero. Nunca se hace para “limpiar”.

**Qué hace el botón nuevo (Estado del Sistema → Acciones → “Limpiar caché
de WhatsApp”, solo admin, endpoint `POST /api/system/whatsapp/clean-cache`):**

1. Para las instancias QR con `stopWaInstance` (la misma parada
   centralizada de Reconectar). Nunca se borran cachés con Chrome
   corriendo. Las instancias Meta no tienen navegador: no se tocan.
2. Mide el tamaño antes (sesión y fotos por separado).
3. Borra SOLO carpetas de caché regenerables de Chrome dentro de cada
   perfil `session-wa-session-*/Default/`, lista explícita
   (`WA_CACHE_DIR_ALLOWLIST`): `Cache`, `Code Cache`, `GPUCache`,
   `Service Worker/CacheStorage`, `ShaderCache`, `Crashpad`, `DawnCache`,
   `GraphiteDawnCache`, `blob_storage`. Chrome las vuelve a crear solo.
   Cada ruta se resuelve y se valida que empiece por `waDataDir()` antes
   de borrar.
4. Reinicia las instancias paradas con la misma sesión guardada (sin QR).
   La respuesta no espera al ready: el estado se ve en Estado del
   Sistema y el vigilante de ready actúa si algo se atasca.
5. Devuelve `{ beforeMB, afterMB, freedMB, sessionMB, uploadsMB }` y
   registra un `system_event` con el resultado.

**Qué NO toca:** la raíz de la sesión, `Default` entero, `Local Storage`,
`IndexedDB`, ni `uploads/wa-media` (las fotos del historial se quedan; si
se borraran, las fotos del chat se romperían). El desglose de
almacenamiento (sesión vs fotos vs libre del volumen) se muestra en la
tarjeta de WhatsApp de Estado del Sistema y viaja en `GET
/api/system/status` como bloque `storage` (con caché de 60 s, para no
recorrer el perfil en cada refresco de 30 s).

**El arreglo de fondo sigue siendo pasar a Hobby (5 $/mes):** el volumen
pasa de 0.5 GB a 5 GB y la limpieza deja de ser urgente. La limpieza es
para estirar el Trial y para mantener el volumen sano, no sustituye el
cambio de plan.

**Plan de pruebas tras desplegar v5.3.16:**

1. En Estado del Sistema, ver el desglose (sesión X MB · Fotos Y MB ·
   Volumen libre Z MB de W MB).
2. Pulsar “Limpiar caché de WhatsApp” y confirmar: debe decir cuántos MB
   liberó, y WhatsApp debe volver a “ready” solo, SIN pedir QR nuevo.
3. Mandar un texto y una foto desde el CRM: deben llegar una sola vez y
   la foto debe verse (la limpieza no toca ni la sesión ni la media).

## Configuración de Google Calendar y Telegram en el CRM (v5.3.15, 2026-11-08)

**El usuario tiene razón:** Google Calendar y Telegram no tenían dónde
configurarse en el CRM. La API existía (el refresh token de Google sí se
podía guardar por `POST /api/settings`, y Telegram se leía solo de env),
pero ningún formulario la usaba: Google solo se configuraba con el script
local y variables en Railway, y Telegram solo con `TELEGRAM_BOT_TOKEN` /
`TELEGRAM_CHAT_ID` en el .env. Estado del Sistema solo mostraba el estado
y el aviso, sin campos para poner los valores.

**Qué se añadió en v5.3.15 (Estado del Sistema → Configuración de
integraciones, solo admin):**

- **Google Calendar:** campos para Client ID, Client Secret y Refresh Token
  (tipo password), Calendar ID (por defecto `primary`), duración de cada
  servicio en minutos (por defecto 120) y checkbox Habilitado. Botón
  Guardar (una llamada a `POST /api/settings` por clave; los secretos
  vacíos NO se envían, lo guardado se conserva) y botón Probar conexión
  (`POST /api/system/google-calendar/test`). La línea de estado muestra
  Configurado / No configurado con el motivo, con los datos que ya
  cargaba la página.
- **Telegram:** campos para Bot Token (password) y Chat ID, botón Guardar
  (mismo patrón: vacíos no se envían). El botón “Probar alerta de
  Telegram” que ya existía en Acciones se queda donde está y funciona
  tras guardar.
- **Seguridad, sin cambios de criterio:** los secretos NUNCA se traen ni
  se muestran (los campos empiezan vacíos; si está configurado, el
  placeholder dice “•••••••• (configurado)”). `GET /api/settings` ahora
  también borra `telegram_bot_token`, `telegram_chat_id` y
  `google_client_id` (además de `google_client_secret`,
  `google_refresh_token` y `meta_wa_token`, que ya borraba). Las 6 claves
  nuevas (`google_client_id`, `google_client_secret`,
  `telegram_bot_token`, `telegram_chat_id`) están en
  `ALLOWED_SETTINGS_KEYS` y en `ADMIN_ONLY_SETTINGS`: solo el admin las
  escribe. El backend lee primero de settings y, si está vacío, del env
  (Railway/.env sigue funcionando como antes, sin tocar nada).

**Cómo configurar cada integración paso a paso:**

- **Telegram:** 1) En Telegram, habla con @BotFather, crea un bot con
  `/newbot` y copia el token que te da. 2) Abre el bot y mándale un
  mensaje cualquiera (o añádelo al grupo donde deben llegar las
  alertas). 3) Consigue el chat id: abre
  `https://api.telegram.org/bot<TU_TOKEN>/getUpdates` en el navegador y
  busca `"chat":{"id":...}` (es un número, puede ser negativo en
  grupos). 4) En el CRM: Estado del Sistema → Configuración de
  integraciones → Telegram: pega el token y el chat id, Guardar, y luego
  “Probar alerta de Telegram” en Acciones: debe llegar el mensaje al
  chat.
- **Google Calendar:** 1) En Google Cloud Console crea un proyecto (o
  usa uno existente) y habilita la **Google Calendar API**. 2) Credenciales
  → Crear credenciales → **ID de cliente de OAuth** → tipo **Aplicación
  de escritorio**; anota el Client ID y el Client Secret. En “URIs de
  redireccionamiento autorizados” añade `http://localhost:8089`. 3) Corre
  `node scripts/get-google-refresh-token.js <CLIENT_ID> <CLIENT_SECRET>`,
  abre la URL que imprime con la cuenta de Google de la empresa, acepta
  el acceso al calendario y copia el refresh token que imprime. 4) En el
  CRM: Estado del Sistema → Configuración de integraciones → Google
  Calendar: pega Client ID, Client Secret y Refresh Token, deja Calendar
  ID en `primary` (o el ID de un calendario compartido), duración 120 y
  Habilitado marcado, Guardar. 5) Pulsa “Probar conexión”: debe crear y
  borrar un evento de prueba de 15 min. (También se puede seguir usando
  el .env con `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CALENDAR_ID` y
  `GOOGLE_CALENDAR_DURATION_MINUTES`; lo de settings tiene prioridad si
  está puesto.)

**Plan de pruebas tras desplegar v5.3.15:**

1. Guardar el token y el chat id de Telegram y pulsar “Probar alerta de
   Telegram” → debe llegar el mensaje a Telegram.
2. Guardar las credenciales de Google y pulsar “Probar conexión” → debe
   decir que el evento de prueba se creó y se borró.
3. El resto de pruebas de la 5.3.14: UN solo texto desde el CRM llega UNA
   sola vez al celular del contacto, sin letrero.

## Verificación por remitente (anti-triplicación, por fin) + 5 reintentos de arranque (v5.3.14, 2026-11-08)

**Lo que probó el usuario con la v5.3.13 (log 05:44:25–05:54:17 UTC,
captura 00:56 local):** "por fin ya envia multimedia y se ve, pero
tenemos un problema sigue enviando 2 o 3 veses el mismo mensaje a
whasap del cliente" — "hola" x3 a las 00:49 y x3 a las 00:50, "." x3.
La multimedia YA funciona (confirmado por el usuario), pero la
triplicación sigue.

**La causa raíz, probada en el log:** cada POST dispara los tres
caminos (escaneo, LID, @c.us) y los tres transmiten, porque la
verificación NUNCA encuentra nuestro mensaje. La pista decisiva es la
línea de verificación: "ninguno de los últimos 5 mensajes es nuestro
y coincide con el enviado (último: fromMe=false, type=chat, hace 2 s,
revisados: 5)" — y ese "hace 2 s" coincide EXACTAMENTE con el
timestamp de nuestros propios ecos message_create (ej.: verificación a
las 05:49:53.617, último mensaje de hace 2 s = eco de las
05:49:51.606; a las 05:50:08.776, hace 13 s = eco de las 05:49:55.675;
a las 05:50:13.293, hace 1 s = eco de las 05:50:12.896). O sea: nuestro
mensaje SÍ está entre los últimos 5 de chat.msgs, pero se lee con
`fromMe === false`, así que `lastMatches` (que exigía `info.fromMe`)
lo rechazaba siempre. En este chat LID, los mensajes propios guardados
en chat.msgs leen fromMe=false (el eco del evento message_create sí
trae fromMe=true, pero la copia en la colección no). Esa es la causa
raíz de la triplicación: la verificación no podía ver que el envío ya
salió, así que probaba los otros dos caminos y cada uno mandaba su
copia.

**Corrección en v5.3.14 (verificación por REMITENTE, no por fromMe):**
en `recentMsgsInfo` (tanto en el evaluate del escaneo `sendWaByScan`
como en `verifyWaLastMessage`) se devuelve además `idFromMe` (de
`m.id.fromMe`) y `sender` (de `m.from._serialized` o `m.from.$1`). En
`lastMatches` / `matches`, un mensaje es nuestro si es reciente
(<60 s) Y coincide en contenido/type Y (fromMe O idFromMe O el
remitente NO es el contacto). El contacto es `lidDigits + '@lid'` y
`phoneDigits + '@c.us'`. Es decir: un mensaje reciente con el mismo
contenido cuyo remitente no es el contacto es nuestro, aunque fromMe
lea false. La ventana sigue siendo los últimos 5 mensajes y la espera
de ~2 s antes de verificar. En la línea de log de verificación fallida
ahora se añade el remitente, fromMe e idFromMe del último mensaje
revisado, para diagnosticarlo en el próximo log.

**Segundo hallazgo del mismo log (secundario):** el arranque de la
v5.3.13 falló 7 veces seguidas con el mismo error transitorio
"Protocol error (Runtime.callFunctionOn): Execution context was
destroyed" en Client.inject durante Client.initialize (05:44:30,
05:44:42, 05:45:15, 05:46:17, 05:48:18, 05:48:30, 05:48:39); los 3
reintentos de v5.3.8 no alcanzaron y el usuario tuvo que escanear el QR
de nuevo (QR recibido 05:48:51, listo 05:49:31). La sesión no se
restauró en ese arranque (causa no probada en el log).

**Corrección en v5.3.14 (reintentos de arranque):** de 3 a 5 reintentos
transitorios, delays [10000, 30000, 60000, 120000, 120000]. Textos del
log actualizados ("reintento N/5", "se agotaron los 5 reintentos"). El
vigilante sigue intentando una re-inicialización más al agotar los
reintentos, como antes.

**Lo que NO se tocó en v5.3.14:** el arreglo de mimetype de la
multimedia (FUNCIONA, no se tocó), el segundo servicio (App.tsx),
PERSIST_DIR, el dedup de ecos, el guardado-con-etiqueta, el mapeo
LID/canónico y la auto-restauración.

**Plan de pruebas tras desplegar v5.3.14:**

1. Enviar UN solo texto desde el CRM — debe llegar UNA sola vez al
   celular del contacto, sin letrero, y el log debe decir que la
   verificación lo encontró (por remitente).
2. Enviar UNA foto desde el CRM — una sola vez, sin letrero.
3. Recibir una foto desde el teléfono — debe aparecer con vista previa.

## Enviar UNA vez (anti-triplicación) + multimedia con mimetype + segundo servicio sin sobrescribir (v5.3.13, 2026-11-08)

**Lo que probó el usuario con la v5.3.12 (log 05:16:59–05:19:11 UTC,
capturas 00:18–00:19 local):** "no nada" — dos problemas:

1. **TRIPLICACIÓN:** el celular del contacto recibe "buenas" x3 y "hjj"
   x3 por UN solo envío desde el CRM. El log muestra por cada POST: el
   escaneo ENCUENTRA el chat ("64 chats en lista, 1 coincidencias
   (265076942618676@lid)") pero "WWebJS.sendMessage devolvió vacío y el
   último mensaje no coincide"; el respaldo LID y @c.us devuelven
   undefined (el pre-chequeo getChatById lanza "r"); la verificación
   falla ("el último mensaje no es nuestro (último: fromMe=false,
   type=chat, hace 0 s)").
2. **MULTIMEDIA:** la descarga defensiva por fin dijo la causa: el
   mensaje SE encuentra, el stage es RESOLVED y hay directPath, pero
   "downloadAndMaybeDecrypt lanzó: Unexpected mimetype
   application/octet-stream for media type image".

**Por qué se triplicaba:** los tres caminos SÍ transmiten (el
sendMessage inyectado envía primero y solo después falla en
Msg.get/getMessageModel; el getChat del respaldo usa getAsModel=false y
sí puede encontrar el chat aunque getChatById/getChatModel lance "r"),
pero ninguno puede confirmarlo, así que el código probaba los tres y el
contacto recibía 3 copias. La etiqueta del log "chat no encontrado" era
engañosa: significa "la librería devolvió undefined", no que el chat no
exista (el escaneo ya probó que sí está en la lista).

**Correcciones en v5.3.13 (envío):**

1. **Enviar una vez, verificar, y solo reintentar si la verificación
   prueba que no salió:** después de CADA intento (escaneo, luego LID,
   luego @c.us) se espera ~2 s y se verifica ANTES de probar el
   siguiente camino. La verificación busca NUESTRO mensaje entre los
   ÚLTIMOS 5 mensajes del chat (fromMe, mismo body/caption o mismo type
   de media, menos de 60 s). Si aparece, éxito y PARAR: no se prueba
   ningún otro camino. Solo si no aparece se prueba el siguiente. El
   error final solo se reporta si TODOS los intentos verificaron que el
   mensaje no salió. Cada verificación queda en el log (encontrado/no
   encontrado, cuántos mensajes se revisaron).
2. **La verificación interna del escaneo y `verifyWaLastMessage` miran
   los últimos 5 mensajes, no solo el último:** el log probó que la
   respuesta del contacto puede caer entre nuestro envío y la
   verificación (el último mensaje era del contacto, "hace 0 s") y el
   nuestro quedaba segundo.
3. **Etiqueta corregida:** donde el log decía "chat no encontrado" al
   devolver undefined la librería, ahora dice que la librería devolvió
   undefined y que el envío pudo haber salido (se verifica por escaneo).
   El error final ya no dice "no encontró el chat" sino "No se pudo
   confirmar el envío a … (se probaron: …; la verificación por escaneo
   no encontró el mensaje en el chat)".

**Corrección en v5.3.13 (multimedia):** la llamada de la librería a
`downloadAndMaybeDecrypt` (Message.js:562) NO pasa ningún mimetype, así
que el gestor de descargas de WhatsApp Web usa el del mensaje, que para
este contacto viene como `application/octet-stream`, y lo rechaza para
un type=image. Ahora `downloadWaMediaFromPage` le pasa un `mimetype`
explícito: el del mensaje cuando es un tipo real para ese medio
(image/* para image, video/* para video, audio/* para audio/ptt,
image/webp para sticker); si es `application/octet-stream` o no
corresponde, se deriva del type (image → `image/jpeg`, video →
`video/mp4`, audio/ptt → `audio/ogg; codecs=opus`, sticker →
`image/webp`, document → su mimetype o `application/octet-stream`). La
línea "descarga defensiva" registra tanto el mimetype del mensaje como
el efectivo pasado. El tope de 25 MB, el reintento y el guardado con
etiqueta no cambian. Además `waMediaExtFromMime` ahora quita los
parámetros del mimetype antes de buscar la extensión, para que una nota
de voz no se guarde como `.bin`.

**Corrección en v5.3.13 (segundo servicio sin sobrescribir):** un cliente
que ya tiene un servicio agendado y pide OTRO ya no pierde el anterior.
Antes, `handleOpenFullService` (App.tsx) buscaba el primer servicio del
cliente y lo abría para editarlo, así que el servicio anterior se
sobrescribía y no quedaban dos servicios separados. Ahora: si el
servicio existente ya es una cita en firme (AGENDADO, CONFIRMADO,
REAGENDADO) o está en estado terminal (REALIZADO, PAGADO, CANCELADO),
se abre el formulario como servicio NUEVO prellenado con los datos del
cliente (nombre, teléfono, ítems, dirección, valor e imágenes del lead);
solo se sigue editando el existente cuando aún no tiene estado (fila
heredada sin dealStatus). La BD ya soporta varios servicios por cliente
(POST /api/services inserta una fila nueva por id; ServiceForm genera el
id nuevo con `Date.now().toString()`), y el cliente y el lead no se
duplican (clients es único por teléfono, el lead se actualiza por
conversation_id). OJO con los valores: COTIZADO / EN_DECISION / PERDIDO
/ NUEVO son estados del LEAD, no del servicio; el deal_status real del
servicio (DealStatus en types.ts, columna deal_status con DEFAULT
'AGENDADO') solo puede ser AGENDADO, CONFIRMADO, REALIZADO, PAGADO,
CANCELADO o REAGENDADO — REALIZADO es el "completado" de los servicios.
Por eso la regla se escribió con los valores reales y no con los del
lead. Si el cliente tiene varios servicios, la regla se aplica al
primero que encuentra `services.find`, como hoy.

**Lo que NO se tocó en v5.3.13:** PERSIST_DIR, el reintento transitorio
v5.3.8, el mapeo LID/canónico, el dedup de ecos, el guardado-con-etiqueta
y la auto-restauración.

**Plan de pruebas tras desplegar v5.3.13:**

1. Enviar UN texto desde el CRM — debe llegar UNA sola vez al celular
   del contacto y sin letrero.
2. Enviar una foto desde el CRM — una sola vez, sin letrero.
3. Recibir una foto desde el teléfono — debe aparecer con vista previa
   y el log debe decir el mimetype usado
   (`mimetypeMsg=… mimetypeEfectivo=…`).
4. Cliente con servicio AGENDADO → Sincronizar Venta abre un formulario
   NUEVO prellenado con sus datos (no edita el agendado).
5. Al guardar ese segundo servicio, el cliente tiene 2 servicios en la
   lista de Servicios. (El caso "editar como antes" solo se da si el
   servicio existente no tiene estado; en la práctica no ocurre porque
   el backend guarda AGENDADO por defecto — por eso no hay un paso de
   prueba con servicio COTIZADO: COTIZADO es estado del lead, no del
   servicio.)

## Que un envío que SÍ llegó no se reporte como fallido (v5.3.12, 2026-11-07)

**Lo que reportó el usuario (captura 23:29 local):** "sale ese letrero
pero esta enviando bien los mensajes" — los mensajes SÍ llegan al
celular, pero el letrero rojo sigue diciendo "WhatsApp no encontró el
chat para +573116040943 (se probaron: 265076942618676@lid,
573116040943@c.us)". Y "lo que sigue con problemas es el multimedia"
(las fotos siguen saliendo solo como etiqueta "Imagen", sin vista
previa). El dedup SÍ funciona ahora: "hola" y "." aparecen una sola vez
cada uno en el chat.

**La causa del letrero falso, probada en la librería:** el
`sendMessage` inyectado (Utils.js) termina con
`return Msg.get(newMsgKey._serialized)` — o sea, DESPUÉS de enviar el
mensaje lo vuelve a buscar en la colección por su id, y ese `Msg.get`
LANZA para este LID (es el mismo "t"/"r" de los logs anteriores). El
mensaje ya se envió y llegó, pero la confirmación no se puede
construir: `Client.sendMessage` devuelve undefined o lanza, y el código
lo reportaba como fallido. Lo mismo valía para el envío por escaneo de
v5.3.11 si su evaluate devolvía el modelo (vía `getMessageModel`, que
llama a `message.serialize()`) en vez del mensaje crudo.

**Correcciones en v5.3.12:**

1. **Éxito por mensaje crudo en el escaneo (`sendWaByScan`):** ya no se
   llama a `getMessageModel`. Si `WWebJS.sendMessage` devuelve un
   objeto mensaje (truthy), el envío fue un éxito y el id se saca de
   `msg.id` (`_serialized` o `$1`). Y si `sendMessage` LANZA, no se da
   por perdido: se mira el último mensaje del chat (en el mismo
   evaluate, de `chat.msgs`, sin `Msg.get`) y si es nuestro, reciente
   (menos de 60 s) y coincide con lo enviado, también es éxito. El log
   dice "mensaje enviado por escaneo (id: …, verificado por:
   mensaje-crudo | ultimo-mensaje)".
2. **Verificación por último mensaje en el respaldo
   (`verifyWaLastMessage`):** después de que el camino por id (LID ->
   @c.us) falle, ANTES de reportar el error se escanea el chat y se lee
   su último mensaje — de `chat.msgs` (la colección en memoria del
   propio chat) o, si no está ahí, por `chat.lastReceivedKey` buscado
   DENTRO de `chat.msgs` (la librería usa ese campo en `getChatModel`,
   Utils.js:982-998, para el último mensaje del chat). Coincide si es
   nuestro (fromMe), tiene menos de 60 s y su body/caption es el
   contenido enviado (texto) o su type es el del medio enviado (media
   sin caption). Si coincide, el envío se reporta como éxito con el id
   de ese mensaje ("envío verificado por último mensaje") y NO sale el
   letrero. Solo si la verificación también falla se reporta el error
   como antes. Aplica a texto Y a media.

**Lo que NO se tocó en v5.3.12:** la descarga defensiva (ya registra
cada paso; el diagnóstico de la multimedia necesita el log del usuario,
no otro cambio a ciegas), el dedup de ecos, PERSIST_DIR, el reintento
transitorio v5.3.8, el mapeo LID/canónico, el guardado-con-etiqueta y la
auto-restauración.

**Plan de pruebas tras desplegar v5.3.12:**

1. Enviar un TEXTO desde el CRM — debe llegar Y ya no debe salir el
   letrero.
2. Enviar una FOTO desde el CRM — igual, sin letrero.
3. Mandar el log para ver las líneas "descarga defensiva" de la foto
   entrante (eso dirá en qué paso falla la multimedia).

## Enviar y descargar por escaneo de la lista, no por id (v5.3.11, 2026-11-07)

**Primero, la buena noticia de v5.3.10 (log 01:20-01:22 UTC):** la línea
de arranque dice `PERSIST_DIR=/app/data waDataDir=/app/data
uploadsDir=/app/data/uploads sesionesGuardadas=4`, se limpiaron 3 locks
y la instancia llegó a `autenticado` y `está listo!` a los 4 segundos
SIN pedir QR. La sesión SÍ sobrevive a los despliegues; el QR de la vez
anterior fue un caso aislado.

**Lo que sigue fallando, con evidencia nueva y decisiva:**

1. **ENVÍO DE TEXTO:** el pre-chequeo `getChatById` LANZA el error de
   una sola letra "r" para ambos ids (`pre-chequeo del chat
   265076942618676@lid falló: r`, igual para `@c.us`), y `sendMessage`
   devuelve undefined ("chat no encontrado"). En la librería:
   `Client.getChatById` (Client.js:1693) hace `pupPage.evaluate(chatId
   => window.WWebJS.getChat(chatId))` con `getAsModel=true` por defecto,
   o sea que pasa por `getChatModel` (que llama `chat.serialize()`,
   `chat.formattedTitle` y `Msg.get(chat.lastReceivedKey._serialized)`).
   Y `WWebJS.getChat` (Utils.js:842) hace `Chat.get(chatWid) ||
   findOrCreateLatestChat(chatWid)` sin try/catch en esa rama.
2. **DESCARGA DE MEDIA:** la normalización del id de v5.3.10 SÍ
   funcionó (el log muestra el id con `_serialized` ya presente:
   `"false_265076942618676@lid_A579..."`), pero la descarga SIGUE
   fallando, ahora con error "t" en vez de "r". En la librería:
   `Message.downloadMedia` (Message.js:513) hace
   `Msg.get(msgId) || getMessagesById([msgId])` SIN try/catch alrededor
   del `Msg.get` — si `Msg.get` LANZA (en vez de devolver undefined),
   el fallback a `getMessagesById` nunca se ejecuta y todo el evaluate
   rechaza con esa letra.
3. **LA IMAGEN NO SE VE:** la etiqueta "📷 Imagen" aparece
   (guardado-con-etiqueta funciona), pero la foto no se descarga por el
   punto 2.
4. **"CUANDO ENVÍO DESDE EL CRM SALEN 3 MENSAJES":** el log lo explica
   — en 01:21:05 hay UN POST del CRM ("hola") y DOS eventos
   `message_create` del teléfono con 39 ms de diferencia (01:21:05.542
   y 01:21:05.581, mismo "hola") — demasiado rápido para ser dos toques
   del usuario: la librería emite el mensaje propio dos veces (eco
   local + versión del servidor, con ids distintos, así que el dedup
   por external_id no los caza). 1 guardado fallido del CRM + 2 ecos =
   3 burbujas. El dedup de reintentos fallidos de v5.3.10 SÍ funcionó
   (log 01:22:15: "intento fallido duplicado (mismo contenido sin
   enviar en 5 min); no se guarda otra copia").
5. **ENVÍO DE FOTO desde el CRM:** el banner vuelve al error original
   del getter ("Data passed to getter must include an id property..."):
   el envío de media llega más lejos que el de texto (revienta DENTRO
   del send, en processMediaData o al construir el mensaje) en vez de
   "chat no encontrado".

**Patrón común probado:** todo lo que busca por id en las colecciones
de WhatsApp Web falla o lanza para esta identidad LID (Chat.get,
Msg.get, getChatModel), pero el sistema de eventos entrega los mensajes
bien y el chat existe. Por eso la estrategia cambia: ESCANEAR las
colecciones en vez de buscar por id. La propia librería lo hace en
`getChats` (Utils.js:921: `Chat.getModelsArray()`).

**Correcciones en v5.3.11:**

1. **Envío por escaneo (`sendWaByScan`):** antes de probar los ids por
   `sendMessage`, UN evaluate escanea
   `window.require('WAWebCollections').Chat.getModelsArray()` y busca
   un chat cuyo `id._serialized` o `id.user` contenga los dígitos del
   LID o del teléfono; el log dice cuántos chats hay en total, cuántos
   coincidieron y sus ids canónicos (sin contenido de mensajes). Si lo
   encuentra, envía con ESE objeto chat en el mismo evaluate llamando a
   `window.WWebJS.sendMessage(chat, content, options)` (replica el
   cuerpo del evaluate de `Client.sendMessage`, sin el getChat ni el
   sendSeen, que son los pasos que fallan). Si el escaneo no encuentra
   el chat, cae al camino actual (LID → @c.us con pre-chequeo) como
   antes. Si el envío por escaneo devuelve undefined o lanza, registra
   el error completo y cae al camino actual.
2. **Descarga defensiva (`downloadWaMediaFromPage`):** ya no usa
   `msg.downloadMedia()`; es un evaluate propio con cada paso en su
   propio try/catch y su línea de log: (a) `Msg.get`, (b)
   `getMessagesById`, (c) escaneo de `Msg.getModelsArray()` por id
   serializado; con el mensaje encontrado registra `mediaStage`,
   `directPath` (solo si existe o no) y `mimetype`, y solo entonces
   intenta resolver la media y el `downloadAndMaybeDecrypt` (lógica
   copiada de Message.js:513-590). Si todo falla, el mensaje se guarda
   con etiqueta como hoy. Se mantienen el tope de 25 MB y el reintento
   a los 5 s.
3. **Dedup de ecos propios:** en `handleIncomingWhatsApp`, cuando
   `sender === 'agent'`, no se guarda el mensaje si en los últimos 60
   segundos ya se guardó uno idéntico en esa misma conversación (mismo
   type, content y adjunto). Esto caza los dos ecos del mismo mensaje
   del teléfono, que tienen external_id distinto. No toca el dedup por
   external_id ni el de fallidos de 5 min.

**Plan de pruebas tras desplegar v5.3.11:**

1. Texto desde el CRM — debe llegar al celular y el log debe decir
   "chat encontrado por escaneo" (o "mensaje enviado por escaneo").
2. Foto desde el CRM.
3. Foto/audio entrante con vista previa (el log debe decir en qué paso
   se encontró el mensaje: get / getMessagesById / scan).
4. Enviar "hola" desde el teléfono y verificar que aparece UNA sola
   vez.
5. Enviar un texto desde el CRM y verificar que aparece UNA sola vez.

## El id de mensaje no trae `_serialized`: envío, descarga y duplicados (v5.3.10, 2026-11-07)

**Lo que pasó en producción con v5.3.9 (log 00:39-00:44 UTC):** la
instancia arrancó pidiendo QR (la sesión NO se restauró al arrancar; el
usuario tuvo que darle a Reconectar y volver a escanear; autenticado
00:42:57, listo 00:42:58). Al probar, tres problemas:

1. **EL LETRERO SIGUE:** "WhatsApp no encontró el chat
   `573116040943@c.us`". Y el LID tampoco bastó: el log muestra que el
   envío por LID también devuelve undefined (`la librería devolvió
   undefined al enviar al chat 265076942618676@lid`) y luego lo mismo con
   `@c.us`. O sea que `window.WWebJS.getChat` devuelve null para AMBOS
   ids. El mapeo LID sí se guardó (el segundo intento ya probó el LID
   primero), pero no bastó.
2. **DUPLICADOS:** "hola" x4 y "holmo" x3 en el chat. Mecanismo: (a) cada
   intento fallido desde el CRM se guarda igual, así que cada reintento
   del usuario es una burbuja más; (b) el evento `message_create` se
   dispara DOS veces por el mismo mensaje del teléfono (00:43:24.189 y
   00:43:24.211, "hola" dos veces con 22 ms de diferencia) y AMBAS se
   guardan porque el dedup por `external_id` no funciona: el external_id
   queda NULL.
3. **LA MEDIA SALE SOLO COMO ICONO:** las etiquetas "📷 Imagen" y
   "🎤 Nota de voz" sí aparecen (el guardado-con-etiqueta de v5.3.9
   funciona), pero sin la foto ni el audio. La descarga sigue fallando.

**La causa raíz común, probada por el log completo:** el id del mensaje
NO trae `_serialized`. La línea de descarga muestra el id crudo:
`{"fromMe":true,"remote":"265076942618676@lid","id":"AC426D0F43A9E3C1CEA515495A4EFC45","$1":"true_265076942618676@lid_AC426D0F43A9E3C1CEA515495A4EFC45"}`
— la forma serializada está en `$1`, no en `_serialized`. Por eso:
(a) `msg.downloadMedia()` falla, porque la librería busca el mensaje por
`this.id._serialized` (undefined) — el error que llega es una "r" (el
evaluate de puppeteer rechaza con ese valor); (b)
`externalId: msg.id?._serialized || null` queda NULL y el
`ON CONFLICT (external_id) DO NOTHING` nunca deduplica (los NULL no
chocan); (c) el `messageId` de los envíos también queda NULL.
En la librería (whatsapp-web.js 1.34.7): `Client.sendMessage` hace
`window.WWebJS.getChat(chatId, {getAsModel:false})` y `if (!chat) return
null;` — por eso un chat no encontrado se veía como undefined.
`WWebJS.getChat` usa `Chat.get(chatWid) || findOrCreateLatestChat(chatWid)`.
Y `Message.getChat()` es `getChatById(this.fromMe ? this.to : this.from)`
(Message.js:388, `_getChatId` :347-349): el id canónico del chat 1:1 ES
el id del interlocutor.

**Correcciones en v5.3.10:**

1. **Normalización del id (`waMsgSerializedId`):**
   `msg.id?._serialized || msg.id?.$1 || fromMe_remote_id`. Se usa en
   todos los sitios que hoy usan `msg.id?._serialized`: en
   `downloadWaMedia` se asigna `msg.id._serialized` ANTES de llamar
   `msg.downloadMedia()` (para que la librería busque con el id
   correcto), en el `externalId` de `processWaMessage` (el dedup por
   external_id vuelve a funcionar para los `message_create` duplicados),
   en el `messageId` de `sendWhatsAppMessage` y en los logs de descarga.
2. **Id canónico del chat desde el tráfico en vivo:** cada mensaje que
   se procesa guarda su peerId como setting `wa_chatid_<dígitos>`
   (mismo patrón que `wa_lid_`). En `sendWhatsAppMessage` el orden de
   chatIds pasa a ser: [id canónico guardado, `<lid>@lid` si hay mapeo,
   `<dígitos>@c.us`]. Antes de enviar, se resuelve el chat con
   `client.getChatById(chatId)` y se registra en el log si se encontró y
   con qué id canónico; el envío se intenta igual. El fallback sigue
   siendo solo ante el error del getter y ante undefined. Si ningún id
   funciona, el error final lista todos los ids probados.
3. **Dedup de reintentos fallidos:** en `POST /api/chats/:id/messages`,
   cuando el envío FALLA, si en los últimos 5 minutos ya se guardó un
   mensaje idéntico sin enviar en esa conversación (mismo sender
   'agent', type, content, adjunto, external_id NULL), no se inserta
   otra copia. El caso de éxito no cambia.
4. **Diagnóstico de arranque:** al arrancar, una línea de log con el
   `PERSIST_DIR` efectivo, el `waDataDir()`, el `uploadsDir()` y cuántas
   carpetas `session-wa-session-*` hay en el volumen (solo el conteo).
   Sirve para probar si la sesión sobrevive al despliegue.

**Plan de pruebas tras desplegar (en este orden):**

1. Enviar un **TEXTO** desde el CRM y verificar que llega al celular
   (mirar en el log qué chatId se usó y si el chat se encontró por
   `getChatById`).
2. Enviar una **FOTO** desde el CRM.
3. Mandar una foto y una nota de voz **AL** número y verificar que
   aparecen con vista previa/reproductor, no solo la etiqueta.
4. Mandar dos "hola" seguidos desde el teléfono y verificar que NO se
   duplican.
5. Tras el próximo despliegue, verificar en el log la línea de arranque
   con `PERSIST_DIR` y si la sesión se restauró sin QR.

## Multimedia de WhatsApp para contactos con dirección LID (v5.3.9, 2026-11-07)

**Los dos errores (log real de producción, v5.3.8, 23:54-23:55 UTC):** el
texto ya funciona en ambos sentidos (entran textos del contacto LID
`265076942618676@lid` resueltos al número `573116040943` y los enviados
desde el teléfono aparecen en el CRM vía `message_create`), pero la
multimedia falla en ambos sentidos:

1. **Saliente (23:54:46):** al enviar una foto desde el CRM, el envío
   revienta con `Error enviando mensaje via WA Data passed to getter must
   include an id property (it's how we memoize) but got undefined`
   (https://static.whatsapp.net/...). El mensaje quedó guardado en el CRM
   pero NO se envió (banner rojo "Guardado, pero WhatsApp no lo envió").
2. **Entrante (23:55:27 video, 23:55:36 ptt, 23:55:42 image):** los tres
   terminan en `no se pudo descargar la media del mensaje : r` — el id
   del mensaje sale vacío y el error es una sola letra, así que el log no
   permitía diagnosticar nada. Además `processWaMessage` descartaba el
   mensaje por completo, así que en el CRM no aparecía ni siquiera que
   llegó una foto/video/audio.

**Hipótesis (verificada en la librería whatsapp-web.js 1.34.7):** el chat
de este contacto vive en WhatsApp Web bajo su LID (`265076942618676@lid`)
y nuestro código siempre lo abordaba por el número (`573116040943@c.us`).
El `getChat` por `@c.us` no encuentra el chat real y el envío revienta
dentro de los getters internos de WhatsApp. La librería SÍ soporta chats
`@lid`: su `sendMessage` inyectado usa el usuario LID como remitente
cuando `chat.id.isLid()`. No está 100% probado que el texto saliente
también falle (solo se confirmó texto entrante y enviados desde el
teléfono): la prueba 1 de abajo lo distingue.

**La corrección (solo `server.js`):**

1. **Mapeo LID→número persistido:** cada vez que `resolveWaPeerPhone`
   resuelve un `@lid` a un número, el mapeo se guarda en settings
   (`wa_lid_<dígitos>` = `<lid>@lid`) y en memoria (también en mensajes
   de solo texto). La escritura es best-effort y nunca rompe el flujo de
   mensajes.
2. **Envío por LID con fallback (texto Y media):** `sendWhatsAppMessage`
   busca el LID guardado para esos dígitos; si existe, envía primero al
   `<lid>@lid` y, si falla con el error del getter (o el chat no existe),
   reintenta UNA vez con el `@c.us`, y viceversa. Un error distinto es
   final. Si la librería devuelve `undefined` (chat no encontrado), ahora
   se devuelve `ok:false` con un error claro, en vez de `ok:true` con
   `messageId` null (antes un chat inexistente se reportaba como enviado).
3. **Descarga entrante robusta:** `downloadWaMedia` registra el error
   COMPLETO (mensaje + stack + `JSON.stringify(msg.id)` + type + from),
   reintenta la descarga UNA vez tras 5 s (la librería devuelve
   `undefined` sin lanzar cuando la media aún está en FETCHING) y, si
   aun así falla, **ya no descarta el mensaje**: se guarda con su type y
   la etiqueta (📷 Imagen / 🎤 Nota de voz / 🎬 Video / 📎 Documento) y
   `attachmentUrl` null, para que la conversación muestre al menos que
   llegó algo. El tope de 25 MB y el descarte con constancia para archivos
   demasiado grandes se mantienen.

**Plan de pruebas tras desplegar (en este orden):**

1. Enviar un **TEXTO** desde el CRM a este contacto y verificar que llega
   al celular (distingue si el problema era solo media o todo lo
   saliente).
2. Enviar una **FOTO** desde el CRM y verificar que llega al celular.
3. Mandar una foto/audio/video **AL** número y verificar que aparece en
   Mensajes con vista previa.
4. Responder desde el celular con una foto y verificar que aparece en el
   CRM.

Si la prueba 1 falla también, el problema saliente no es la media sino
el chatId, y el log dirá qué chatId se usó en cada intento.

## Reintento automático cuando el arranque de WhatsApp falla por un error transitorio (v5.3.8, 2026-11-07)

Sistema de gestión integral para servicios de limpieza (Bogotá): Dashboard,
leads y pipeline de ventas, negocios, servicios, clientes, bandeja
de entrada de chat, equipo, auditoría,
inteligencia de clientes y **WhatsApp por QR
multi-instancia**.

> **Versión 4.** Toma como base `crm6-main` (la versión del 29 jul 2026, mucho
> más completa que `crm-main` del 24 ene 2026) y le aplica seguridad,
> instalación fácil, marca blanca y monitoreo (v3/v3.1), y ahora una
> auditoría archivo por archivo con limpieza de código muerto, sin quitar
> funcionalidad que se use.
>
> La versión PHP que existe aparte (`crm-php/`) es la versión **lite del CRM
> antiguo simplificado** (con Meta Cloud API), no corresponde a crm6: no trae
> leads, pipeline, auditoría ni WhatsApp por QR. Si necesitas la PHP de crm6,
> es un trabajo aparte.
>
> Se eliminó `migrated_prompt_history/` (40 MB de historial de prompts, no es
> código; nada lo importaba).
>
> **Versión 3.1 — Monitoreo y alertas.** Los errores ya no viven solo en los
> logs: quedan en la tabla `system_events`, se ven en la página **Estado del
> Sistema** (solo admin), el vigilante revisa DB y WhatsApp cada 5 min y
> avisa por **Telegram** cuando algo se rompe o se recupera, y hay respaldo
> diario automático a las 02:00. Ver "¿Cómo sé si algo se rompió?" más abajo.

## Reintento automático cuando el arranque de WhatsApp falla por un error transitorio (v5.3.8, 2026-11-07)

**El bug exacto (log real de producción, v5.3.7, 23:47:55 UTC):** tras el
redespliegue con el volumen remontado, la migración funcionó (se limpiaron
3 SingletonLock obsoletos y la sesión vieja se encontró), pero el arranque
falló con:

```
Error inicializando cliente alejo ochoa: ProtocolError: Protocol error
(Runtime.callFunctionOn): Execution context was destroyed.
    at Client.inject (whatsapp-web.js/src/Client.js:146)
    at async Client.initialize (whatsapp-web.js/src/Client.js:493:9)
```

Es **transitorio**: la página de WhatsApp Web navegó/recargó mientras la
librería inyectaba su JS y el contexto de ejecución murió. Pero el código
solo reintentaba si el error era de perfil bloqueado
(`/profile appears to be in use/i`); para **cualquier otro error** ponía
la instancia en `'error'` y **cancelaba el vigilante** (`clearWaWatchdog`),
así que nada reintentó jamás — el log no muestra ningún reintento entre el
error (23:47:55) y el Reconectar manual (23:52:27). Además el vigilante
solo actuaba sobre `'authenticated'` o `'initializing'`, nunca sobre
`'error'`, así que aunque no se hubiera cancelado, tampoco habría actuado.

**La corrección (solo `server.js`):**

1. **Reintento transitorio en el arranque:** si el error del
   `client.initialize()` coincide con
   `/Execution context was destroyed|Target closed|Session closed|Protocol error|Failed to launch|Navigation failed|net::ERR|Timeout/i`,
   se reintenta **hasta 5 veces con espera creciente (10 s, 30 s, 60 s,
   120 s, 120 s)** — en v5.3.8 eran 3; la v5.3.14 los subió a 5 porque
   el log de v5.3.13 probó que un arranque necesitó 8 intentos —,
   recreando el cliente con `stopWaInstance` + `initWhatsApp`. Los archivos
   de sesión en disco no se tocan en un inject fallido, así que el reintento
   restaura la sesión **sin pedir QR nuevo**. Cada intento queda en el log
   ("reintento 1/5 de arranque de WhatsApp..."). Mientras quedan reintentos,
   el estado sigue en `'initializing'` y el vigilante NO se cancela.
2. **El reintento de perfil bloqueado no cambia:** sigue como estaba
   (funciona: el log mostró los 3 locks limpiados).
3. **El vigilante ahora también actúa sobre `'error'`:** tras agotar los 5
   reintentos, la instancia pasa a `'error'` pero el vigilante ya NO se
   cancela, así que a los 120 s dispara su único reintento automático por
   arranque (guard `waReadyAutoRetried`). Un fallo de arranque ya no es un
   callejón sin salida. Sin bucles infinitos: 5 reintentos transitorios por
   cadena + 1 reintento del vigilante por arranque.
4. **Los errores NO transitorios** (p. ej. fallos de autenticación) mantienen
   el comportamiento de siempre: `'error'` + evento en `system_events`, sin
   reintento, y el vigilante se cancela como antes.

**El endpoint de Reconectar no se tocó** (está bien: `stopWaInstance` +
`initWhatsApp` con el mismo id/canal). Tras el Reconectar manual del log
apareció un QR nuevo en vez de reutilizar la sesión guardada; el motivo no
está en el log y no se investigó aquí — con el reintento automático, ese
camino manual debería dejar de ser necesario.

### Qué comprobar tras desplegar

1. Que el servicio arranque y `/api/health` diga versión **5.3.8**.
2. Si la página de WhatsApp Web recarga durante el arranque, el log debe
   mostrar "reintento 1/5 de arranque de WhatsApp..." y la instancia debe
   volver a `ready` **sin QR nuevo** y sin tocar Reconectar.
3. Si los 5 reintentos se agotan, la instancia queda en `'error'` y el
   vigilante intenta una re-inicialización más a los 120 s (queda en el log
   y en Estado del Sistema).
4. En VPS/docker-compose: sin cambios (sin `PERSIST_DIR` todo igual que en
   la v5.3.7).

## Un solo volumen en Railway: sesión de WhatsApp + archivos (v5.3.7, 2026-11-07)

**Por qué existe esta versión:** Railway permite **un solo volumen por
servicio** (documentación oficial: "Each service can only have a single
volume"). El servicio ya tenía su volumen para la sesión de WhatsApp
(`crmpurifica-volume` en `/app/.wwebjs_auth`) y NO se le puede añadir un
segundo volumen para `/app/uploads`. La v5.3.6 pedía ese segundo volumen;
esta versión lo hace innecesario: sesión y archivos viven en el **mismo**
volumen.

**Cómo funciona:** nueva variable `PERSIST_DIR` (en Railway: `/app/data`).
Con ella definida, la sesión de WhatsApp se guarda en `PERSIST_DIR` tal
cual y los archivos (logo, multimedia) en `PERSIST_DIR/uploads`. Sin ella,
todo sigue exactamente igual que antes (sesión en `./.wwebjs_auth`,
archivos en `<app>/uploads`): en VPS con docker-compose **no cambia nada**,
sigue con sus dos volúmenes.

### Pasos exactos en Railway (para el volumen que YA existe)

1. En el proyecto → servicio **crmpurifica** → **Settings → Volumes**.
2. Edita el volumen EXISTENTE (`crmpurifica-volume`): cambia el punto de
   montaje de `/app/.wwebjs_auth` a **`/app/data`**. No lo borres ni crees
   uno nuevo.
3. En **Variables** del servicio añade `PERSIST_DIR=/app/data`.
4. Redespliega (o haz push de esta versión: Railway despliega solo).

**La sesión NO se pierde:** es el mismo volumen con los mismos archivos.
Al remontarlo en `/app/data`, los archivos de sesión quedan en la raíz
del volumen (`/app/data/session-wa-session-<id>/`), que es justo donde
el servidor los busca ahora. No hay que reescanear el QR: tras el
redespliegue la instancia se restaura sola como en la v5.3.2.

**Advertencia de tamaño:** en Trial el volumen es de **0.5 GB en total**
entre sesión y multimedia. La sesión pesa poco, pero cada foto/video puede
pesar hasta 25 MB: con unas 20 fotos se llena. Vigila el uso en Railway
→ servicio → Metrics/volumen. En Hobby el volumen pasa a 5 GB.

### Qué comprobar tras desplegar

1. Que el servicio arranque y `/api/health` diga versión **5.3.7**.
2. Que WhatsApp siga en `ready` **sin escanear QR nuevo**.
3. Que una foto enviada al número aparezca en Mensajes y que tras un
   redespliegue siga ahí (volumen compartido funcionando).
4. En VPS/docker-compose: sin `PERSIST_DIR` todo igual que en la v5.3.6.

## WhatsApp: multimedia y enviados desde el celular v5.3.6 (2026-11-07)

Con los mensajes de texto ya llegando (v5.3.5), faltaban dos cosas que el
usuario pidió al probar en producción: que lleguen y se puedan enviar
fotos, audios, videos y documentos, y que lo respondido desde el celular
de la empresa aparezca en el CRM.

### 1. Multimedia entrante y saliente (QR)

- **Entrante:** `client.on('message')` acepta además de texto (`chat`):
  `image`, `audio`, `ptt` (nota de voz, se guarda como `audio`), `video`,
  `document` y `sticker`. La media se descarga con `downloadMedia()` y se
  guarda en `uploads/wa-media/` (tope 25 MB por archivo; si es mayor, se
  registra en el log y se descarta sin tumbar nada). El mensaje queda con
  su `type`, `attachment_url=/uploads/wa-media/...` y el caption como
  contenido (o '📷 Imagen' / '🎤 Nota de voz' / '🎬 Video' /
  '📎 Documento' / '😀 Sticker' si no trae). La resolución LID de la v5.3.5
  aplica igual a la media. Se siguen ignorando grupos, estados, mensajes
  de sistema (`e2e_notification`, `notification_template`) y `@bot`.
- **Saliente desde el CRM:** el composer de `ChatInbox.tsx` tiene botón de
  adjuntar (clip) con vista previa. El archivo se sube primero a
  `POST /api/chats/:id/attachments` (multer, tope 25 MB) y luego se envía
  el mensaje con su `attachmentUrl`. Por QR se envía con `MessageMedia`
  (con caption si lo hay); por Meta se envía por enlace público
  (`PUBLIC_BASE_URL` en .env o el dominio de Railway) y si no hay URL
  pública devuelve el error claro "multimedia por Meta no soportado
  todavía" sin romper el guardado. El contrato de respuesta no cambia
  (`success`, `sent`, `error`) y sigue el aviso "guardado pero no
  enviado" si falla el envío.
- **Inbox:** `ChatInbox.tsx` ya recibía `type`/`attachmentUrl` del backend
  pero solo pintaba imagen o audio. Ahora pinta imagen/sticker con `<img>`,
  audio con controles, video con `<video>` y documento con enlace de
  descarga, y muestra el caption debajo de la media cuando lo hay.

### 2. Enviados desde el celular (message_create)

- Nuevo handler `client.on('message_create')`: guarda los mensajes que se
  envían DESDE el teléfono vinculado. Solo procesa los propios (`fromMe`),
  ignora grupos/estados/notificaciones, el interlocutor es `msg.to` (con
  la misma resolución LID) y la media se descarga igual que la entrante.
- Se guardan como `sender='agent'` (así el inbox los pinta como propios),
  **sin** sumar `unread_count`, y SÍ actualizan `last_message` /
  `last_message_time`.
- **Sin duplicados:** `sendWhatsAppMessage` ahora devuelve el id del
  mensaje enviado (QR: `sent.id._serialized`; Meta: el id de la API) y
  `POST /api/chats/:id/messages` lo guarda como `external_id` (se envía
  ANTES de guardar, justo por eso). `message_create` dispara también por
  los enviados desde el CRM, pero el INSERT con
  `ON CONFLICT (external_id) DO NOTHING` los ignora.

### Límites honestos

- Tope de 25 MB por archivo (entrante y saliente). WhatsApp acepta menos
  en foto/video/audio (~16 MB), así que un envío muy grande puede fallar
  en WhatsApp aunque el CRM lo guarde (queda en `sent=false`).
- **Sin historial de media vieja:** solo entra lo que llegue desde ahora;
  los mensajes anteriores al despliegue no se recuperan (igual que el
  texto, ver v5.3.5).
- Media entrante por Meta (webhook) sigue sin guardarse: el webhook solo
  procesa texto. Media saliente por Meta necesita URL pública del
  servidor (ver arriba).
- **Volumen en Railway: SUPERADO por la v5.3.7.** Esta versión pedía un
  segundo volumen en `/app/uploads`, pero Railway solo permite **un
  volumen por servicio**, así que ese segundo volumen no se puede crear.
  La v5.3.7 lo resuelve con `PERSIST_DIR` (ver la sección de arriba): un
  solo volumen compartido para sesión y archivos. Si ya creaste el volumen
  `/app/uploads`, no pasa nada: simplemente no se usa; el que vale es el
  volumen remontado en `/app/data`. En VPS con docker-compose el volumen
  `uploads` ya viene en `docker-compose.yml`.

### Qué comprobar tras desplegar

1. Que una foto/audio/video/documento enviado al número de la empresa
   aparezca en **Mensajes** con su vista previa y se pueda abrir/descargar.
2. Que adjuntar un archivo desde el composer lo envíe por WhatsApp y
   aparezca en el chat.
3. Que responder desde el celular de la empresa haga aparecer ese mensaje
   en el CRM como propio, sin duplicar los enviados desde el CRM.
4. Que tras un redespliegue los archivos de media sigan ahí (volumen
   compartido con `PERSIST_DIR`, ver v5.3.7; ya NO hace falta un segundo
   volumen en `/app/uploads`).

## WhatsApp QR: bloqueo de perfil de Chrome + remitentes LID v5.3.4 (2026-11-07)

Dos problemas diagnosticados con el **log real de Railway** (deploy v5.3.3),
no con suposiciones:

### 1. Causa raíz del "Code: 21": bloqueo de perfil de Chrome, no la versión de puppeteer

El stderr de Chrome en el log dice, literal:

> "The profile appears to be in use by another Chromium process (54) on
> another computer (600f0cb2d288). Chromium has locked the profile so that
> it doesn't get corrupted."

Al reemplazar el contenedor, el Chrome viejo muere sin liberar el bloqueo
(`SingletonLock`) que queda en el volumen (`.wwebjs_auth`) y el Chrome nuevo
se niega a arrancar. Por eso la v5.3.2 falló al lanzar Chrome y por eso el
usuario lo "resolvió" borrando la instancia y creando una nueva (perfil
fresco, sin bloqueo). La v5.3.3 (puppeteer fijado + `--single-process`) no
era la causa ni la cura: solo cambió la versión del navegador.

Arreglo (v5.3.4, `server.js`, función `clearWaSessionLocks`):

- Antes de crear el `Client`, se borran los archivos de bloqueo
  (`SingletonLock`, `SingletonSocket`, `SingletonCookie`) del directorio
  de sesión LocalAuth de esa instancia
  (`.wwebjs_auth/session-wa-session-<id>/`). Es defensivo (try/catch, si
  no existe la carpeta no pasa nada) y registra en el log cuando elimina
  un bloqueo obsoleto.
- Si el arranque falla de todos modos con "profile appears to be in use",
  se limpian los bloqueos y se reintenta la inicialización **una sola
  vez**.
- Es seguro en este despliegue porque solo hay un contenedor a la vez: un
  bloqueo presente al arrancar es, por definición, de un Chrome muerto de
  un contenedor ya reemplazado (el propio Chrome lo delata diciendo "on
  another computer").

### 2. Los mensajes no llegaban aunque la instancia estaba en 'ready'

El log después del "está listo!" no tiene NI UNA línea "Mensaje recibido".
Dos causas:

- **Remitentes LID descartados en silencio.** El handler de `message`
  filtraba `@lid` antes de registrar nada. Cada vez más remitentes
  escriben con dirección LID (identidad vinculada de WhatsApp), así que
  sus mensajes se descartaban aunque la instancia estaba lista. Ahora el
  LID se resuelve con `msg.getContact()`: la librería sustituye el id por
  el número real cuando WhatsApp Web conoce la correspondencia
  (`getContactModel` en whatsapp-web.js); si no se puede resolver, el
  descarte queda registrado en el log. Grupos (`@g.us`) y estados
  (`@broadcast`) siguen ignorados.
- **Sin rastro de lo filtrado.** Ahora cada mensaje que entrega WhatsApp
  Web deja una línea de diagnóstico en el log ANTES de cualquier filtro
  (`from`, `type`, `hasMedia`, `fromMe`, sin el contenido). Un mensaje
  filtrado ya no es invisible.

### 3. Hallazgo secundario: el 'authenticated' x5

En el log, "WhatsApp alejo ochoa autenticado" apareció 5 veces en 4 ms
con UN SOLO cliente. No eran varios clientes ni varias llamadas a
`initWhatsApp`: es la librería (whatsapp-web.js 1.34.7, `Client.js`), que
emite `authenticated` en cada cambio de `hasSynced` del socket de
WhatsApp Web, y la sincronización inicial tras escanear el QR lo dispara
en ráfaga. El handler ahora solo actúa en la transición a
'authenticated' (antes dejaba 5 líneas de log y 5 filas en
`system_events` por cada QR). Además, `initWhatsApp` ahora registra un
aviso si se la llama cuando ya existe una instancia en memoria.

### Qué comprobar tras desplegar

1. Tras un redespliegue, que NO vuelva el Code 21: el log debe mostrar
   la restauración automática y "está listo!" sin borrar la instancia ni
   escanear QR nuevo.
2. Que un mensaje nuevo de texto (1 a 1) deje la línea "mensaje entrante"
   y luego "Mensaje recibido" en el log de Railway, y aparezca en
   **Mensajes**.
3. Si el remitente escribe con LID, que el log muestre "remitente LID …
   resuelto al número …".

## WhatsApp QR: corrección de la resolución LID v5.3.5 (2026-11-07)

El diagnóstico de la v5.3.4 funcionó: el log real de Railway (deploy
v5.3.4, 22:48–22:52 UTC) muestra que los mensajes SÍ llegan al evento
`message`. Tras el ready (22:51:52) llegaron varios `type=e2e_notification`
y `type=notification_template` desde @lid (mensajes de sistema, bien
ignorados) y un `type=rich_response` desde @bot (bien ignorado). Y llegó
UN mensaje real: 22:52:24, `from=265076942618676@lid type=chat hasMedia=false
fromMe=false`.

Ese mensaje real fue **descartado por la resolución LID de la v5.3.4**. La
línea del log dice, literal:

> "no se pudo resolver el número del remitente LID 265076942618676@lid
> (contacto: 573116040943@c.us); mensaje descartado."

El contacto YA traía el número real en su id (`573116040943@c.us`), pero
el código leía la variable equivocada: `contact.number` (que en contactos
LID trae el propio LID o vacío) en vez de `contact.id._serialized`. La
validación (7–15 dígitos, distinto de los dígitos del LID) falló por leer
el campo equivocado, no porque el número no se pudiera resolver. **Sí hay
una variable mal en el código, y era esta.**

Corrección (v5.3.5, `server.js`, handler `client.on('message')`):

- El número resuelto se saca PRIMERO de `contact.id._serialized` (si
  termina en `@c.us`, sus dígitos son el número real que WhatsApp Web ya
  resolvió) y solo como respaldo de `contact.number`.
- Se acepta el primer candidato con 7–15 dígitos y distinto de los
  dígitos del LID. El resto del flujo no cambia (`handleIncomingWhatsApp`
  con dedup por `external_id`, `senderName` del pushname).
- En el log de descarte ahora quedan registrados AMBOS valores
  (`id` serializado y `number`) para que un próximo fallo no sea a ciegas.
- No se tocó nada más de WhatsApp (diagnóstico de entrada, limpieza de
  bloqueos SingletonLock, vigilante de ready, auto-restauración, envío,
  canal Meta: todo intacto). No se añadió sincronización de historial en
  esta versión.

> **El mensaje de prueba descartado no se puede recuperar**: su contenido
> no quedó en el log (el diagnóstico de entrada no registra contenido) y
> WhatsApp Web no re-entrega mensajes pasados. Hay que reenviarlo tras
> desplegar la v5.3.5.

### Qué comprobar tras desplegar

1. Que un mensaje nuevo de texto (1 a 1) deje "mensaje entrante" y luego
   "remitente LID … resuelto al número …" y "Mensaje recibido" en el log
   de Railway, y aparezca en **Mensajes**.
2. Que tras un redespliegue no vuelva el Code 21 (la limpieza de
   SingletonLock de la v5.3.4 sigue activa).

## WhatsApp QR: arreglo del fallo de Chrome v5.3.3 (2026-11-07)

**Qué falló en v5.3.2 al desplegar en Railway (deploy fba06620):** la
auto-restauración SÍ funcionó (el log mostró "Restaurando instancia de
WhatsApp: hola" e "Inicializando WhatsApp para: hola"), pero justo después
salió `[ERROR] Error inicializando cliente hola Error: Failed to launch
the browser process: Code: 21` con stack en `@puppeteer/browsers`. En
v5.3.1 el Chrome sí arrancaba (se generaba el QR y se autenticaba). La
línea de error venía cortada en la captura, sin el stderr completo de
Chrome, así que no se pudo saber si era una librería compartida que
faltaba o un fallo al crear procesos.

**Qué se revirtió y por qué (vuelta exacta a la configuración de
lanzamiento de v5.3.1):**

1. **`--single-process` vuelve** a los args de puppeteer en `initWhatsApp`
   (`server.js`). En v5.3.2 se quitó pensando que colgaba la página tras
   autenticar, pero la evidencia de producción dice lo contrario: con el
   flag, v5.3.1 lanzaba Chrome bien; sin él, v5.3.2 no pudo ni arrancar
   el navegador. La causa del "nunca llega a ready" de v5.3.1 queda por
   tanto sin confirmar y se revisará aparte si reaparece con Chrome
   arrancando.
2. **Puppeteer fijado en la 24.37.5**, la versión exacta que lanzaba bien
   en v5.3.1: dependencia directa exacta en `package.json` y `overrides`
   (`"puppeteer": "24.37.5"`) para que `whatsapp-web.js` 1.34.7 use esa
   misma copia. OJO: la dependencia directa sola NO bastaba —
   `whatsapp-web.js` 1.34.7 fija `puppeteer` en `24.38.0` exacto en su
   propio `package.json`, así que sin el override npm instalaba una copia
   anidada 24.38.0 y el navegador que se lanzaba seguía siendo el nuevo.
   Verificado con `npm ls puppeteer`: una sola copia 24.37.5
   ("overridden" + "deduped" bajo whatsapp-web.js, sin copia anidada).
3. **Dockerfile:** se añadieron las librerías de la lista estándar de
   puppeteer para Debian 12 que faltaban: `libatk-bridge2.0-0`,
   `libdrm2` y `libxkbcommon0`. El resto de la lista ya estaba.

**Qué se conserva de v5.3.2 (sin tocar):** `whatsapp-web.js` 1.34.7, la
auto-restauración de instancias al arrancar (`restoreWhatsAppInstances`),
el vigilante de `ready` a 120 s con un reintento (`armReadyWatchdog`) y
la parada centralizada (`stopWaInstance`).

**Mejora de diagnóstico:** cuando `client.initialize()` falla, el log
ahora muestra el mensaje de error COMPLETO (mensaje + stack + stderr de
Chrome) en vez del objeto de error cortado, para que el próximo fallo se
pueda diagnosticar sin adivinar.

**Qué hacer tras desplegar esta versión en Railway:** nada especial. Al
arrancar, la instancia "pedro" (ID HOLA) se levanta sola con la sesión
guardada en el volumen `crmpurifica-volume` y debe llegar a `ready` sin
pedir QR nuevo. Comprueba en el log que salga "WhatsApp pedro está
listo!" y en Estado del Sistema que WhatsApp por QR pase a Bien (1 de 1).
Si vuelve a fallar el lanzamiento, el log ahora mostrará el error
completo de Chrome.

## WhatsApp QR: arreglos v5.3.2 (2026-11-07)

**El problema en producción (Railway, v5.3.1):** la instancia QR se
autenticaba por QR (el celular decía vinculado, el log decía "WhatsApp
pedro autenticado") pero **nunca llegaba a `ready`**: el log nunca mostró
"WhatsApp pedro está listo!", Estado del Sistema decía WhatsApp por QR:
Roto (0 de 1), y no llegaba ningún mensaje. Reconectar re-inicializaba y
autenticaba en ~1 s sin pedir QR nuevo (la sesión del volumen servía),
pero tampoco llegaba a ready. No había errores en el log: se quedaba
colgado. Además el evento `authenticated` se registró DOS veces en el log
al mismo segundo, señal de doble inicialización.

**Qué se corrigió (todo en `server.js`, salvo la versión de la librería):**

1. **Librería actualizada:** `whatsapp-web.js` 1.34.6 → **1.34.7** (última
   estable; la 2.0.0 es solo alpha). `qrcode` ya estaba en la última
   (1.5.4). El cambio 1.34.6→1.34.7 es pequeño (correcciones de
   `markSeen`/`sendSeen`, llamadas y Channels para los cambios recientes
   de WhatsApp Web); el peso del arreglo está en los puntos siguientes.
2. **`--single-process` eliminado** de los args de puppeteer en
   `initWhatsApp`. En Docker ese flag hacía que la página de WhatsApp Web
   se quedara colgada tras autenticar: el cliente nunca emitía `ready`.
3. **Las instancias se restauran solas al arrancar.** Antes `initWhatsApp`
   estaba comentado en el arranque y tras cada redespliegue había que
   darle a Reconectar a mano. Ahora, al terminar `initDB`, se leen las
   instancias guardadas en `settings` (`wa_channel_<id>` y `wa_name_<id>`)
   y se levanta cada una (QR con la sesión del volumen, sin QR nuevo;
   Meta como entrada virtual). Si la DB no está, no se restaura nada y el
   arranque sigue igual. Un fallo restaurando una instancia se registra y
   no rompe el arranque.
4. **Vigilante de `ready` (120 s).** Si una instancia QR lleva más de 120 s
   en `authenticated` o `initializing` sin llegar a `ready`, queda un
   warning claro en el log y en `system_events` ("autenticado pero sin
   quedar listo...") e intenta **una sola** re-inicialización automática
   por instancia y arranque (con guarda anti-bucle: después del reintento
   solo deja el estado visible para reconectar a mano).
5. **Doble inicialización corregida.** La parada de una instancia ahora es
   centralizada (`stopWaInstance`: limpia el vigilante, destruye el
   cliente con tope de 10 s para que un `destroy()` colgado no deje un
   Chrome zombi, borra la entrada) y la usan Reconectar, cambio de canal
   y borrado. En el borrado, si `logout()` fallaba, `destroy()` nunca se
   llamaba y el Chrome quedaba vivo: ahora el logout se intenta y la
   parada siempre ocurre. Además cada handler de eventos (`qr`, `ready`,
   `authenticated`, `auth_failure`, `disconnected`, `message`) ignora
   eventos de un cliente que ya no es el vigente para ese id, así un
   cliente viejo no puede pisar el estado de la instancia nueva.
6. **Nombre de instancia persistido** (`wa_name_<id>` en settings) para que
   la restauración al arrancar muestre el mismo nombre y no solo el id.

**Sin cambios en el canal Meta:** sigue intacto (entrada virtual, webhook
con firma HMAC, envío por Graph API v19.0). La recepción por QR sigue
igual: solo texto de chats 1 a 1 (se ignoran grupos `@g.us`, estados
`@broadcast`, LID `@lid` y mensajes no-texto). El envío desde el inbox
sigue exigiendo una instancia en `ready` y devuelve `sent: false` con el
error visible si no hay ninguna lista.

**Qué hacer tras desplegar esta versión en Railway:** nada especial. Al
arrancar, la instancia "pedro" (ID HOLA) se levanta sola con la sesión
guardada en el volumen `crmpurifica-volume` y debe llegar a `ready` sin
pedir QR nuevo. Comprueba en el log que salga "WhatsApp pedro está
listo!" y en Estado del Sistema que WhatsApp por QR pase a Bien (1 de 1).
Si el vigilante actúa, verás en el log "autenticado pero sin quedar listo
después de 120 s". Si aun así no llega a listo, la alternativa que no
depende del navegador es el canal Meta (ver "WhatsApp Meta Cloud API").

## Limpieza v5 — Parte 1 (quitar lo que sobra)

La v5 Parte 1 quita módulos enteros que sobraban o dañaban, sin cambiar el
comportamiento de lo que queda. **No es la Parte 2** (facturación DIAN,
Meta Cloud API, normalización de teléfonos, totales reales y permisos finos
siguen pendientes y no se tocaron).

**Eliminado:**
- `TechDocs` entero (`components/TechDocs.tsx`, vista `tech-docs`, menú
  "Integración & API"): su botón "Simular Mensaje Entrante" creaba datos
  reales en producción (conversación, lead y teléfono falso `123456789`) y
  "25 PROTEGIDOS" era un literal estático, no medido.
- Chat interno entero (`components/InternalChat.tsx`, vista
  `internal-chat`, menú, botón flotante y campana de pendientes):
  endpoints `GET/POST /api/internal-messages*`,
  `POST /api/internal-messages/read`,
  `GET /api/internal-unread-counts/:userId` y la tabla `internal_messages`
  (ya no se crea en `initDB`). El inbox de WhatsApp (`ChatInbox.tsx`) no
  se tocó.
- Bot + Chatwoot enteros (`components/BotManagement.tsx`, vista `bot`,
  menú "Automatización"): endpoints `GET/POST/PUT/DELETE
  /api/bot-messages*`, tabla `bot_messages` (ya no se crea en `initDB`),
  `is_bot_enabled` (fuera de la allow-list de `POST /api/settings` y del
  seed inicial), webhook público `POST /api/webhooks/chatwoot` (también
  fuera de `PUBLIC_API`), función `sendToChatwoot` y sus 3 llamadas
  (respaldo al recibir por QR, al enviar desde el inbox y auto-respuesta
  del bot), y `CHATWOOT_*` de `.env.example`. **No se implementó
  auto-reply nuevo: el bot deja de existir.** El envío desde el inbox
  ahora sale solo por la instancia de WhatsApp por QR.
- Analítica duplicada (`components/FrictionAnalytics.tsx`, vista
  `friction`, menú "Novedades" y su cableado en `App.tsx`). Se conservan
  `BusinessDeals`, `Dashboard`, `LeadPipeline`, `ClientsList`,
  `AuditModule`, `CapacityWidget` y `ClientIntelligence`.

**Socket:** se conserva solo para notificaciones de actualización
(`notifyUpdate` → evento `data_update`): salas por usuario y
`global_admin` con identidad del JWT. No había salas propias del chat
interno además de esas; el chat interno usaba HTTP, no salas de socket.

**Verificación hecha en esta máquina (v5 Parte 1, 2026-11-07):**
- `npm ci` → exit 0; `npm run typecheck` → exit 0; `npm run build` → ✓
  en 14.80 s, 2046 módulos (v4: 2847), chunk 882 kB.
- Arranque sin `DATABASE_URL` (puerto 3146): `GET /` → 200,
  `GET /api/health` → 200
  `{"ok":true,"version":"4.0","db":false,"whatsapp":{"instances":0,"connected":0}}`,
  `GET /api/services` sin token → 401.
- Rutas eliminadas verificadas: con token JWT válido,
  `GET /api/bot-messages`, `POST /api/webhooks/chatwoot`,
  `GET /api/internal-messages/1/2` y `POST /api/settings` con
  `is_bot_enabled` devuelven lo mismo que una ruta que nunca existió
  (`/api/noexiste123`): 503 "Base de datos no configurada", porque el
  middleware de guarda de DB corre antes del enrutado. Sin DB no se puede
  distinguir 404 de ruta viva por HTTP; la prueba de código es el grep:
  cero ocurrencias de esas rutas en `server.js`.
- `node_modules/` y `dist/` se dejaron intactos para el agente de la Parte 2.

**Documentación de integración que se preserva (referencia histórica, no
funcional):** antes de la v5, Chatwoot se conectaba con el webhook
`{origen}/api/webhooks/chatwoot` (Ajustes de cuenta → Webhooks en
Chatwoot, marcando exclusivamente el evento `message_created`; otros
eventos se ignoraban) y el token de envío `CHATWOOT_TOKEN` era el
"Access Token" del perfil de Chatwoot (Ajustes de Perfil, al final de la
página). Si algún día se quiere volver a integrar un chat externo, ese
era el contrato. No hay documentación de n8n en el proyecto (solo se
mencionaba en `metadata.json`).

## Facturación y cobros v5 — Parte 2A (Colombia)

**Versión 5.0.0.** Facturación interna de cobro y links de pago. Lo que NO es:
esto **no es facturación electrónica DIAN**. El CRM no envía nada a la DIAN,
no genera CUFE ni tiene resolución validada por la DIAN. Lo que sí hay es
todo lo necesario para alimentar a un proveedor certificado (Siigo, Alegra
u otro) y para cobrar por Wompi/PayU o en efectivo.

**Tablas nuevas (en `initDB`):**
- `invoices` (id, number único `FAC-0001`, service_id, client_name,
  client_phone, client_nit, subtotal, advances, total, balance, status
  `pendiente/parcial/pagado/anulado`, payment_method, payment_link).
  El consecutivo sale de `settings.invoice_next_number` (empieza en 1) y se
  reserva dentro de una transacción con bloqueo de fila para no repetir número.
- `payments` (id, invoice_id, amount, method, reference): cada pago manual
  o de webhook queda registrado; el saldo se recalcula con ellos.

**Flujo:** en `ServiceForm` hay input de **abonos** (se guarda en
`services.advances`, que ya existía) con el saldo `total − abonos` visible.
Al completar un servicio (REALIZADO/PAGADO) aparece **"Generar factura"**:
crea la invoice con subtotal = total del servicio, abonos del servicio,
saldo = total − abonos; estado `pagado` si el saldo es 0, `parcial` si hubo
abonos, `pendiente` si no. Si el servicio ya tiene factura, devuelve la
existente (no duplica). También se genera desde el botón de factura en
`ServiceList` (solo admin, servicios realizados/pagados).

**Endpoints (JWT; crear/anular/pagos/link solo admin; listar/ver cualquier
rol autenticado):**
- `GET /api/invoices` (filtro `?status=` y `?service_id=`), `GET /api/invoices/:id` (incluye `payments`).
- `POST /api/invoices {service_id, client_nit?}` → 201 (o la existente con `already_exists: true`).
- `POST /api/invoices/:id/payments {amount, method, reference}` → actualiza saldo y estado; el monto se limita al saldo (no deja saldo negativo).
- `POST /api/invoices/:id/cancel` → estado `anulado` + evento en `system_events`.
- `GET /api/invoices/:id/export` → JSON con empresa, factura, servicio y pagos, listo para un proveedor de facturación electrónica.

**Vista Facturación (solo admin, menú "Facturación"):** lista con filtro por
estado y búsqueda, registrar pago manual, ver/imprimir factura
(`InvoiceModal.tsx`, con `window.print` y estilos de impresión), generar y
copiar link de pago, anular, exportar JSON, y formulario de datos DIAN-ready
de la empresa (NIT, régimen, resolución: número, rango y fecha — se guardan
en `settings` y salen en la factura y en el export).

**Cobros — variables en `.env.example` (opcionales, vacías):**
`WOMPI_PUBLIC_KEY`, `WOMPI_PRIVATE_KEY`, `WOMPI_EVENTS_SECRET`,
`WOMPI_REDIRECT_URL`, `PAYU_MERCHANT_ID`, `PAYU_API_KEY`,
`PAYU_ACCOUNT_ID`, `PAYU_RESPONSE_URL`, `PAYU_CONFIRMATION_URL`.
- `POST /api/invoices/:id/payment-link {provider: 'wompi'|'payu'}`: cobra el
  **saldo** pendiente. Wompi → link de checkout
  `https://checkout.wompi.co/p/?public-key=…&currency=COP&amount-in-cents=…&reference=FAC-XXXX`
  (monto en centavos, referencia = número de factura). PayU → URL de WebCheckout
  Colombia `https://checkout.payulatam.com/ppp-web-gateway-payu/?…` con firma
  MD5 `apiKey~merchantId~referenceCode~amount~COP` (monto con 2 decimales).
  Sin llaves → **400 honesto "pasarela no configurada"**. El link se guarda
  en `invoice.payment_link`.
- `POST /api/webhooks/wompi` (público, verificado por firma): checksum SHA256
  de `transaction.id + transaction.status + transaction.amount_in_cents +
  secreto de eventos` (`WOMPI_EVENTS_SECRET`, o `WOMPI_PRIVATE_KEY` como
  respaldo). Si no hay secreto, el evento se registra en `system_events`
  pero **NO marca pagado**. Con firma válida y `status=APPROVED` marca la
  factura como pagada y registra el pago.
- `POST /api/webhooks/payu` (público, verificado por firma): firma MD5
  `apiKey~merchant_id~reference_sale~value~currency~state_pol` (value a 1
  decimal, según docs PayU). Sin `PAYU_API_KEY` no se puede verificar: se
  registra pero no marca pagado. Con firma válida y `state_pol=4` (aprobado)
  marca la factura como pagada y registra el pago.
- **Honestidad PayU:** la integración oficial de WebCheckout es un formulario
  POST; el link generado es el equivalente GET con los mismos parámetros
  firmados. Si PayU rechaza el GET, hay que servir el formulario POST con
  esos mismos campos (el servidor ya calcula la firma).

**Qué falta para facturar electrónicamente de verdad (DIAN):** un proveedor
certificado (Siigo, Alegra, etc.) con sus credenciales, una resolución DIAN
vigente (los campos ya existen en Ajustes de Facturación) y el envío del
export JSON a ese proveedor. Nada de eso está implementado ni fingido aquí.

## Factura normal o electrónica (v5.1)

**Versión 5.1.0.** Hay empresas que no se conectan a la DIAN y necesitan
facturar normal, así que ahora cada factura tiene un **tipo**:

- **Normal (sin DIAN) — por defecto.** Es la factura de venta corriente:
  se imprime como "Factura de venta", sin mención a la DIAN, sin CUFE y sin
  resolución. No tiene exportación DIAN (el botón de exportar sale
  deshabilitado y el endpoint responde 400 explicándolo). Es el tipo que
  reciben las facturas creadas en la v5.0, que no tenían tipo.
- **Electrónica (DIAN).** Se imprime como "Factura electrónica", con NIT,
  régimen y resolución de facturación, y sí tiene exportación JSON DIAN-ready
  para el proveedor certificado. Sigue sin enviarse nada a la DIAN desde el
  CRM: para facturar electrónicamente de verdad falta proveedor certificado,
  credenciales y resolución DIAN vigente.

**Cómo se elige el tipo:** al generar una factura (desde el formulario del
servicio o desde el botón de factura en Servicios) se pregunta el tipo con
su explicación; en Facturación se puede cambiar el **tipo por defecto**
(sección "Tipo de factura por defecto", guardado en
`settings.invoice_default_type`, Normal por defecto). En la lista de
Facturación hay filtro por tipo y columna Tipo con su etiqueta.

**Backend:** columna `invoices.type` (`'normal' | 'electronica'`, por defecto
`'normal'`), añadida con migración segura en `initDB` (`ALTER TABLE ...
ADD COLUMN IF NOT EXISTS`); `POST /api/invoices {service_id, type?}` valida
el tipo y si no viene usa el de por defecto; `GET /api/invoices?type=normal|electronica`
filtra por tipo; `GET /api/invoices/:id/export` devuelve 400 para facturas
normales. El consecutivo `FAC-XXXX` es **compartido** por los dos tipos: si
alguna empresa quiere consecutivos separados por tipo, es un cambio futuro
que hay que pedir explícito. Cobros (Wompi/PayU), pagos manuales, anulación
y saldos funcionan igual para los dos tipos.

## Qué se arregló en la v3 (respecto a crm6 tal cual)

| Problema de crm6 | Corrección en la v3 |
|---|---|
| Login con bcrypt pero API totalmente abierta (cualquiera podía llamar a `/api/*`) | JWT en toda `/api/*` (salvo login, health y branding público); el frontend envía el token en cada llamada y el socket también se autentica con JWT |
| El servidor se caía sin base de datos (el login hacía `pool.query` sin try/catch y la promesa rechazada tumbaba el proceso) | Guarda de DB (503 sin tumbarse), try/catch en login y webhook, y red de seguridad contra promesas sin catch; verificado: login sin DB da 503 y el proceso sigue vivo |
| Admin con clave débil creado automáticamente | El admin inicial solo se crea si defines `ADMIN_EMAIL` y `ADMIN_PASSWORD` en `.env`; si no, no se crea ninguno |
| CORS abierto a todo el mundo, sin helmet, JSON de 50 MB | CORS solo mismo origen (salvo `CORS_ORIGIN`), helmet, JSON de 10 MB |
| `/server.js`, `/.env` y `/package.json` devolvían el index.html del SPA (200) | Ahora dan 404; las rutas `/api` desconocidas dan 404 JSON en vez de HTML |
| Sin `/api/health` | `GET /api/health` → `{ok, db, whatsapp:{instances, connected}}`, sin romper sin DB |
| Sin `docker-compose`, sin instalador | Docker Compose (app + Postgres 16), `install.sh` / `install.bat`, `.env.example` completo |
| "Purifica" fijo en el código | Marca blanca: nombre, eslogan, logo y colores desde Ajustes → Personalización |

## Limpieza v4 (auditoría archivo por archivo)

La v4 hace lo mismo que la v3.1, solo más limpia. Se auditó cada archivo
(`server.js`, `App.tsx`, todos los `components/*.tsx`, `lib/`, `utils/`,
config, Dockerfile, compose e instaladores) verificando con grep y lectura
real quién usa cada cosa. Lo eliminado o corregido:

**Código 100% muerto (nadie lo usaba, con evidencia):**
- `components/InvoiceModal.tsx` entero: el recibo nunca se podía abrir
  (`showInvoice` jamás se ponía en `true` en todo el proyecto). Si se
  quiere el recibo, hay que volver a engancharlo desde `ServiceForm`.
- Endpoints sin llamador en el frontend: `POST /api/wa/send` y los 4 de
  `/api/tasks/*` (`GET/POST/PUT/DELETE`). La tabla `tasks` sigue existiendo:
  `GET /api/chats` la usa para `pendingTasksCount`.
- `importmap` de `index.html` (21 entradas esm.sh, muerto en el build de
  Vite y con versiones distintas a `package.json`). El estilo real es
  Tailwind CDN, que se conserva.
- `SOUNDS` en `utils/NotificationService.ts`: 3 MP3 en base64 que ningún
  `play*` usaba (los sonidos salen de un oscilador). También
  `isAudioUnlocked`, que solo se escribía.
- `ServiceStatus` en `types.ts` (enum sin uso), `.dockerignore.tsx`
  (archivo vacío suelto), entradas inexistentes en `.dockerignore`.
- ~70 imports sin uso en 17 archivos (iconos de lucide, `recharts` entero
  en `Dashboard`, `useMemo`/`Bell` en `App.tsx`, `useCallback` en
  `ClientsList`, `ServiceRecord` en `ChatInbox`/`Dashboard`, `StaffRole` en
  `TeamManagement`, etc.).
- Estado muerto en `BusinessDeals`: `viewMode` (siempre canvas),
  `minPrice`/`maxPrice` (inputs que nunca filtraban nada).
- Props muertas: `data` de `Dashboard`, `variant` de `ServiceForm`,
  `onSaveService` y `onMarkAsRead` (era `() => {}`) de `ChatInbox`.
- Dependencias: `tailwindcss`, `autoprefixer`, `postcss` (sin config en el
  proyecto; el estilo es Tailwind CDN). `terser` se conserva (lo usa
  `vite.config.ts`).

**Bugs corregidos (sin cambiar el comportamiento esperado, solo hacerlo real):**
- `runBackup` se llamaba a sí misma en vez de `resolve`: el respaldo
  manual/diario colgaba siempre (`POST /api/system/backup` sin respuesta).
- `GET /api/clients` buscaba `l.neighborhood`, columna que no existe en
  `leads`: cualquier búsqueda rompía con 500.
- `DELETE /api/leads/:id` no existía: Auditoría pedía borrar un prospecto y
  fallaba con 404 en silencio. Ahora existe.
- `GET /api/services` y `GET /api/leads` no devolvían `observations`,
  `servicePerformed`, `additionalItems`, `expensesNote`, `advances`,
  `isWarranty`, `cancellationReason`, `rescheduleCount` ni `lostReason`:
  Fricción siempre decía "Sin motivo", Negocios siempre "Reagendado (1)",
  y al editar un servicio el formulario pisaba esos campos con valores por
  defecto. `POST /api/services` tampoco los guardaba; ahora sí.
- `payment=undefined` al entrar a Negocios: `BusinessDeals` no enviaba
  `payment` y el backend filtraba `payment_method='undefined'` (0
  servicios). Ahora Negocios envía `payment: 'all'` y `App.tsx` fusiona
  los filtros en vez de reemplazarlos, con `payment || 'all'` de respaldo.
- `sales_agent` con equipo vacío: `advisor IN ()` = error 500 de sintaxis
  en `dashboard-stats`, `leads` y `services`. Ahora no se genera el `IN`
  vacío.
- `POST /api/staff` creaba usuarios con la clave por defecto `'123456'` si
  no venía contraseña, y el upsert por email **reseteaba la clave** al
  editar. Ahora crear exige contraseña y editar sin contraseña no la toca.
- `DELETE /api/clients/:phone` sin `requireAdmin` y sin borrar la fila en
  `clients` ni sus notas/recordatorios. Ahora es solo-admin y borra todo.
- `POST /api/services/update-deal` pisaba `cancellation_reason` en
  cualquier cambio de estado (AGENDADO → CONFIRMADO borraba el motivo).
  Ahora solo se toca al CANCELAR.
- El socket confiaba en el `role` que enviaba el cliente en `identify`:
  cualquiera podía unirse a `global_admin` fingiendo ser admin. Ahora la
  identidad sale del JWT verificado en el handshake. CORS del socket
  alineado con el HTTP (`CORS_ORIGIN || false`).
- `POST /api/settings` aceptaba cualquier clave. Ahora solo
  `reassignment_timeout`, `daily_capacity`.
- `GET /api/health` devolvía `ok:true` con la DB caída. Ahora `ok` refleja
  la DB (sigue siendo 200 para los monitores externos).
- 9 rutas sin `try/catch` (Express 4: promesa rechazada = request colgado):
  `GET/PUT/DELETE /api/staff`, `POST /api/staff/status`,
  `POST /api/services`,
  `POST /api/reminders/:id/complete`, `DELETE /api/reminders/:id`.
- `flushEventBuffer` perdía los eventos que quedaban tras el primero que
  fallaba. `getSystemStatus` decía "email configurado" con solo tener las
  variables, aunque `nodemailer` no está instalado: ahora comprueba que el
  paquete exista.
- `DATABASE_URL` se construía en `docker-compose.yml` sin escapar la clave
  (una clave con `@`, `#` o `/` rompía la conexión). Ahora la construye
  `server.js` con `POSTGRES_*` y `encodeURIComponent`.
- Frontend: al montar se hacían 4 cargas a la vez (`fetchData('all')` + 3
  efectos de filtros); ahora los efectos esperan a la carga inicial.
  Parámetros de búsqueda/filtros sin codificar en las URLs de `App.tsx` y
  en la exportación de `ClientsList` (un barrio con espacios o `&` rompía
  la URL). La exportación además omitía `role`/`userName`: un asesor
  exportaba **todos** los clientes aunque su lista estuviera filtrada.
- `Dashboard`: `totalServices` llegaba como string sin `Number()`;
  `commission-tiers` sin comprobar `res.ok` (igual en `ChatInbox` con
  plantillas y `ClientsList` con ciudades: un 500 se guardaba como array y
  el render reventaba).
- `LeadPipeline`: los leads `NO_INTERESADO` y `FUERA_COBERTURA` eran
  invisibles en el kanban (no estaban en `STAGES`); ahora tienen columna.
  Calendarios de `LeadPipeline` y `ServiceList`: siempre 31 días desde el
  día 1 bajo "Lun" (en febrero los días 29–31 eran de marzo y casaban
  leads/servicios de marzo); ahora usan el mes real con su desplazamiento
  de semana. `ServiceList` además interpretaba `YYYY-MM-DD` en UTC (caía
  en el día anterior en Bogotá).
- `CapacityWidget`: las fechas se calculaban en UTC (`toISOString`):
  después de las 19:00 en Bogotá ya era "mañana". Ahora en
  `America/Bogota`. Se quitó el texto falso "Solo se cuentan servicios
  'Sincronizados'" (ese concepto no existe en el backend).
- `ChatInbox`: el orden por `messages[].fullDate` era imposible (el
  backend no devuelve `fullDate`; `new Date(undefined)` = `NaN`): ahora se
  respeta el orden SQL (`last_message_time DESC`). Se quitaron los restos
  muertos de grabación de voz/adjuntos (refs e iconos sin botón ni input).
- `WhatsAppChannels`: "Ver QR" abría un `<img src="">` vacío tras
  recargar (el listado no trae el QR); ahora lo recupera con
  `GET /api/wa/qr/:id`. El botón de cerrar el modal usaba el icono de
  papelera; ahora una X. `getStatusColor` ahora contempla `authenticated`
  y `disconnected`.
- `FrictionAnalytics`: el clasificador `includes('otro')` casaba con
  "nosotros" (→ Competencia); ahora con límite de palabra. La tabla
  "Historial Detallado" no incluía los leads perdidos; ahora sí. El orden
  de "Últimas Novedades" interpretaba `YYYY-MM-DD` en UTC.
- `LoginScreen`: el email no hacía `trim()`/`toLowerCase()` (un espacio o
  una mayúscula daba "Credenciales inválidas"); `© 2025` fijo → año
  dinámico.
- `lib/branding.ts`: `mix()` no validaba hex (un color de 3 dígitos daba
  `NaN`); faltaban los tonos `300`/`800` y overrides de varias clases
  `brand-*` que el frontend usa.
- `BrandingSettings`: el mensaje de error mostraba el icono verde de éxito.
- `Dockerfile`: paquetes apt que no existen en Debian 12 (`gconf-service`,
  `libgconf-2-4`, `libappindicator1`) y rompían el build; se añadió
  `HEALTHCHECK` con `/api/health`.
- `install.sh`: `sed -i` de GNU falla en macOS (BSD) y una clave con `&`
  rompía el reemplazo. `install.bat`: no generaba `JWT_SECRET` ni pedía
  claves (dejaba las de ejemplo) y el puerto era fijo 8080; ahora genera
  el secreto con PowerShell, pide clave de Postgres y admin inicial, y lee
  `APP_PORT` del `.env`.

**Duplicados unificados:**
- `formatCurrency` (idéntico en 4 archivos) → `lib/format.ts`, importado
  por `Dashboard`, `BusinessDeals`, `ClientsList` y `TeamManagement`.

**Qué quedó dudoso (NO borrado, a decidir):**
- `GET /api/wa/qr/:id` no lo llamaba nadie, pero es la vía de recuperación
  del QR tras recargar: se conserva y ahora `WhatsAppChannels` sí lo usa.
- `POST /api/staff` y `PUT/DELETE /api/staff/:id` **sin** `requireAdmin`:
  el `sales_agent` gestiona a sus subordinados desde Equipo, así que un
  `requireAdmin` genérico le quitaría esa función. Falta un control fino
  (admin, o líder sobre sus propios subordinados).
- `reassignment_timeout` se guarda pero el servidor nunca lo lee: no hay
  reasignación automática; el "Reasignación Inminente" del pipeline es
  solo un texto.
- Los totales de `AuditModule`, `BusinessDeals` y
  `LeadPipeline` se calculan sobre la página cargada (50 registros), no
  sobre todos los datos; solo `Dashboard` y `ClientsList` tienen totales
  reales del servidor.
- No hay normalización de teléfonos en ningún lado: `3001234567`,
  `+573001234567` y `57 300 123 4567` son 3 clientes distintos para
  búsqueda, duplicados y borrado.
- Las comisiones del Dashboard usan una estimación fija del 4% sobre el
  ingreso bruto (el propio código lo admite en comentarios); solo el
  ranking por vendedor usa el escalafón real por tramos.
- `InvoiceModal` se borró por inalcanzable, pero el recibo imprimible es
  una función que podría quererse: está en `crm-v3/` para restaurarlo.
- `handleFinishOperator` en `ServiceForm` convierte el canvas a imagen
  siempre, aunque no se haya firmado (pisa una firma previa con un PNG
  vacío). `advances` no tiene input ni entra en el cálculo. Los campos
  `additionalItems`, `expensesNote`, `servicePerformed`, `observations` e
  `isWarranty` existen en el formulario pero sin input en la UI.

## Qué NO se tocó

- **WhatsApp por QR tal cual** (`whatsapp-web.js` + `qrcode`, sesión
  `LocalAuth`, multi-instancia). No se cambió a Baileys ni a Meta Cloud API.
  La sesión vive en `.wwebjs_auth/` (volumen `wa-auth` en Docker).
- Ningún módulo de crm6: leads, pipeline, deals, auditoría,
  inteligencia de clientes, capacidad, plantillas,
  comisiones, ranking, notas, recordatorios, exportación xlsx.
  (Los endpoints `/api/tasks/*` se quitaron porque nadie los
  llamaba; la tabla `tasks` sigue y el contador de pendientes del inbox
  sigue funcionando.)
- El build de la base ya pasaba (`vite build` en ~20 s, 2847 módulos). Se
  dejó Tailwind CDN; el `importmap` muerto se quitó en v4. Aviso sin
  corregir: el chunk JS pesa ~1,28 MB (advertencia de Vite, no un error).

## Requisitos

- **Opción Docker (recomendada):** Docker + Docker Compose.
- **Opción manual:** Node.js 20+ (recomendado 22, por whatsapp-web.js) y
  PostgreSQL 16.

## Instalación en 3 pasos (Docker)

```bash
# 1. Copia la configuración y rellénala (o deja que el instalador lo haga)
cp .env.example .env

# 2. Levanta todo (app + base de datos)
docker compose up -d --build

# 3. Abre http://localhost:8080
```

O usa el instalador, que hace los pasos 1–2 y te pide los datos:

- Linux / macOS: `./install.sh`
- Windows: doble clic en `install.bat`

**Credenciales iniciales:** las que pongas en `ADMIN_EMAIL` / `ADMIN_PASSWORD`
del `.env`. Se crean solo si la tabla de usuarios está vacía. **Cambia la
contraseña después de entrar** (Equipo → tu usuario). Si no defines esas
variables, no se crea ningún admin y tendrás que crearlo a mano en la base
de datos.

**Variables del `.env` (ver `.env.example`):**

| Variable | Para qué |
|---|---|
| `APP_PORT` | Puerto público (por defecto `8080`) |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Base de datos del contenedor |
| `DATABASE_URL` | Vacío en Docker (se construye solo con `POSTGRES_*`); en manual, tu Postgres |
| `JWT_SECRET` | Secreto de los tokens (el instalador lo genera si está vacío; sin él los tokens no sobreviven a un reinicio) |
| `CORS_ORIGIN` | Vacío = mismo origen; solo si el frontend vive en otro dominio |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Admin inicial (solo si no hay usuarios) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Alertas de Telegram (monitoreo v3.1) |
| `BACKUP_ENABLED` / `BACKUP_KEEP_DAYS` | Respaldo diario 02:00 (por defecto activo, 7 días) |
| `SMTP_HOST` / `SMTP_USER` / `ALERT_EMAIL` | Email opcional: requiere instalar `nodemailer` |

## Despliegue en Railway (sin VPS) — v5.3.1

Railway es la opción sin servidor propio: corre el mismo Docker de siempre
y te da la base de datos. Netlify NO sirve para el sistema completo
(solo páginas estáticas; el CRM necesita un proceso siempre prendido:
Express + Socket.io + sesión de WhatsApp + respaldo diario).

1. Sube esta carpeta a un repositorio de GitHub (sin `.env`, sin
   `node_modules`, sin `dist`, sin `.wwebjs_auth`).
2. En [railway.app](https://railway.app) crea un proyecto → **Deploy from
   GitHub Repo** y elige el repo. Railway detecta el `Dockerfile`
   (`railway.json` ya viene en esta carpeta: builder Dockerfile, chequeo de
   salud en `/api/health`).
3. Agrega **Postgres**: en el proyecto → **+ New → Database → PostgreSQL**.
   Railway crea la variable `DATABASE_URL` y la inyecta sola en el servicio
   de la app (el servidor la usa directamente, no hace falta `POSTGRES_*`).
4. En el servicio de la app → **Variables**, agrega:
   `JWT_SECRET` (largo, p. ej. `openssl rand -hex 32`), `ADMIN_EMAIL`,
   `ADMIN_PASSWORD`, `TZ=America/Bogota`. Las demás son opcionales
   (Telegram, Wompi/PayU, Meta, Google Calendar — ver `.env.example`).
   `PORT` lo asigna Railway solo; NO lo pongas a mano.
5. **Volumen (obligatorio, UNO solo):** en el
   servicio → **Settings → Volumes**, el volumen EXISTENTE con punto de
   montaje **`/app/data`** (sesión de WhatsApp + archivos: logo y
   multimedia de la v5.3.6). Railway solo permite un volumen por servicio,
   así que NO se crea un segundo volumen. Si el volumen todavía está en
   `/app/.wwebjs_auth`, edítalo a `/app/data` y añade la variable
   `PERSIST_DIR=/app/data` (ver la sección "Un solo volumen en Railway
   (v5.3.7)"): la sesión no se pierde, queda en la raíz del mismo volumen.
   Sin este volumen, cada redespliegue borra la sesión (hay que escanear
   el QR de nuevo) y los archivos de media (los mensajes y su texto en
   base de datos no se pierden). En Trial el volumen es de 0.5 GB en
   total; en Hobby, 5 GB.
6. Despliega: Railway construye la imagen y te da un dominio
   (`https://tu-app.up.railway.app`). Abre ese dominio, entra con el admin
   del paso 4 y conecta el QR en **Canales WhatsApp**.
7. Costo orientativo: plan Hobby ~US$5/mes + consumo (la app + Postgres
   suelen quedar en US$7–12/mes para un uso normal de una empresa pequeña).
   El respaldo diario usa `pg_dump` dentro del contenedor y guarda en
   `backups/`; en Railway ese archivo vive en el contenedor (no es un
   volumen persistente salvo que montes uno en `/app/backups`).

## Despliegue en VPS u otro servidor — v5.3.1

La v5.3.1 sigue desplegándose igual que antes en cualquier VPS o servidor
con Docker: es el MISMO código y el MISMO Dockerfile que en Railway, solo
cambia dónde corre.

- **VPS con Docker (recomendado):** copia la carpeta al servidor y sigue
  "Instalación en 3 pasos (Docker)" de arriba (`cp .env.example .env` →
  `docker compose up -d --build`). El `docker-compose.yml` levanta app +
  Postgres con volúmenes `pgdata`, `uploads` y `wa-auth` (la sesión de
  WhatsApp sobrevive a reinicios). Para dominio propio con HTTPS, pon un
  proxy inverso delante (Nginx/Caddy) apuntando al puerto `APP_PORT`
  (8080 por defecto) y usa ese dominio en `CORS_ORIGIN` solo si el
  frontend vive en otro dominio.
- **VPS sin Docker (manual):** Node 22 + PostgreSQL 16, sigue
  "Instalación manual (sin Docker)". Asegúrate de que `PORT` y
  `DATABASE_URL` estén en el entorno y de usar un gestor de procesos
  (`systemd` o `pm2`) para que el servidor se reinicie solo.
- **Otros PaaS (Render, Fly.io, etc.):** igual que Railway: despliegan el
  `Dockerfile`, inyectan `DATABASE_URL` y `PORT`, y necesitan un volumen
  persistente para la sesión de WhatsApp y los archivos: un solo volumen
  montado en `/app/data` con `PERSIST_DIR=/app/data` (ver v5.3.7). El
  chequeo de salud es `GET /api/health`.
- **Qué NO cambió:** el `Dockerfile` solo cambió el chequeo de salud para
  usar `$PORT` en vez del 3000 fijo (en Docker Compose sigue siendo 3000).
  `docker-compose.yml`, `install.sh` e `install.bat` no se tocaron.

## Instalación manual (sin Docker)

```bash
npm ci
cp .env.example .env   # rellena DATABASE_URL, JWT_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD
npm run build
npm start              # escucha en PORT (por defecto 3000)
```

Desarrollo: `npm run dev` (Vite en `http://localhost:5173`, con proxy a la
API en `http://localhost:3000` — arranca `npm start` en otra terminal con
`PORT=3000`). Verificación de tipos: `npm run typecheck`.

## WhatsApp por QR (cómo conectar)

1. Entra como administrador y ve a **Canales WhatsApp** (menú, solo admin).
2. Crea una instancia (por ejemplo "Línea Principal") con **Agregar instancia**.
3. Pulsa **Ver QR** y escanéalo con el celular: WhatsApp → Dispositivos
   vinculados → Vincular un dispositivo.
4. Cuando el estado pase a `ready`, los mensajes que lleguen a ese número
   entran al inbox y los que envíes desde el chat salen por esa misma
   conexión. Puedes tener varias instancias (varios números) a la vez.
5. La sesión queda guardada en `.wwebjs_auth/` (volumen `wa-auth` en Docker),
   así no hay que escanear el QR en cada reinicio. Desde la v5.3.2, tras un
   redespliegue la instancia se levanta sola con esa sesión (ver
   "WhatsApp QR: arreglos v5.3.2"). Si se desconecta, vuelve a **Canales
   WhatsApp** y escanea de nuevo.

> Es una conexión **no oficial** (WhatsApp Web). Meta la tolera pero puede
> bloquear el número si se envían mensajes masivos o spam: no uses tu número
> personal.

## WhatsApp Meta Cloud API (v5 Parte 2B, Colombia)

Alternativa **oficial** al QR: los mensajes salen por la API de Meta
(`POST https://graph.facebook.com/v19.0/<phone-number-id>/messages`) y
entran por webhook, sin navegador, sin QR y sin depender de un celular
encendido. Cada instancia tiene un **canal**: `qr` (por defecto, como
antes) o `meta`. El envío desde el inbox elige el canal según la
conversación (`conversations.channel`, que se fija al crearla); las
conversaciones creadas antes de la v5 Parte 2B (sin canal) siguen por QR,
salvo que su fuente nombre una instancia Meta. Sin Meta configurado, todo
sigue por QR: nada cambia.

**Configurar Meta, paso a paso:**

1. En [Meta for Developers](https://developers.facebook.com) crea una app
   (tipo **Empresa**) y añade el producto **WhatsApp**.
2. En la app ve a **WhatsApp → API Setup**: ahí está tu número de prueba y,
   bajo él, el **Identificador del número de teléfono** (solo dígitos: es el
   `phone_number_id`, NO el número). Para usar tu número real de empresa,
   regístralo en **WhatsApp → API Setup → Paso 2** (te llega un código por
   SMS/llamada) o en **Administrador de WhatsApp**.
3. En la misma pantalla genera el token: el **temporal** dura 24 h (solo
   para probar) y el **permanente** se crea con un usuario del sistema
   (**Configuración → Usuarios del sistema → Generar token** con permiso
   `whatsapp_business_messaging`). Guarda el token: Meta solo lo muestra una vez.
4. Pon el token y el phone number id en el CRM: entra como admin a
   **Canales WhatsApp → Meta Cloud API (oficial)** y guárdalos ahí, o en el
   `.env` como `META_WA_TOKEN` y `META_WA_PHONE_NUMBER_ID` (lo guardado en
   el CRM tiene prioridad). El token **nunca** se devuelve al frontend:
   `GET /api/settings` no lo incluye y `GET /api/wa/meta/status` solo dice
   si hay uno guardado y de dónde viene.
5. Webhook: inventa un token de verificación (cualquier texto secreto, p.
   ej. `openssl rand -hex 16`) y ponlo en el `.env` como
   `META_WA_VERIFY_TOKEN`. En Meta ve a **WhatsApp → Configuración →
   Webhook → Editar** y pon URL de devolución
   `https://tu-dominio.com/api/webhooks/meta`, ese mismo token, y pulsa
   **Verificar y guardar**. Meta llama al `GET` del webhook: si el token
   coincide responde el `hub.challenge`; si no, **403**. Sin
   `META_WA_VERIFY_TOKEN` configurado, el `GET` siempre responde 403.
   Después suscríbete al campo **`messages`** (sin él no llegan mensajes).
6. (Recomendado) Secreto de la app: en la app de Meta ve a
   **Configuración → Básica → Secreto de la app** (pulsa Mostrar) y ponlo
   en el `.env` como `META_WA_APP_SECRET`. Con él, el servidor verifica la
   firma `X-Hub-Signature-256` (HMAC SHA256 del body crudo) de cada evento;
   si no coincide responde **401**. Sin secreto, los eventos se aceptan
   igual pero se registra un aviso en `system_events` (una vez por arranque).
   El body crudo se guarda en `req.rawBody` solo para esa ruta (opción
   `verify` de `express.json`); las demás rutas JSON no se tocan.
7. Crea una instancia en **Canales WhatsApp** eligiendo canal **Meta**, o
   cambia el canal de una existente con el selector **QR / Meta** de su
   tarjeta (al pasar a Meta se destruye la sesión de WhatsApp Web; al
   volver a QR hay que escanear un QR nuevo). El canal elegido se guarda en
   `settings` (`wa_channel_<id>`) y sobrevive a reinicios. Una instancia
   Meta lista aparece como `ready`; sin configurar, como `disconnected`.
8. Prueba: escribe al número desde otro celular. El mensaje debe entrar al
   inbox con fuente **WhatsApp Meta**; responde desde el chat y debe salir
   por la API de Meta. **Ojo, regla de Meta:** fuera de la ventana de 24 h
   tras el último mensaje del cliente, solo se pueden enviar **plantillas
   aprobadas**; el CRM envía texto libre, así que si Meta responde
   `131047` (fuera de ventana) el mensaje queda guardado y el error en
   `system_events`. Las plantillas no están implementadas (quedan para
   después).

**Qué procesa el webhook (`POST /api/webhooks/meta`, público):** solo
mensajes de **texto** (`entry[].changes[].value.messages[]` con
`type=text`); los estados (entregado/leído) y los multimedia se ignoran
por ahora. Cada mensaje se guarda igual que los de QR (cliente,
conversación por teléfono normalizado, mensaje con `external_id` = wamid
de Meta para no duplicar si Meta reenvía el evento) y emite
`notifyUpdate('webhook_message')` para que el inbox se actualice en vivo.
El nombre del cliente sale del perfil de WhatsApp (`contacts[].profile.name`)
cuando Meta lo envía.

**Endpoints nuevos (JWT salvo los webhooks, que son públicos):**
- `GET /api/webhooks/meta?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`
  → `200` con el challenge, o `403` si el token no coincide o no hay verify
  token configurado.
- `POST /api/webhooks/meta` → `{ ok, received, stored }`; `503` sin DB.
- `GET /api/wa/meta/status` → `{ configured, hasToken, tokenSource,
  phoneNumberId, verifyTokenConfigured, appSecretConfigured }` (sin token).
- `PATCH /api/wa/instances/:id/channel { channel: 'qr'|'meta' }` → cambia
  el canal y re-inicializa la instancia.
- `POST /api/wa/instances` acepta ahora `{ channel }` opcional.
- `GET /api/wa/instances` incluye `channel` por instancia; `GET
  /api/wa/qr/:id` responde `400` para instancias Meta (no tienen QR).
- **Variables en `.env.example` (opcionales, vacías):**
  `META_WA_TOKEN`, `META_WA_PHONE_NUMBER_ID`, `META_WA_VERIFY_TOKEN`,
  `META_WA_APP_SECRET`.

## Normalización de teléfonos (Colombia) (v5 Parte 2B)

Todos los teléfonos colombianos se guardan en un solo formato, **+57 + 10
dígitos** (ej. `+573001234567`), para que el mismo cliente no aparezca dos
veces como `3001234567` en un lado y `+573001234567` en otro. La lógica es
la misma en el servidor (`normalizePhoneCO` en `server.js`) y en el
frontend (`lib/phone.ts`: `normalizePhoneCO` y `formatPhoneCO`):

| Entrada | Guardado | ¿Normalizado? |
|---|---|---|
| `300 123 4567`, `300-123-4567`, `(300) 123.4567` | `+573001234567` | Sí |
| `573001234567`, `+573001234567`, `+57 300 123 4567` | `+573001234567` | Sí |
| `6012345678` (fijo Bogotá), `123`, `+1 415 555 1234` | tal cual | No, se deja como viene |

Nunca se inventa un `+57`: lo que no encaja en las dos reglas (10 dígitos
que empiezan por 3, o 12 dígitos que empiezan por 57) se guarda tal cual.
Para mostrar, `formatPhoneCO` lo presenta como `+57 300 123 4567`.

**Dónde se aplica:** en todas las escrituras del servidor — servicios
(`POST /api/services`), empleados (`POST/PUT /api/staff`), notas y
recordatorios, y en la entrada de mensajes por QR y por webhook de Meta
(cliente, conversación y mensaje). También en el frontend al guardar un
servicio (`ServiceForm`) y un empleado (`TeamManagement`), y al mostrar el
teléfono en la lista de clientes (`ClientsList`). En las búsquedas
(`GET /api/clients`, `/api/leads`, `/api/services` con `?search=`), el
término se compara además con sus variantes (con +57, sin + y 10 dígitos),
así `3001234567` encuentra filas guardadas como `+573001234567` y viceversa.
El borrado de cliente (`DELETE /api/clients/:phone`) borra en todas las
formas para no dejar restos de antes de la normalización. Los leads no
tienen campo de teléfono en `POST /api/leads/update` (el teléfono vive en
la conversación), así que ahí no había nada que normalizar.

**Normalizar lo ya guardado — `POST /api/system/normalize-phones` (JWT,
solo admin):** recorre `leads`, `services`, `employees` y `conversations`
y normaliza los teléfonos. Devuelve `{ updated, collisions, perTable }`.
Si dos valores distintos normalizan al mismo número (p. ej. `3001234567`
y `+573001234567` ya guardados), o el número normalizado ya existe en la
tabla, se reporta en `collisions` como `{ table, phone, count }` y esas
filas **no se tocan**: no se borra ningún duplicado automáticamente, el
admin los revisa y los fusiona a mano. El resultado queda en
`system_events`. La tabla `clients` (teléfono = clave primaria) no se toca
en este endpoint: normalizar su PK exigiría reescribir las referencias, y
queda como trabajo aparte. El id de conversación (`wa_<dígitos>`) tampoco
se renombra: es clave foránea de `messages`.

## Google Calendar (v5.3, pedido del cliente)

Cuando se agenda un servicio (crear o reprogramar), el CRM crea o
actualiza el evento en Google Calendar; al cancelar o eliminar el
servicio, el evento se borra. El evento se llama
`Limpieza — <cliente> (<servicio>)`, dura 2 horas por defecto (cambiable
en settings: `google_calendar_duration_minutes`), lleva la dirección
completa, el teléfono normalizado, el asesor, los operadores y el valor
total, en zona `America/Bogota`. El cliente **no** se añade como
invitado (el sistema no guarda su email). Cada servicio guarda el id
del evento (`google_calendar_event_id`): si ya existe, se actualiza
(PATCH) en vez de crear un duplicado. En la vista Servicios, cada fila
muestra un iconito verde si está sincronizado o gris si no, y hay un
botón para reintentar la sincronización de ese servicio
(`POST /api/services/:id/sync-calendar`, admin o vendedor). En Estado
del Sistema hay una fila "Google Calendar" (configurado / no configurado
/ último error).

**Sin credenciales no pasa nada malo:** el servicio se guarda igual y
solo se registra el aviso en `system_events`. Google Calendar es
opcional.

**Configuración paso a paso (lo hace el cliente con su cuenta de Google):**

1. En [Google Cloud Console](https://console.cloud.google.com/) crea un
   proyecto (o usa uno existente) y habilita la **Google Calendar API**
   (APIs y servicios > Biblioteca > Google Calendar API > Habilitar).

**Conectar con un clic (recomendado, v5.3.35):**

2. APIs y servicios > Credenciales > Crear credenciales > **ID de cliente
   de OAuth** > tipo **Aplicación web** (la de escritorio NO sirve aquí:
   no admite una URI pública de redirección y el tipo no se puede cambiar
   en una credencial existente, hay que crear una nueva). En "URIs de
   redireccionamiento autorizados" añade la URI que muestra el CRM:
   `<URL pública del CRM>/api/system/google-calendar/callback` (en Estado
   del Sistema → Google Calendar, con botón Copiar). Anota el Client ID y
   el Client Secret.
3. En el CRM (solo admin): Estado del Sistema → Google Calendar: pega el
   Client ID y el Client Secret y guarda. Luego pulsa **“Conectar con
   Google”**, acepta con la cuenta de Google de la empresa y listo: el
   refresh token se guarda solo. Para cambiar de cuenta, pulsa
   “Desconectar” y conecta de nuevo.
4. Prueba: “Probar conexión” (o
   `POST /api/system/google-calendar/test`, solo admin): crea un evento
   de prueba de 15 min "Prueba CRM — borrar" y lo borra de inmediato.
   `GET /api/system/google-calendar/status` (solo admin) dice si está
   configurado, sin mostrar secretos.

**Alternativa con el script local (sin botón):** con credencial de tipo
**Aplicación de escritorio** y `http://localhost:8089` en "URIs de
redireccionamiento autorizados", corre en el servidor (o en tu
computador, con el código del CRM):
`node scripts/get-google-refresh-token.js <CLIENT_ID> <CLIENT_SECRET>`
Abre la URL que imprime con la cuenta de Google de la empresa, acepta
el acceso al calendario y el script imprime el refresh token. Pégalo en
el CRM junto con el Client ID y el Client Secret (Calendar ID `primary`
o el ID de un calendario compartido, duración 120). También se puede
poner todo en el `.env` (y reinicia): `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CALENDAR_ID` y
`GOOGLE_CALENDAR_DURATION_MINUTES`; lo de settings tiene prioridad si
está puesto.

**Con honestidad:** sin las credenciales de Google de la empresa no se
puede probar un evento real: el flujo de crear/actualizar/borrar está
implementado contra la API oficial (`googleapis`, OAuth2 con refresh
token), pero aquí no hay cuenta de Google con la que probarlo. El
refresh token no caduca por tiempo (solo si se revoca el acceso en
https://myaccount.google.com/permissions o se cambia la app a
producción sin publicar); el token temporal de 24 h de Meta for
Developers NO sirve aquí, tiene que ser el refresh token del paso 3.

## Marca blanca / revenderlo a otras empresas

El CRM es **tema libre**: el nombre, el eslogan, el logo y los colores no
están fijos en el código. En **Ajustes → Personalización** (solo admin) se
sube el logo (PNG/JPG, máx. 2 MB), se pone el nombre y los colores, y se
aplican en el inicio de sesión, el menú y el resto del sistema. Para
venderlo a otra empresa solo cambia eso, sin tocar código. **Una instalación
+ una base de datos por cliente.**

## ¿Cómo sé si algo se rompió? (Monitoreo v3.1)

Ya no hay que entrar a mirar logs: el sistema se vigila solo.

**1. Página Estado del Sistema (en el CRM)**
Como administrador, abre el menú **Estado del Sistema**. Ahí se ven semáforos
por componente:

| Semáforo | Qué significa |
|---|---|
| 🟢 Verde | Todo bien |
| 🟡 Amarillo | Atención: sin instancias de WhatsApp, sin respaldo reciente (más de 48 h) o sin alertas configuradas |
| 🔴 Rojo | Roto: base de datos caída, WhatsApp desconectado, autoprueba fallida |

La página muestra también los últimos eventos (errores, desconexiones,
logins fallidos) con filtro por nivel, y botones para **Probar ahora**
(autoprueba real: DB, servicios, plantillas, equipo, WhatsApp, escritura en
`uploads/` y configuración de Telegram), **Reconectar WhatsApp**,
**Hacer respaldo ahora** y **Probar alerta de Telegram**. Se actualiza sola
cada 30 segundos.

**2. Alertas por Telegram (recomendado, gratis, 2 minutos)**
Es el canal principal porque sigue funcionando cuando WhatsApp está caído
(avisar por WhatsApp de que WhatsApp está caído no tiene sentido).

1. En Telegram busca **@BotFather** → `/newbot` → ponle nombre → te da un
   token como `123456:ABC-DEF...`. Guárdalo.
2. Busca tu bot y escríbele un mensaje cualquiera (por ejemplo `hola`).
3. Abre en el navegador
   `https://api.telegram.org/bot<TU_TOKEN>/getUpdates` y busca
   `"chat":{"id": 123456789}`: ese número es tu `TELEGRAM_CHAT_ID`.
   (También sirve el bot **@userinfobot**: te dice tu id directamente.)
4. Pégalo en el CRM (solo admin): Estado del Sistema → Configuración de
   integraciones → Telegram: Bot Token y Chat ID, Guardar. También se puede
   poner en el `.env` (`TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID`) y
   reiniciar el servidor (`docker compose restart app`); lo de settings
   tiene prioridad si está puesto.
5. Prueba: en **Estado del Sistema → Probar alerta de Telegram**. Si llega el
   mensaje a tu teléfono, las alertas funcionan.

El vigilante revisa DB y WhatsApp cada 5 minutos y solo avisa cuando algo
**cambia** de bien a mal (o de mal a bien, "recuperado"), y no repite el mismo
aviso antes de 30 minutos para no spamear. También avisa si hay 5 intentos
fallidos de login con el mismo correo en 10 minutos (posible fuerza bruta).

**3. Monitor externo (segunda capa, gratis)**
Si el servidor entero se cae, el CRM no puede avisarse a sí mismo. Crea una
cuenta gratuita en **UptimeRobot** (o Better Stack) y añade un monitor HTTP
a `https://tu-dominio.com/api/health` cada 5 minutos: si no responde 200,
te avisa por email/Telegram. Esa ruta es pública y ligera, no necesita login.

**4. Respaldos**
El servidor hace un respaldo diario a las 02:00 (America/Bogota) con
`pg_dump` y guarda los últimos 7 días en `backups/purifica-AAAA-MM-DD-HHmm.sql.gz`
(ver el último en **Estado del Sistema**). También puedes hacerlo a mano:
botón **Hacer respaldo ahora**, `docker compose --profile backup run --rm backup`,
o `./scripts/backup.sh` en el host. Para restaurar (¡borra los datos actuales!):

```bash
gunzip -c backups/purifica-2026-11-06-0200.sql.gz | psql "$DATABASE_URL"
```

El email es opcional y no está instalado: si quieres alertas por email además
de Telegram, instala `nodemailer` (`npm i nodemailer`) y rellena
`SMTP_HOST/SMTP_USER/ALERT_EMAIL` en el `.env`; el código ya está preparado
para usarlo.

**Qué mira la autoprueba:** `SELECT 1` en la DB, leer servicios, plantillas
y equipo, estado de WhatsApp, escritura en `uploads/` y configuración de
Telegram. Cada prueba muestra su tiempo en milisegundos.

## Roles y paneles (v5.2 — corrección de la lógica de roles)

En la revisión de roles se encontraron tres problemas y se corrigieron
aquí (antes se había dejado solo la opinión; ahora está el arreglo):

**A1. Un solo tipo de rol, en minúscula.** Antes en la BD se guardaba
`Admin`/`Advisor`/`Sales_Agent` con mayúscula (el formulario de Equipo
mandaba el valor de la pestaña tal cual) mientras el login y el JWT
usaban minúscula. Ahora todo es minúscula: `admin | advisor | operator
| sales_agent` en `types.ts` (`StaffRole`, `UserRole` es el mismo tipo),
en el servidor y en la BD. `POST/PUT /api/staff` y
`POST /api/commission-tiers` normalizan el rol a minúscula y devuelven
400 si es inválido. Al arrancar, `initDB` pone en minúscula los roles
existentes (`UPDATE employees SET role = LOWER(role)` y lo mismo en
`commission_tiers`) **sin borrar usuarios**.

**A2. Se cerró el hueco de estadísticas.** `GET /api/stats/overview`
devolvía los totales de **toda** la empresa a cualquier usuario
logueado, incluido un operario. Ahora cada endpoint filtra por el rol
del JWT (nunca por lo que el cliente mande en la query):
`GET /api/stats/overview`, `GET /api/stats/commissions`,
`GET /api/dashboard-stats` y `GET /api/ranking`. Admin ve todo;
`advisor` solo lo suyo (por nombre); `sales_agent` lo suyo + lo de su
red (`parent_id`); `operator` solo sus servicios asignados y **nunca**
los ingresos totales de la empresa (en comisiones su fila trae los
números de sus servicios asignados, con la nota "Operador: sin comisión
por escalafón"). La respuesta incluye `scope: { role, userName }` y el
Dashboard muestra un aviso ámbar cuando los totales no son los de toda
la empresa.

**A3. Una sola función de alcance.** `getRoleScope(req)` en `server.js`
devuelve el alcance por rol desde el JWT y la usan todos los endpoints
que antes copiaban la lógica (`services`, `leads`, `clients`,
`dashboard-stats`, `stats/*`, `chats`, `ranking`). Se borraron las
ramas duplicadas. Además el servidor **ya no lee `?role=`, `?userName=`
ni `?userId=` de la query** para el alcance: antes cualquiera podía
pedirse otro rol o usuario por URL (p. ej. un líder pasando
`?advisor=otro` en el pipeline se saltaba el filtro de equipo). El
filtro de asesor de la UI se suma al alcance, nunca lo amplía. El
comportamiento para admin no cambió.

**B4. Roles de vendedor claros (sin cambiar las claves de BD).**
En toda la UI visible: `advisor` = **Vendedor** y `sales_agent` =
**Líder de ventas**. Aplica al selector de rol y a la lista de
escalafones de Equipo (con la ayuda "Vendedor: vende solo. Líder de
ventas: vende y tiene su red"), a la etiqueta del usuario en el menú
lateral, a "Mi red de ventas" (antes "Mi Red") y a las etiquetas de
comisiones ("Comisiones Vendedores/Líderes de ventas"). La diferencia:
el vendedor vende solo y atiende a sus propios clientes; el líder
vende y tiene su red — los vendedores que dependen de él y cuyas ventas
también cuentan para su comisión.

**B5. El operador lee sus mensajes (solo lectura).** El operador ahora
ve **Mensajes** en el menú, pero solo las conversaciones de los
clientes de sus servicios asignados (teléfonos normalizados +57;
`GET /api/chats` filtra por rol) y solo en lectura: el inbox no muestra
la caja de envío (aviso "Solo lectura: mensajes de tus servicios
asignados"), no muestra el botón "Sincronizar Venta" y
`POST /api/chats/:id/messages` y `POST /api/leads/update` le devuelven
403. No se le dio acceso a Clientes ni al Pipeline.

**B6. Facturación sin ser admin.** El vendedor (`advisor`) ahora ve
**Facturación**, crea facturas, registra pagos y genera links de pago
(middleware `requireBilling`: admin o advisor en `GET/POST
/api/invoices`, `GET /api/invoices/:id`, `POST
/api/invoices/:id/payments` y payment-link). **No puede** anular
facturas (`POST /api/invoices/:id/cancel` sigue solo admin y el botón
se oculta para no-admin), ni ver el export DIAN (`GET
/api/invoices/:id/export` ahora exige admin), ni cambiar el tipo de
factura por defecto ni los datos de la empresa (`invoice_default_type`,
`company_nit`, `company_regime`, `dian_resolution_*` son solo admin en
`POST /api/settings`). Las facturas son de la empresa: el vendedor ve
**todas** las facturas, solo puede crear y cobrar.

Menú por rol (v5.2):
- **Admin:** todo (Dashboard, Mensajes, Base de Clientes, Pipeline,
  Negocios, Facturación, Canales WhatsApp, Personalización, Estado del
  Sistema, Auditoría & Limpieza, Servicios, Equipo).
- **Vendedor (advisor):** Dashboard, Mensajes, Base de Clientes,
  Pipeline de Ventas, Servicios, **Facturación**.
- **Líder de ventas (sales_agent):** lo mismo que el vendedor, más
  Equipo como "Mi red de ventas". No ve Facturación.
- **Operador:** Dashboard, Servicios y **Mensajes (solo lectura, solo
  sus servicios asignados)**.

## Totales y comisiones reales + permisos finos (v5 — Parte 2C)

Cierra la v5: los totales dejan de calcularse sobre la página de 50
registros y las comisiones dejan de estimarse.

**Totales reales del servidor (sin `LIMIT 50`):**
- `GET /api/stats/overview` (JWT; **con alcance por rol desde la v5.2**,
  ver "Roles y paneles (v5.2)"): ingresos por estado (`revenue`:
  pagado/agendado/confirmado/reagendado/realizado, gastos, pagos a
  operarios, nº de servicios),
  `servicesByStatus`, `leadsByStage`, motivos de pérdida combinados
  (`lossReasons`, con `leadLossReasons` de `leads.lost_reason` y
  `serviceCancellationReasons` de `services.cancellation_reason`),
  `clientsCount`, duplicados de **toda** la base (`duplicates`: mismo
  teléfono y fecha, sin CANCELADO) e `invoicesByStatus`. Todo con
  `COUNT`/`SUM` en SQL. `?timeRange=today|week|month|all` (por defecto
  `all`) filtra por `services.date` y `leads.created_at`; duplicados,
  clientes y facturas son siempre globales.
- `GET /api/stats/commissions` (JWT; **con alcance por rol desde la
  v5.2**, ver "Roles y paneles (v5.2)"): comisión por empleado y periodo
  (`?month=YYYY-MM`, o `?timeRange=`, por defecto el mes en curso), con
  la tabla real `commission_tiers` (tramos por rol `advisor` y
  `sales_agent`). Base del tramo: ingresos **PAGADOS** del periodo. Para
  un `sales_agent` la base es la de su equipo (servicios donde `advisor`
  es él o uno de sus subordinados directos por `parent_id`, igual que
  `/api/dashboard-stats`); para los demás, solo
  sus servicios por nombre de asesor (los servicios guardan el asesor
  por nombre, no por id). Si no hay tramo aplicable, `percentage` y
  `commission` salen `null` con la nota `"sin tramo"`: **nunca se
  inventa un porcentaje**. Los valores 3%-5% que se ven en la tabla son
  los tramos sembrados en `initDB`, no una estimación en código.
- **Borrada la estimación fija del Dashboard:** `grossIncome * 0.04`
  desapareció de `Dashboard.tsx` (tarjeta principal y contabilidad) y
  no queda ningún `0.04` de comisión en `server.js` ni en el frontend.
  La utilidad neta ahora es `ingresos − gastos − pagos a operarios −
  comisiones reales del servidor`.

**Qué componente usa qué (y qué sigue en la página):**
- **Dashboard:** ingresos, servicios y proyecciones de
  `/api/stats/overview`; comisiones y ranking de
  `/api/stats/commissions` (la tarjeta del asesor muestra su comisión;
  admin/director, el total de la red). Sigue pidiendo
  `/api/dashboard-stats` **solo** para el pago propio del operario
  (su cifra personal con su rol, no el total global) y `/api/ranking`
  para el conteo de servicios por asesor. Si las comisiones no cargan,
  se muestran en 0 con aviso en Contabilidad.
- **BusinessDeals y LeadPipeline:** cada columna muestra su total de
  la página **y** el global del servidor (`servicesByStatus` /
  `leadsByStage`), más una franja de totales globales y motivos de
  pérdida. Las tarjetas del kanban siguen siendo la página cargada
  (50): es la lista visible, no un total.
- **AuditModule:** los duplicados ya vienen de
  `overview.duplicates` (toda la base). Si el endpoint falla, usa la
  página cargada solo como respaldo y lo dice en la UI. La búsqueda
  manual sigue buscando sobre lo cargado (es una búsqueda, no un total).

**Permisos finos (`requireAdminOrLeader` en `server.js`):**
- `POST/PUT/DELETE /api/staff`: admin, o `sales_agent` cuyo
  `parent_id` sea el empleado gestionado (subordinado directo; el
  campo real de jerarquía es `employees.parent_id`: no existe
  `manager_id` ni `supervisor`). `POST` es upsert por email: si el
  correo ya existe manda el `parent_id` guardado; si no, el `parentId`
  del body. Un líder no puede cambiar el director de un empleado ni
  ascenderlo a `Admin`. Cualquier otro rol → 403. Los cambios de equipo
  quedan en `system_events` (`recordEvent`, componente `staff`).
- `GET/POST/DELETE /api/commission-tiers`: solo admin (no existe
  `PUT`). El Dashboard ya no lee escalafones y la pestaña
  `CommissionTiers` de Equipo solo existe para admin; `fetchTiers`
  tolera el 403.
- **Facturación:** anular facturas ya era solo admin
  (`POST /api/invoices/:id/cancel` con `requireAdmin` y evento en
  `system_events`): verificado, no hizo falta cerrarlo.
- El 403 al guardar/eliminar equipo ya no es silencioso: `App.tsx`
  muestra el mensaje del servidor.
- No se tocó el webhook de Chatwoot (ya no existe desde la Parte 1)
  ni los webhooks de Meta/Wompi/PayU (verificación por firma intacta).
  `POST /api/staff/status` (cambio online/offline) no se tocó: no es
  crear/editar/eliminar empleado.

## Verificación hecha en esta máquina (v5 Parte 2C, 2026-11-07)

- `npm run typecheck` → exit 0, sin errores. `npm run build` → ✓ en
  14.79 s, 2049 módulos, chunk 923 kB.
- `node --check server.js` → sintaxis OK.
- Búsqueda de la estimación: `grep 0.04` en `server.js`,
  `components/`, `lib/`, `types.ts` y `App.tsx` → sin resultados;
  `Dashboard.tsx` ya no importa `CommissionTier` ni lee
  `/api/commission-tiers`.
- Arranque sin `DATABASE_URL` (puerto 3147): `GET /` → 200,
  `GET /api/health` → 200
  `{"ok":true,"version":"5.0","db":false,...}`, `GET /api/services`
  sin token → 401, `GET /api/stats/overview` sin token → 401,
  `GET /api/stats/commissions` sin token → 401 (también con token
  falso), `POST /api/staff` sin token → 401,
  `GET /api/commission-tiers` sin token → 401, `GET /server.js` → 404.
  Con JWT válido y sin DB (puerto 3148, `JWT_SECRET` de prueba):
  `/api/stats/overview`, `/api/stats/commissions?month=2026-11` y
  `POST /api/staff` → 503 "Base de datos no configurada" sin tumbar
  el proceso.
- `node_modules/` y `dist/` se borraron al final (última parte de la
  v5): hay que regenerarlos con `npm ci` / `npm run build` antes de
  usar o empaquetar.

## Verificación hecha en esta máquina (v5 Parte 2B, 2026-11-07)

- `npm run typecheck` → exit 0, sin errores. `npm run build` → ✓ en 13.74 s.
- Normalización probada compilando `lib/phone.ts` (11 casos): `300 123
  4567`, `300-123-4567`, `(300) 123.4567`, `573001234567`, `+573001234567`,
  `+57 300 123 4567` → `+573001234567`; `6012345678`, `123`,
  `+1 415 555 1234` se dejan tal cual; `formatPhoneCO('3001234567')` →
  `+57 300 123 4567`.
- Arranque sin `DATABASE_URL` (puerto 3133, con `META_WA_VERIFY_TOKEN` de
  prueba): `GET /` → 200, `GET /api/health` → 200
  `{"ok":true,"version":"5.0","db":false,...}`, `GET /api/services` sin
  token → 401, `GET /api/wa/meta/status` y `POST
  /api/system/normalize-phones` sin token → 401, `GET /server.js` → 404.
- Webhook Meta sin DB: `GET /api/webhooks/meta?hub.mode=subscribe&
  hub.verify_token=X&hub.challenge=123` → **403** (token distinto);
  con el verify token correcto → **200** con el challenge (`123`);
  con `hub.mode=unsubscribe` → **403**. `POST /api/webhooks/meta` sin DB
  → 503 honesto sin tumbar el proceso.
- `node --check server.js` → sintaxis OK.

## Verificación hecha en esta máquina (v5 Parte 2A, 2026-11-07)

- `npm run typecheck` → exit 0, sin errores. `npm run build` → ✓ en 13.63 s.
- Arranque sin `DATABASE_URL` (puerto 3132): `GET /` → 200, `GET /api/health` → 200
  `{"ok":true,"version":"5.0","db":false,...}`, `GET /api/invoices` sin token → 401
  (igual `GET /api/invoices/1`, `POST /api/invoices` y `POST /api/invoices/1/payments`),
  `POST /api/webhooks/wompi` y `POST /api/webhooks/payu` sin DB → 503 honesto sin tumbar el proceso.
- `node --check server.js` → sintaxis OK.

## Verificación hecha en esta máquina (v4, 2026-11-07)

- `npm ci` (433 paquetes) → exit 0; `npm run typecheck` → exit 0, sin errores.
- `npm run build` → ✓ en 20.64 s, 2847 módulos, chunk 1,28 MB.
- Arranque sin `DATABASE_URL` (puerto 3131): `GET /` → 200,
  `GET /api/health` → 200 `{"ok":true,"version":"4.0","db":false,"whatsapp":{"instances":0,"connected":0}}`,
  `GET /api/services` sin token → 401, `GET /api/wa/instances` sin token → 401,
  `POST /api/auth/login` sin DB → 503 **sin tumbar el proceso**,
  `GET /server.js` → 404, `GET /api/settings/branding` → 200 con los valores
  por defecto, `POST /api/system/backup` sin token → 401.
- `bash -n install.sh` y `node --check server.js` → sintaxis OK.

## Qué NO se probó (honesto)

- **Docker real ni Postgres real:** no hay Docker en esta máquina, así que
  `docker compose up` e `install.sh` **no se ejecutaron**; el
  `docker-compose.yml` y el Dockerfile se revisaron a mano. La prueba con DB
  real queda para el despliegue. Sin DB real tampoco se pudo probar:
  `runBackup` con `pg_dump` real, el `DELETE /api/leads/:id` nuevo, los
  campos nuevos de `GET /api/services`, el `IN ()` con equipo vacío, ni el
  upsert de `POST /api/staff` sin contraseña.
- **WhatsApp QR real:** no se escaneó ningún QR ni se conectó ninguna cuenta
  real. El envío y la recepción por QR quedan pendientes de escanear el QR en
  el despliegue. En particular, los arreglos v5.3.2 (quitar
  `--single-process`, restauración al arrancar, vigilante de `ready` con
  reintento automático, parada centralizada) solo se verificaron en código
  y con arranque sin DB: que el cliente llegue a `ready` en Railway con
  la sesión real guardada es lo primero que hay que comprobar tras el
  despliegue (ver "WhatsApp QR: arreglos v5.3.2").
- **WhatsApp Meta real (v5 Parte 2B):** no hay cuenta de Meta for Developers
  ni número real aquí, así que no se probaron: el envío real por
  `graph.facebook.com`, la recepción real por webhook (firma HMAC con
  `META_WA_APP_SECRET`, guardado de mensajes y `notifyUpdate`), el cambio de
  canal QR→Meta con una sesión real, ni `POST /api/system/normalize-phones`
  con DB real (la lógica de colisiones solo se revisó a mano). La
  verificación del webhook se probó solo con el `GET` (challenge correcto →
  200, token distinto o modo distinto → 403) y el `POST` sin DB → 503.
  Tampoco se probó el envío fuera de la ventana de 24 h de Meta (error
  131047: el CRM lo registra en `system_events`, pero no hay plantillas).
- **Socket con JWT en navegador real:** el middleware `io.use` verifica el
  token y el frontend lo envía, pero no se probó la conexión de socket en un
  navegador (solo el arranque del servidor).
- **PHP:** la versión PHP aparte sigue siendo la lite del CRM antiguo; no se
  rehízo sobre crm6.
- **Totales y comisiones con DB real (v5 Parte 2C):** sin Postgres no se
  pudo probar `/api/stats/overview` ni `/api/stats/commissions` con
  datos reales (las consultas se revisaron contra el esquema de
  `initDB`: `services`, `leads`, `clients`, `invoices`,
  `commission_tiers`, `employees.parent_id`), ni que el Dashboard
  muestre las comisiones reales en navegador, ni los permisos
  `requireAdminOrLeader` con usuarios reales (admin que edita a
  cualquiera, director que edita a su subordinado y recibe 403 con
  otro, asesor/operario que recibe 403). Tampoco se probó el `?month=`
  con formato inválido contra DB real (la validación está antes de las
  consultas, pero el 400 solo se alcanza con DB configurada, porque el
  guarda de DB corre antes). Pendiente en el despliegue: crear un
  asesor con ventas PAGADAS y comprobar que su comisión coincide con
  el tramo de `commission_tiers`, y un empleado sin tramo que salga
  como "sin tramo", no con un porcentaje inventado.

## Bugs encontrados y corregidos en v5.3 (segunda caza de bugs, 2026-11-07)

Segunda revisión completa archivo por archivo (3 auditores en paralelo:
backend nuevo, backend clásico + scripts, frontend) y corrección de lo
real y seguro. Lo arriesgado quedó como pendiente documentado abajo.

### Backend — corregidos (`server.js`, salvo que se indique otro archivo)

**Críticos**
- `POST /api/leads/update`: desestructuraba snake_case pero usaba
  variables camelCase no declaradas (`leadId`, `conversationId`,
  `clientName`…) → `ReferenceError` y 500 siempre. Ningún cambio de
  lead funcionaba (kanban, asignar asesor, motivo de pérdida). Ahora
  desestructura camelCase con fallback snake_case.
- `GET /api/settings`: devolvía `google_refresh_token` a cualquier
  usuario autenticado (en esta versión ya se borraba; se añadió además
  el borrado de `google_client_secret`). Un operador podía robar el
  token y tener acceso total a la cuenta de Google del dueño.
- Webhooks Wompi/PayU: un pago parcial marcaba la factura `pagado`
  con `balance=0` (se perdía el resto por cobrar). Nuevo helper
  `applyGatewayPayment`: transacción, idempotencia por
  `transaction_id`, guarda `Number.isFinite`, `newBalance = balance -
  paidAmount` y estado con `invoiceStatusFor`.

**Altos**
- `DELETE /api/leads/:id` y `DELETE /api/services/:id`: sin control
  de rol y sin 404. Ahora `requireAdmin` + 404 si no existe.
- `POST /api/services/update-deal`: sin validación y con pérdida de
  datos. Ahora valida `status` contra lista cerrada, `REAGENDADO`
  exige `date`/`time` (400 si faltan, ya no pone NULL), no pisa
  `observations` con `reason`, y 404 si no existe el servicio.
- Facturación sin alcance por rol: `GET /api/invoices`, `GET
  /api/invoices/:id`, `POST /:id/payments` y `/:id/payment-link`
  dejaban ver/cobrar facturas ajenas al asesor; `invoicesByStatus`
  en `/api/stats/overview` solo filtraba al operador. Ahora filtran
  por `getRoleScope` (helper `invoiceInScope`).
- Sin `try/catch`: `GET/POST/DELETE /api/templates`, `GET/POST
  /api/settings` y `POST /api/wa/instances` se quedaban colgadas con
  DB caída. Envueltos con 500.
- Comisiones: tramos con huecos de $1 ($10.000.000,50 no caía en
  ningún tramo → comisión null). Tramos ahora contiguos (el tramo
  cubre hasta el `min` del siguiente); `POST /api/commission-tiers`
  valida `min >= 0`, `max > min`, `0 <= percentage <= 100`;
  `totalPaidRevenue` ya no duplica lo del equipo del líder.
- WhatsApp `reconnect`: para instancia Meta no hacía nada y
  reportaba éxito (y recrearía como QR). Ahora lee el canal guardado,
  borra la entrada antes de recrear, pasa el canal y da 404 si no
  existe. `POST /api/wa/instances` da 409 si ya existe en memoria.
- Entrada WhatsApp: solo filtraba `@g.us`; estados (`@broadcast`) o
  LID (`@lid`) creaban clientes basura; mensajes de imagen/audio con
  `body` vacío se guardaban vacíos; `external_id` siempre NULL en QR
  (sin deduplicación). Ahora filtra `@broadcast`/`@lid` y `msg.type
  !== 'chat'`, ignora `body` vacío, usa `msg.id._serialized` como
  `external_id`, y `handleIncomingWhatsApp` va en transacción.
- `invoiceStatusFor`: el estado se calculaba con `advances` del
  servicio (estático), no con lo pagado: un abono parcial con
  `advances=0` nunca marcaba `parcial`. Nueva firma `(total,
  paidSoFar)` con `advances + SUM(payments)`; el pago manual devuelve
  `paid` y `warning` si `value > balance`.
- Recordatorios/notas: `GET /api/active-reminders` devolvía los de
  todos; `POST /api/reminders` aceptaba `createdBy` del body
  (suplantación); `alertAt` inválido → 500; `POST /api/notes`
  aceptaba `content` undefined; `DELETE /api/reminders/:id` sin rol.
  Ahora alcance por JWT, `createdBy` del token, validaciones 400 y
  DELETE solo dueño o admin + 404.

**Medios**
- Google Calendar: el timeout de 20 s era un `Promise.race` sin
  `AbortController` (la llamada seguía viva y podía insertar el
  evento después → duplicado); `deleteServiceFromCalendar` no tenía
  tope. Ahora `AbortController` de 20 s en ambos; la hora `9:00` se
  normaliza a `09:00` en vez de asumir 08:00 en silencio; fecha
  inválida devuelve `{skipped:true, error}` sin lanzar.
- `initDB`: `eventsTableReady = true` se ponía antes de terminar el
  seed. Ahora al final. Migraciones seguras (warning, sin romper el
  arranque): índice único `idx_invoices_service_unique` en
  `invoices(service_id)` y `UNIQUE(role, min_value, max_value)` en
  `commission_tiers`.
- `runBackup`: el éxito se decidía en `out.on('finish')` mirando
  `dump.exitCode` (podía ser null → respaldo corrupto marcado OK).
  Ahora espera al `close` de pg_dump, exige `exitCode===0` y tamaño
  > 0, con handler de error de gzip; la retención solo borra
  `purifica-*`.
- Vigilante: no avisaba de una caída que ya existía al arrancar
  (estado inicial null). Chequeo inmediato al arrancar + alerta si el
  estado inicial es error; `lastAlertAt` solo se marca si el envío
  tuvo éxito; `checkDb` con timeout de 10 s.
- `GET /api/availability`: `time` VARCHAR comparado como texto
  (`'9:00' < '13:00'` es falso → el servicio de las 9 se contaba en
  el PM). Ahora se normaliza a `HH:MM` y se compara con `::time`.
- `POST /api/system/normalize-phones`: no normalizaba
  `clients.phone` (luego el webhook creaba un cliente duplicado) y no
  era transaccional. Ahora incluye `clients(phone)` y va en
  transacción.
- `POST /api/invoices/:id/cancel`: se podía anular una factura ya
  `pagada` sin reversar nada. Ahora 400 si `status='pagado'`, en
  transacción con `FOR UPDATE`.
- `POST /api/chats/:id/messages`: respondía `{success:true}` aunque
  WhatsApp fallara (el agente creía que el cliente lo recibió).
  Ahora devuelve `sent: true/false` y `error` (mantiene
  `success:true` y 200 porque el mensaje sí quedó guardado); el
  frontend muestra "Guardado, pero WhatsApp no lo envió".
  `sendWhatsAppMessage` valida el número con `normalizePhoneCO`
  antes de enviar.
- `normalizePhoneCO`: inventaba `+57` para un fijo con prefijo país
  (`576012345678` → `+576012345678`). Ahora 12 dígitos `57…` solo
  normalizan si los 10 restantes empiezan por `3` (móvil).
- Login: `password` ausente o `role` nulo daba 500. Ahora 400 si
  faltan `email`/`password` y fallback de `role` nulo.
- Sesión: `authMiddleware` no comprobaba `employees.active`: un
  empleado desactivado seguía operando 24 h con su token. Ahora
  consulta `employees` por id (401 si no existe o `active=false`,
  actualiza el rol desde la DB; si la consulta falla por DB caída,
  deja pasar). Login con bloqueo en memoria por email+IP: tras 5
  fallos en 10 min responde 429 durante 15 min.
- Dos facturas para el mismo servicio en concurrencia: índice único
  `idx_invoices_service_unique` + captura de violación `23505` que
  devuelve la existente en vez de 500.

**Bajos**
- Paginación sin validar en `/api/clients`, `/api/leads` y
  `/api/services` (`page=0` → OFFSET negativo → 500). Clamp 1–200
  como `/api/system/events`.
- Búsqueda LIKE sin escapar (`%` devolvía todo). Helper
  `escapeLike()` en los tres listados.
- `PUT /api/staff/:id`: 404 si no existe + valida `name`/`email`.
- `GET /api/clients`: `totalSpent`/`totalServices` incluían servicios
  CANCELADO. Ahora filtran `deal_status <> 'CANCELADO'`.
- Socket: la sala por usuario solo se unía con `identify`; ahora se
  une en `connection` desde `socket.user` verificado (`identify` se
  mantiene por compatibilidad).
- Fechas: `INTERVAL '7 days'` eran 8 días en ranking, dashboard,
  overview y comisiones. Ahora `'6 days'`.
- Scripts: `install.sh`/`install.bat`/`docker-compose.yml` decían
  v3/v4; unificados a v5.3. `backups/` añadido a `.dockerignore` (el
  `Dockerfile` hace `COPY . .` y metía los `.sql.gz` en la imagen).
- `POST /api/services`: 400 si `total_value < 0` o `advances < 0`.

### Frontend — corregidos (`App.tsx`, `components/*.tsx`, `lib/*`)

- `ClientsList`: bucle de renders/peticiones al abrir Clientes
  (`onFiltersChange` nuevo en cada render en las dependencias del
  efecto). Quitado de las dependencias, como LeadPipeline y
  ServiceList.
- `App.fetchData`: un 500 dejaba `leads`/`staff`/`chats` en
  `undefined` y rompía el render. Ahora cada petición tiene su catch
  y se comprueba `res.ok` + `Array.isArray` antes de cada `setState`.
- `Dashboard`: spinner infinito si fallaba un solo endpoint. Ahora
  renderiza con datos parciales (comisiones en 0 + aviso visible en
  todas las pestañas) y panel de error con Reintentar.
- `BusinessDeals`: el filtro de etapa nunca llegaba al servidor
  (solo filtraba los 50 de la página). `dealStatus` añadido a
  `servicesUrl`.
- `ChatInbox` + `App.handleOpenFullService`: la ubicación crecía en
  cada "Sincronizar Venta" ("Chapinero, Bogotá, Bogotá"). Ahora
  `neighborhood = location.split(',')[0]`.
- `BusinessDeals`: reagendar sin fecha borraba la fecha del servicio.
  El modal exige `newDate` y `newTime`.
- `Dashboard` → Negocios: un asesor llegaba a la vista solo-admin
  desde "Proyección Pipeline / Ver Todo". Caso `'deals'` protegido en
  App (solo admin) y botón solo para admin.
- `ServiceForm`: guardaba sin validar nada. Ahora exige nombre y
  teléfono, `initialValue >= 0`, `0 <= advances <= total`, fecha no
  pasada **al crear** (al editar se permite fecha pasada para
  corregir registros viejos). `App.handleSaveService` muestra el error
  del servidor en vez de ignorarlo.
- Null-guards: `ChatInbox` (`clientName` null, `messages` sin array)
  y `AuditModule` (`dupe.name` null) rompían el render.
- Guardas de rol en `App`: `deals`, `audit` y `wa-channels` solo
  admin; `team` admin o líder (misma regla del menú). En
  `WhatsAppChannels`, Agregar/Eliminar/Cambiar canal ocultos para
  no-admin. `ServiceList.canDelete` ahora solo admin (antes incluía
  asesor, y el servidor ya exige admin).
- `LeadPipeline`: el calendario no aplicaba la corrección UTC de
  `ServiceList` (leads de noche caían en el día anterior). Ahora
  compara en `America/Bogota`.
- Fechas sin zona horaria: `ClientsList` (último servicio),
  `AuditModule` e `Invoices` ahora usan `timeZone:
  'America/Bogota'`.
- `TeamManagement`: `fetchTemplates` sin `res.ok` ni array (un
  403/500 rompía `templates.map`); `parseInt` vacíos guardaban
  `"NaN"` en settings. Validados con fallback. Escalafones sin
  validación: ahora `min >= 0`, `max > min`, `0 <= percentage <=
  100` (también `commissionPct`).
- `Invoices`: el pago manual no validaba contra el saldo (el servidor
  recortaba en silencio). Ahora valida `amount <= balance` con aviso.
- `lib/format.ts`: `maximumFractionDigits: 0` y 6 sitios unificados
  a `formatCurrency` (antes `toLocaleString()` con locale del
  navegador, inconsistente).
- `ChatInbox`: la preselección se borraba aunque no hubiera
  coincidencia (se perdía la navegación). Solo se limpia si hubo
  `match`.
- `WhatsAppChannels`: `handleViewQr` sin `res.ok`; el socket `wa_qr`
  abría el QR de otra instancia; `handleSaveMeta` decía "guardado"
  con token y phone id vacíos; crear con error no avisaba. Todo
  corregido con comprobaciones y mensajes.
- Parámetros muertos `role/userName/userId` eliminados de las URLs de
  leads/servicios/clientes y de la exportación (el alcance sale del
  JWT desde v5.2).
- Toast "Toca para abrir": ahora el click navega al inbox (antes solo
  lo cerraba).
- `CapacityWidget`: los 7 días se calculaban una sola vez al montar
  (tras medianoche mostraba días viejos). Ahora se recalculan en cada
  render.
- `SystemStatus`: cambiar el filtro mostraba el loader de pantalla
  completa. Ahora carga silenciosa.
- `ServiceList`: `colSpan={6}` en la fila vacía con 5 columnas para
  el operador. Ahora `colSpan={canSeePrices ? 6 : 5}`.
- `types.ts`: `ChatMessage.fullDate` opcional (el servidor no lo
  devuelve); `ChatConversation.pendingTasksCount?` añadido.
- `ServiceForm`: terminar como operario sin firmar guardaba una firma
  en blanco que sobrescribía la existente. Ahora solo envía la firma
  si hubo trazos (sigue sin ser obligatoria).
- Google Calendar (frontend, ya existía en este árbol y se verificó
  contra el backend): icono verde/gris por servicio en `ServiceList`
  con botón de reintento (`POST /api/services/:id/sync-calendar`,
  admin/advisor) y fila "Google Calendar" en Estado del Sistema
  (genérica desde `/api/system/status`, con último error explícito).

### Pendientes (NO corregidos en v5.3, con evidencia)

- `GET /api/chats` sin límite y con N+1: devuelve todas las
  conversaciones con todos sus mensajes (2 queries por conversación).
  No se tocó por riesgo de cambiar el contrato del inbox.
- `getRoleScope` por nombre, no por id: renombrar un empleado en
  Equipo lo deja sin sus servicios/leads; dos homónimos comparten
  datos. Refactor grande (guardar `advisor_id`/`operator_ids`).
- Webhook de Meta sin `META_WA_APP_SECRET` acepta mensajes falsos de
  cualquiera. Rechazarlo (401) rompería instalaciones sin secreto
  configurado: decisión del dueño.
- `POST /api/services` confía en el id y en los montos del cliente
  (`ON CONFLICT (id) DO UPDATE` sobrescribe el servicio entero;
  `totalValue`/`netProfit`/`advances` se guardan sin recalcular).
  Solo se añadió la validación de negativos.
- PayU: la firma se calcula con `toFixed(1)` y se compara con `===`
  (no `timingSafeEqual`); si PayU firma con 2 decimales, ningún pago
  se marca. No verificable sin una confirmación real de PayU.
- Wompi: el "secreto de eventos" de respaldo es
  `WOMPI_PRIVATE_KEY`; si el secreto real difiere, la firma nunca
  verifica. No verificable sin la config real de Wompi.
- Export DIAN: devuelve NIT/régimen/resolución en `null` si no están
  configurados, sin avisar; `fecha` es `createdAt`, no la fecha del
  servicio.
- Si el líder (`sales_agent`) debe entrar en `requireBilling`:
  decisión pendiente (hoy solo admin/advisor facturan).
- `ServiceForm`: `additionalValue`, `additionalItems`, `expenses`,
  `expensesNote`, `servicePerformed`, `observations`, `isWarranty`
  existen en el estado pero no tienen input (decisión de producto:
  añadir campos o eliminarlos). El pago a operarios se calcula solo
  sobre `initialValue`, no sobre el total (decisión: ¿comisión sobre
  inicial o sobre total?). `isAdmin` incluye a `sales_agent` (sin
  constancia de si es intencionado).
- Código muerto (no borrado por bajo valor): `sendEmailAlert` y
  `sleep` en `server.js` nunca se llaman; no hay endpoint que cree o
  complete tareas (el contador `pendingTasksCount` es siempre 0 salvo
  inserción manual en DB); N+1 de `/api/stats/commissions` (una query
  por empleado); `ChatInbox` recibe `onUpdateStatus` sin usarlo;
  `Layout` define `badge` sin uso; `lib/phone.ts` exporta
  `isNormalizablePhoneCO` sin uso.
- Dudoso sin confirmar (falta DB/servidor real): `row.date
  .toISOString().split('T')[0]` (correcto si node-pg devuelve DATE
  como medianoche UTC; si lo devuelve en hora local, un servicio
  muestra el día anterior); pool SSL `rejectUnauthorized: false`;
  `process.env.TZ = 'America/Bogota'` fijado tras los imports (el
  cambio de TZ en runtime no siempre se aplica); Puppeteer
  `--single-process` + `--no-zygote` en Docker (conocido por crashear
  con varias instancias); evento duplicado en Calendar por dos
  guardados concurrentes del mismo servicio (ambos ven
  `google_calendar_event_id` NULL e insertan).

## Verificación hecha en esta máquina (v5.3, 2026-11-07)

- `npm ci` OK (449 paquetes). `npm run typecheck` exit 0. `node
  --check server.js` OK. `npm run build` OK en 13.56 s (2049
  módulos; solo el aviso habitual de chunk > 500 kB).
- Arranque sin `DATABASE_URL` y sin credenciales de Google (puerto
  3137, sin `.env`): `GET /` 200, `GET /api/health` 200
  (`{"ok":true,"version":"5.3","db":false,...}`), `/api/services`
  sin token 401, `/api/system/google-calendar/status` sin token 401,
  `POST /api/system/google-calendar/test` sin token 401, `POST
  /api/services/1/sync-calendar` sin token 401, `/server.js` 404.
  Sin errores en el log.
- Sin probar (honesto): DB real (Postgres/Docker), QR real, Meta
  real, Wompi/PayU real, DIAN real, eventos reales de Google
  Calendar (sin credenciales de la empresa no se puede probar el
  evento real), usuarios reales por rol, Socket.io en navegador real.

## Verificación hecha en esta máquina (v5.3.2, 2026-11-07)

- `npm install` OK (460 paquetes; whatsapp-web.js **1.34.7**, qrcode 1.5.4
  ya era la última, puppeteer 24.38.0). `npx tsc --noEmit` exit 0.
  `node --check server.js` OK. `npm run build` OK en 15.43 s (2049
  módulos; solo el aviso habitual de chunk > 500 kB).
- Arranque sin `DATABASE_URL` (puerto 3160, estilo Railway con `PORT`):
  `GET /` 200, `GET /api/health` 200
  (`{"ok":true,"version":"5.3.2","db":false,"whatsapp":{"instances":0,"connected":0}}`),
  `/api/wa/instances` sin token 401, `POST /api/system/whatsapp/reconnect`
  sin token 401, `/api/system/status` sin token 401, `/server.js` 404.
  Sin errores en el log (solo los avisos esperados de JWT_SECRET efímero
  y DATABASE_URL no configurada). Grep: 0 ocurrencias de `single-process`
  y 0 llamadas comentadas a `initWhatsApp` en el arranque.
- Prueba de humo de la instancia QR (con JWT de admin de prueba, sin DB):
  `POST /api/wa/instances` crea la instancia, `DELETE` la elimina y la
  lista queda vacía (la parada centralizada `stopWaInstance` funciona por
  API). Pero el cliente cayó a `error` en ~4 s con
  `net::ERR_TUNNEL_CONNECTION_FAILED at https://web.whatsapp.com/`: Chrome
  arranca bien, pero **esta máquina de pruebas no deja salir a Chrome hacia
  web.whatsapp.com** (su proxy de salida rechaza el túnel; incluso con el
  flag de proxy da `ERR_NO_SUPPORTED_PROXIES`). Es un límite de esta
  máquina, no del código: en Railway la v5.3.1 sí generaba el QR y
  autenticaba. La generación del QR con la librería 1.34.7 y sin
  `--single-process` queda, por tanto, **sin probar aquí** y es lo primero
  que hay que comprobar tras desplegar (debe salir "QR recibido" y luego
  "WhatsApp pedro está listo!" en el log de Railway).

## Verificación hecha en esta máquina (v5.3.4, 2026-11-07)

- `npx tsc --noEmit` exit 0. `node --check server.js` OK. `npm run build`
  OK en 13.46 s (solo el aviso habitual de chunk > 500 kB).
- Arranque sin `DATABASE_URL` (puerto 3164, estilo Railway con `PORT`): <redacted>
  `GET /` 200, `GET /api/health` 200
  (`{"ok":true,"version":"5.3.4","db":false,"whatsapp":{"instances":0,"connected":0}}`),
  `/api/wa/instances` sin token 401, `/server.js` 404. Log limpio (solo el
  aviso esperado de DATABASE_URL no configurada).
- Grep: limpieza de `SingletonLock` y manejo de `@lid` presentes en
  `server.js`; `restoreWhatsAppInstances`, `armReadyWatchdog` y
  `stopWaInstance` siguen presentes (11 referencias).
- Prueba aislada de `clearWaSessionLocks` (misma lógica del servidor,
  carpeta de sesión de prueba): eliminó los 3 archivos de bloqueo
  (`SingletonLock`, `SingletonSocket`, `SingletonCookie` en raíz y en
  `Default/`), dejó intacto el resto del perfil (`Preferences`) y con
  carpeta inexistente devolvió 0 sin lanzar.
- Hallazgo sobre el 'authenticated' x5: leído el código de
  whatsapp-web.js 1.34.7 (`Client.js` + `Injected/Utils.js`): el evento
  se emite en `onAppStateHasSyncedEvent`, que la página dispara en cada
  cambio de `hasSynced` del socket; la sincronización inicial tras el QR
  lo dispara en ráfaga. Y la resolución LID está respaldada por la
  librería: `getContactModel` sustituye el id por `phoneNumber` cuando
  WhatsApp Web conoce la correspondencia, así que `contact.number` es el
  teléfono real cuando se puede resolver.
- Sin probar (honesto): QR real y llegada a `ready` en Railway, mensajes
  reales entrantes/salientes por QR, restauración automática al arrancar
  con la sesión real del volumen, el vigilante de 120 s con su reintento
  automático (solo verificado en código), Meta real, DB real, Wompi/PayU
  real, DIAN real.

## Verificación hecha en esta máquina (v5.3.5, 2026-11-07)

- `npx tsc --noEmit` exit 0. `npm run build` OK en 12.90 s (solo el aviso
  habitual de chunk > 500 kB).
- Arranque sin `DATABASE_URL` (puerto 3166, estilo Railway con `PORT`):
  `GET /` 200, `GET /api/health` 200
  (`{"ok":true,"version":"5.3.5","db":false,"whatsapp":{"instances":0,"connected":0}}`),
  `/api/wa/instances` sin token 401, `/server.js` 404. Log sin errores.
- Grep: la resolución LID lee primero `contact.id._serialized` (línea 751)
  y solo usa `contact.number` como respaldo (línea 756); el log de
  descarte registra ambos valores. `clearWaSessionLocks`,
  `restoreWhatsAppInstances`, `armReadyWatchdog` y `stopWaInstance`
  siguen presentes (15 referencias).
- Sin probar (honesto): QR real y llegada a `ready` en Railway, un mensaje
  real de remitente LID entrando al CRM (la corrección solo se puede
  comprobar con un mensaje LID real), Meta real, DB real, Wompi/PayU real,
  DIAN real.

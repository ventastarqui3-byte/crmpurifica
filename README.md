# Purifica Tu Ambiente CRM — v5.3.3 (base crm6, limpieza + facturación + roles corregidos + Google Calendar + despliegue Railway/VPS + WhatsApp QR corregido)

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
5. **Volumen (obligatorio para que el WhatsApp no se desconecte):** en el
   servicio → **Settings → Volumes → Add Volume**, punto de montaje
   `/app/.wwebjs_auth`. Opcional: otro volumen en `/app/uploads` para que
   el logo no se pierda al redesplegar. Sin volumen, cada despliegue borra
   la sesión de WhatsApp y hay que escanear el QR de nuevo.
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
  persistente en `/app/.wwebjs_auth` para la sesión de WhatsApp. El
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
2. APIs y servicios > Credenciales > Crear credenciales > **ID de cliente
   de OAuth** > tipo **Aplicación de escritorio**. Anota el Client ID y
   el Client Secret. En "URIs de redireccionamiento autorizados" añade
   `http://localhost:8089` (lo usa el script del paso 3).
3. En el servidor (o en tu computador, con el código del CRM) corre:
   `node scripts/get-google-refresh-token.js <CLIENT_ID> <CLIENT_SECRET>`
   Abre la URL que imprime con la cuenta de Google de la empresa, acepta
   el acceso al calendario y el script imprime el refresh token.
4. Pon en el `.env` (y reinicia) o guárdalo desde el CRM (solo admin):
   `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`,
   `GOOGLE_CALENDAR_ID=primary` (o el ID de un calendario compartido) y
   `GOOGLE_CALENDAR_DURATION_MINUTES=120`.
5. Prueba: Estado del Sistema > fila Google Calendar, o
   `POST /api/system/google-calendar/test` (solo admin): crea un evento
   de prueba de 15 min "Prueba CRM — borrar" y lo borra de inmediato.
   `GET /api/system/google-calendar/status` (solo admin) dice si está
   configurado, sin mostrar secretos.

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
4. En el `.env` del CRM pon `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID` y
   reinicia el servidor (`docker compose restart app`).
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
- Sin probar (honesto): QR real y llegada a `ready` en Railway, mensajes
  reales entrantes/salientes por QR, restauración automática al arrancar
  con la sesión real del volumen, el vigilante de 120 s con su reintento
  automático (solo verificado en código), Meta real, DB real, Wompi/PayU
  real, DIAN real.

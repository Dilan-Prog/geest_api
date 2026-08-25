# RETO GEEST — API de gestión de trabajo

API REST para gestionar usuarios, tareas colaborativas y su archivado automático cuando todas las partes asignadas quedan completas, con notificación externa reintentable y bitácora de intentos.

**Stack:** Node.js 24 · Express 5 · Prisma 6 · MySQL 8 · Jest + Supertest. JavaScript CommonJS, sin paso de compilación.

Documentación complementaria: `docs/api-spec.md` (contrato completo de los 9 endpoints y catálogo de errores) y `docs/database.dbml` (modelo de datos en formato DBML, importable en dbdiagram.io; la exportación a PNG queda pendiente).

---

## 🚀 Puesta en marcha

Requisitos: Node.js 24+ y un MySQL 8 accesible.

```bash
# 1. Dependencias (el postinstall ya ejecuta `prisma generate`)
npm install

# 2. Configuración: copiar la plantilla y ajustar credenciales
cp .env.example .env

# 3. Crear el esquema aplicando las migraciones versionadas del repositorio
npm run migrate

# 4. Arrancar
npm start          # producción
npm run dev        # con recarga automática (node --watch)

# 5. Tests (95 en verde)
npm test
```

`npm test` es autocontenido: usa `.env.test` (versionado), crea la base `geest_api_test` y le aplica las **mismas** migraciones del repositorio, no un `db push`. Si una migración está rota, los tests lo revelan. Se ejecuta con `--runInBand` porque varias pruebas verifican concurrencia real sobre la misma base.

Con el servidor arriba: `http://localhost:3000/docs` abre la documentación interactiva (Swagger UI), `/openapi.json` devuelve el spec crudo para importar en Postman o Insomnia, `/health` es el chequeo de vida y `/` redirige a `/docs`.

### Variables de entorno

| Variable | Obligatoria | Por defecto | Para qué |
|---|---|---|---|
| `DATABASE_URL` | Sí | — | Cadena de conexión MySQL |
| `PORT` | No | `3000` | Puerto HTTP |
| `NOTIFY_URL` | Sí (en la práctica) | — | Webhook destino de los eventos. Sin ella se omite el envío y se registra un aviso en consola |
| `NOTIFY_RETRY_BASE_MS` | No | `1000` | Base del backoff exponencial (1 s, 2 s) |
| `NOTIFY_TIMEOUT_MS` | No | `5000` | Tiempo máximo por intento de notificación |
| `IDEMPOTENCY_WAIT_MS` | No | `8000` | Cuánto espera una petición duplicada a que termine la original |
| `DUE_SOON_INTERVAL_MS` | No | `300000` | Periodo del job de avisos de vencimiento |
| `DUE_SOON_WINDOW_HOURS` | No | `24` | Antelación con la que se avisa de un vencimiento |
| `PUBLIC_URL` | No | — | URL pública en producción; Swagger la usa como servidor por defecto para que el botón *Try it out* apunte al dominio real y no a `localhost` |

---

## 📡 Endpoints

| # | Método y ruta | Qué hace |
|---|---|---|
| 1 | `POST /users` | Crea usuario (`name`, `lastName`, `email` único) |
| 2 | `POST /tasks` | Crea tarea (`title`; `description` y `dueDate` opcionales) |
| 3 | `POST /tasks/:idTask/assign` | Asigna usuarios (`userIds`), todo o nada |
| 4 | `POST /tasks/:idTask/complete` | Marca la parte de un usuario; archiva si era la última |
| 5 | `GET /tasks` | Lista tareas, filtro opcional `?status=open\|archived` |
| 6 | `GET /users` | Lista usuarios con sus tareas pendientes |
| 7 | `GET /users/:idUser/tasks` | Todas las tareas de un usuario |
| 8 | `GET /tasks/:idTask` | Detalle de una tarea |
| 9 | `GET /tasks/:idTask/notifications` | Bitácora de intentos de notificación |

Formato de error único en toda la API: `{ "error": { "code": "...", "message": "..." } }`. Los códigos están tabulados en `docs/api-spec.md`.

---

## 🔧 Decisiones técnicas

**Idempotencia por restricción de base de datos.** El `UNIQUE(key, endpoint)` de `idempotency_keys` es la primitiva de sincronización: el `INSERT` decide la carrera. Quien lo gana ejecuta la operación; quien lo pierde espera a que la respuesta quede grabada y la replica con la cabecera `Idempotent-Replay: true`. Así, dos peticiones simultáneas con la misma `Idempotency-Key` producen exactamente una ejecución y dos respuestas idénticas, sin necesidad de un lock en memoria (que no sobreviviría a varias instancias). El body se hashea con serialización estable (claves ordenadas) para que el orden de los campos no cambie el hash. Las respuestas **5xx no se persisten**: se libera la key para que un reintento sea un reintento de verdad y no la repetición eterna del mismo fallo.

**Archivado exactamente una vez.** Toda la decisión ocurre en un único `UPDATE` condicional: `WHERE status = 'open' AND NOT EXISTS (asignaciones pendientes)`, y solo se considera archivador quien obtiene `affectedRows === 1`. El `NOT EXISTS` no es decorativo: si se contaran las pendientes con un `SELECT` previo, dos transacciones concurrentes leerían el mismo snapshot de `REPEATABLE READ`, ambas verían "queda 1" y **ninguna** archivaría. Dentro de un `UPDATE`, en cambio, MySQL hace lectura bloqueante y ve siempre el último commit.

**Dos fases separadas en `complete`.** Primero una transacción corta que valida y marca la asignación; después, fuera de ella, el `UPDATE` de archivado. Meterlo todo en una transacción alargaría los bloqueos y abriría la puerta a interbloqueos entre peticiones que se esperan mutuamente sobre `task_assignments`. La garantía de "exactamente una vez" vive en el propio `UPDATE`, no en la transacción que lo rodea.

**Notificaciones reintentables y en segundo plano.** Máximo 3 intentos con backoff exponencial (1 s, 2 s). Se reintenta ante 5xx o ausencia de respuesta (timeout o red caída); **no** se reintenta ante 4xx, porque un 400 o un 404 significa que la petición está mal formada o el destino no existe y repetirla daría el mismo error. Cada intento se registra en `notification_attempts` con `eventType`, `attemptNumber`, `timestamp`, `httpStatus` (`null` si no hubo respuesta) y `success`. El envío se lanza en segundo plano: en el peor caso los tres intentos suman unos 18 s (3 timeouts de 5 s más 1 s y 2 s de espera), y quien terminó su parte merece un `200` inmediato en lugar de eso; el resultado se consulta después en el endpoint 9, que existe justo para eso.

**`urgency` calculado, nunca almacenado.** Guardarlo en columna obligaría a un job que lo refresque para que no quede obsoleto; derivarlo de `dueDate` en cada lectura es siempre exacto y cuesta una resta. En listados se usa un único `now` para toda la colección, de modo que dos tareas con el mismo `dueDate` no puedan salir con urgencias distintas.

**Prisma con SQL crudo donde importa.** Prisma aporta el esquema versionado, las migraciones y el tipado del cliente; las dos operaciones donde la corrección depende de la semántica exacta de MySQL (archivado y reclamo del aviso de vencimiento) se escriben como `$executeRaw` parametrizado.

---

## 🤔 Supuestos ante ambigüedades

El enunciado no define estos casos; se decidió y se documenta (lista completa en `docs/api-spec.md`):

1. **Completar dos veces la misma parte** devuelve `200` con éxito, no error: es el caso literal del doble clic.
2. **Asignar a una tarea archivada** devuelve `409 TASK_ARCHIVED`; permitirlo dejaría una tarea archivada con partes pendientes.
3. **`assign` es todo o nada**: si un solo `userId` no existe, no se asigna ninguno. Evita asignaciones parciales silenciosas.
4. **`userIds` duplicados** en el mismo body se deduplican sin error.
5. **Email único**, aunque el reto no lo pida: sin ello se puede registrar dos veces a la misma persona.
6. **IDs no numéricos en el path** (`/tasks/abc`) devuelven `400`, no `404`: es una petición mal formada.
7. **`dueDate` no se exige futura**: registrar una tarea ya vencida es legítimo y el semáforo la marca en rojo.

---

## ⭐ Mejora extra: alertas de vencimiento

**El problema.** El sistema del reto solo reacciona a lo que ya pasó: avisa cuando la tarea se archiva. Nadie se entera de que una tarea está a punto de vencer, que es justo el momento en que un aviso puede cambiar el resultado. Una tarea colaborativa se retrasa porque una persona no sabe que su parte es la que bloquea.

**Qué se añadió.**

- Campo opcional `dueDate` al crear la tarea.
- Campo calculado `urgency` en `GET /tasks` y `GET /tasks/:idTask`:

  | Valor | Condición |
  |---|---|
  | `green` | faltan más de 48 h |
  | `yellow` | faltan menos de 48 h |
  | `red` | ya venció y la tarea sigue abierta |
  | `null` | sin `dueDate`, o tarea ya archivada |

- Job periódico (cada 5 min por defecto, `DUE_SOON_INTERVAL_MS`) que busca tareas abiertas que vencen dentro de la ventana de aviso y aún no notificadas, y envía un evento `task.due_soon` a `NOTIFY_URL` **reutilizando el mismo motor de reintentos y la misma bitácora** que el archivado.

**Por qué así y no de otra forma.** La deduplicación usa la columna `dueSoonNotifiedAt` reclamada con un `UPDATE` condicional atómico —exactamente el mismo patrón que el archivado—, de modo que dos pasadas solapadas del job o dos instancias del servidor no puedan duplicar el aviso. La alternativa de marcar la tarea en memoria del proceso se cae con la primera segunda instancia; la de consultar-y-luego-escribir tiene la misma carrera que ya se resolvió en el archivado. Y reutilizar el notificador en lugar de escribir un segundo camino de envío significa que el backoff, la política de 4xx frente a 5xx y el registro de intentos son literalmente el mismo código ya probado; `eventType` es lo único que distingue ambos eventos en `notification_attempts`.

---

## ✂️ Recortes conscientes

Cosas que se decidieron **no** hacer, con su consecuencia real:

- **Sin patrón outbox.** La notificación se lanza en segundo plano tras confirmar el archivado en base de datos. Si el proceso muere entre ambos momentos, o a mitad de los reintentos, esa notificación se pierde y no hay quien la recupere. La solución correcta sería escribir el evento en una tabla outbox dentro de la misma transacción y que un worker la drene.
- **Sin autenticación.** No está en el enunciado, así que hoy cualquiera puede completar la parte de otro: `userId` viaja en el body y nadie verifica quién lo envía.
- **Sin paginación** en los GET de listado: devuelven la colección completa.
- **Sin medición de cobertura.** Hay 95 tests que cubren los 9 endpoints, la idempotencia, la concurrencia del archivado, los reintentos y el semáforo de vencimiento, pero no se ejecutó `--coverage` ni se fijó un umbral.
- **El job usa `setInterval` dentro del proceso**, no un cron externo ni una cola. Es suficiente para el alcance del reto, y con varias instancias el `UPDATE` condicional evita duplicados de todos modos; lo que no da es reintento de la pasada completa ni observabilidad de ejecuciones.

---

## ☁️ Despliegue

**Pendiente.** El proveedor elegido es **Hostinger**, con MySQL en el mismo servidor. El despliegue aún no se ha realizado al momento de esta entrega.

URL pública: `<pendiente>` — la documentación interactiva quedará en `<pendiente>/docs`.

El código ya contempla el entorno de producción: cierre ordenado ante `SIGTERM`/`SIGINT` que deja terminar las peticiones en curso y libera el pool de MySQL (sin esto cada redeploy deja conexiones colgando), migraciones aplicables con `npm run migrate`, y toda la configuración sensible fuera del repositorio vía variables de entorno.

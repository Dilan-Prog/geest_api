# RETO GEEST — API de gestión de trabajo

API REST para crear tareas, asignarlas a varias personas y archivarlas
automáticamente cuando todas completan su parte, notificando a un sistema externo
con reintentos y bitácora.

**Stack:** Node.js 24 · Express 5 · Prisma 6 · MySQL 8 · Jest + Supertest.
JavaScript CommonJS, sin paso de compilación.

Documentación complementaria en el repo: [`docs/api-spec.md`](docs/api-spec.md)
(contrato completo, catálogo de errores y supuestos) y
[`docs/database.dbml`](docs/database.dbml) (modelo de datos, importable en
dbdiagram.io).

---

## Puesta en marcha

Requisitos: Node.js 20+ y un MySQL 8 accesible.

```bash
npm install                 # el postinstall ejecuta `prisma generate`
cp .env.example .env        # ajustar credenciales
npm run migrate             # aplica las migraciones versionadas
npm start                   # producción  (npm run dev con recarga)
npm test                    # 131 tests
```

`npm test` es autocontenido: usa `.env.test`, crea la base `geest_api_test` y le
aplica las **mismas** migraciones del repositorio, no un `db push`. Corre con
`--runInBand` porque varias pruebas verifican concurrencia real sobre la misma base.

Con el servidor arriba: **`/docs`** abre la documentación interactiva (Swagger UI,
con *Try it out*), `/openapi.json` devuelve el spec para importar en Postman,
`/health` es el chequeo de vida y `/` redirige a `/docs`.

### Variables de entorno

| Variable | Def. | Para qué |
|---|---|---|
| `DATABASE_URL` | — | Conexión MySQL **(obligatoria)** |
| `NOTIFY_URL` | — | Webhook destino de los eventos |
| `PORT` | `3000` | Puerto HTTP |
| `PUBLIC_URL` | — | URL de producción; Swagger la usa para que *Try it out* no apunte a localhost |
| `NOTIFY_RETRY_BASE_MS` | `1000` | Base del backoff (1 s, 2 s) |
| `NOTIFY_TIMEOUT_MS` | `5000` | Timeout por intento |
| `IDEMPOTENCY_WAIT_MS` | `8000` | Espera de una petición duplicada |
| `DUE_SOON_INTERVAL_MS` | `300000` | Periodo del job de vencimientos |
| `DUE_SOON_WINDOW_HOURS` | `24` | Antelación del aviso |

---

## Endpoints

| Método y ruta | Qué hace |
|---|---|
| `POST /users` | Crea usuario (`name`, `lastName`, `email` único) |
| `POST /tasks` | Crea tarea (`title`; `description` y `dueDate` opcionales) |
| `POST /tasks/:idTask/assign` | Asigna usuarios (`userIds`), todo o nada |
| `POST /tasks/:idTask/complete` | Marca la parte de un usuario; archiva si era la última |
| `GET /tasks` | Lista tareas, filtro opcional `?status=open\|archived` |
| `GET /users` | Usuarios con sus tareas pendientes |
| `GET /users/:idUser/tasks` | Tareas de un usuario y si completó su parte |
| `GET /tasks/:idTask` | Detalle de una tarea |
| `GET /tasks/:idTask/notifications` | Bitácora de intentos de notificación |

Formato de error único: `{ "error": { "code": "...", "message": "..." } }`.
Los 9 códigos están tabulados en `docs/api-spec.md`.

---

## Decisiones técnicas

**Idempotencia por restricción de base de datos.** El `UNIQUE(key, endpoint)` de
`idempotency_keys` es la primitiva de sincronización: el `INSERT` decide la
carrera. Quien la gana ejecuta; quien la pierde espera a que la respuesta quede
grabada y la replica con la cabecera `Idempotent-Replay: true`. Dos peticiones
simultáneas con la misma clave producen **una ejecución y dos respuestas
idénticas**, sin locks en memoria (que no sobrevivirían a varias instancias). El
body se hashea con las claves ordenadas, para que el orden de los campos no
cambie el hash. Las respuestas **5xx no se persisten**: se libera la clave para
que un reintento sea un reintento de verdad y no la repetición eterna del fallo.

**Archivado exactamente una vez.** Toda la decisión ocurre en un único `UPDATE`
condicional —`WHERE status = 'open' AND NOT EXISTS (asignaciones pendientes)`— y
solo archiva quien obtiene `affectedRows === 1`. El `NOT EXISTS` es
imprescindible: contando las pendientes con un `SELECT` previo, dos
transacciones concurrentes leerían el mismo snapshot de `REPEATABLE READ`, ambas
verían «queda 1» y **ninguna** archivaría. Dentro de un `UPDATE`, MySQL hace
lectura bloqueante y ve siempre el último commit.

**Dos fases separadas en `complete`.** Primero una transacción corta que valida y
marca la asignación; después, fuera de ella, el `UPDATE` de archivado. Todo junto
alargaría los bloqueos y abriría la puerta a interbloqueos sobre
`task_assignments`. La garantía vive en el propio `UPDATE`, no en la transacción.

**Notificaciones reintentables y en segundo plano.** Máximo 3 intentos con
backoff exponencial (1 s, 2 s). Reintenta ante 5xx o ausencia de respuesta;
**no** ante 4xx, porque repetir una petición mal formada daría el mismo error.
Cada intento se registra con `eventType`, `attemptNumber`, `timestamp`,
`httpStatus` (`null` si no hubo respuesta) y `success`. El envío no bloquea la
respuesta HTTP: en el peor caso los tres intentos suman ~18 s, y quien terminó su
parte merece un `200` inmediato. El resultado se consulta en el endpoint 9, que
existe justo para eso.

**Prisma con SQL crudo donde importa.** Prisma aporta migraciones y tipado; las
dos operaciones cuya corrección depende de la semántica exacta de MySQL
—archivado y reclamo del aviso de vencimiento— se escriben como `$executeRaw`
parametrizado.

---

## Supuestos ante ambigüedades

El enunciado no define estos casos (lista completa en `docs/api-spec.md`):

1. **Completar dos veces** devuelve `200`, no error: es el doble clic que
   menciona la sección de Confiabilidad.
2. **Asignar a una tarea archivada** → `409`; permitirlo dejaría una tarea
   archivada con partes pendientes.
3. **`assign` es todo o nada**: si un `userId` no existe, no se asigna ninguno.
4. **`userIds` duplicados** en el mismo body se deduplican sin error.
5. **Email único**, aunque el reto no lo pida: sin ello se registra dos veces a
   la misma persona.
6. **IDs no numéricos** (`/tasks/abc`) → `400`, no `404`: petición mal formada.
7. **`dueDate` no se exige futura**: registrar una tarea vencida es legítimo y el
   semáforo la marca en rojo.

---

## Mejora extra: alertas de vencimiento

**El problema.** El sistema solo reacciona a lo que ya pasó: avisa cuando la
tarea se archiva. Nadie se entera de que una tarea está *a punto* de vencer, que
es el único momento en que un aviso todavía puede cambiar el resultado.

**Qué se añadió.** Un campo opcional `dueDate`; un campo calculado `urgency` en
`GET /tasks` y `GET /tasks/:idTask` (`green` >48 h · `yellow` <48 h · `red` ya
vencida y abierta · `null` sin fecha o ya archivada); y un job periódico que
busca tareas abiertas que vencen dentro de la ventana de aviso y envía un evento
`task.due_soon` a `NOTIFY_URL` **reutilizando el mismo motor de reintentos y la
misma bitácora** que el archivado.

**Por qué así.** La deduplicación usa `dueSoonNotifiedAt`, reclamada con un
`UPDATE` condicional atómico —el mismo patrón que el archivado—, de modo que dos
pasadas solapadas del job o dos instancias del servidor no puedan duplicar el
aviso. Marcarlo en memoria del proceso se cae con la segunda instancia, y
consultar-y-luego-escribir tiene la carrera que ya se resolvió en el archivado.
Reutilizar el notificador en vez de escribir un segundo camino de envío hace que
el backoff, la política 4xx/5xx y el registro sean el mismo código ya probado.

**Frente a otras alternativas.** Pude haber puesto mejores alternativas mas sin embargo no contaba con el tiempo suficiente para implementarlas ya que se evaluaba la semana en donde la parte que mas tiempo llevaria es la para de QA para probar el funcionamiento correcto, ademas las mejoras mas completas requieren de data tangible porque de que serviria implementar una mejora si nadie de los clientes o usuarios la va a utilizar. *(Swagger UI no cuenta como la mejora: es documentación del proyecto.)*

---

## Recortes conscientes

- **Sin patrón outbox.** Si el proceso muere entre el archivado y el último
  reintento, esa notificación se pierde. Lo correcto sería escribir el evento en
  una tabla outbox dentro de la misma transacción y drenarla con un worker.
- **Sin autenticación.** No está en el enunciado: hoy cualquiera puede completar
  la parte de otro, porque `userId` viaja en el body y nadie verifica quién envía.
- **Sin paginación** en los listados: devuelven la colección completa.
- **Sin medición de cobertura.** Hay 131 tests sobre los 9 endpoints, la
  idempotencia, la concurrencia, los reintentos y el semáforo, pero no se fijó un
  umbral con `--coverage`.
- **El job usa `setInterval` dentro del proceso**, no un cron externo ni una cola.
  Suficiente para el alcance; con varias instancias el `UPDATE` condicional evita
  duplicados igualmente, pero no hay reintento de la pasada ni observabilidad.
- **Un hueco de test deliberado**: el bucle de dos rondas del middleware de
  idempotencia exige sincronizar el borrado de la fila con la ventana de espera,
  y el test resultante sería frágil.

---

## Despliegue

**Pendiente.** El proveedor elegido es **Hostinger**, con MySQL en el mismo
servidor. El despliegue no se ha realizado al momento de esta entrega.

- URL pública: `<pendiente>`
- Documentación interactiva: `<pendiente>/docs`

El código ya contempla producción: cierre ordenado ante `SIGTERM`/`SIGINT` que
deja terminar las peticiones en curso y libera el pool de MySQL, migraciones
aplicables con `npm run migrate`, y toda la configuración sensible fuera del
repositorio.

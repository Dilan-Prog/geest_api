const crypto = require("crypto");
const prisma = require("../db");
const { idempotencyKeyReused, idempotencyInProgress } = require("../errors");

const MAX_WAIT_MS = Number(process.env.IDEMPOTENCY_WAIT_MS || 8000);
const POLL_INTERVAL_MS = 40;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Serializa el body con las claves ordenadas para que { a:1, b:2 } y { b:2, a:1 }
 * produzcan el mismo hash. Sin esto, dos clientes que mandan lo mismo en distinto
 * orden serían tratados como peticiones diferentes.
 */
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

const hashBody = (body) =>
  crypto.createHash("sha256").update(stableStringify(body ?? {})).digest("hex");

/**
 * Idempotencia para endpoints POST.
 *
 * El UNIQUE(key, endpoint) de la tabla es la primitiva de sincronización: el INSERT
 * decide la carrera. Quien lo gana ejecuta la operación; quien lo pierde espera a
 * que la respuesta quede grabada y la replica. Así dos requests en paralelo con la
 * misma key producen exactamente una ejecución y dos respuestas idénticas.
 */
async function idempotency(req, res, next) {
  const key = req.get("Idempotency-Key");
  if (!key) return next();

  const endpoint = `${req.method} ${req.originalUrl.split("?")[0]}`;
  const requestHash = hashBody(req.body);

  // Hasta dos vueltas: si el dueño original falló con 5xx borra su fila,
  // y entonces esta petición puede tomar el relevo.
  for (let round = 0; round < 2; round++) {
    try {
      await prisma.idempotencyKey.create({ data: { key, endpoint, requestHash } });
      captureResponse(res, key, endpoint);
      return next();
    } catch (err) {
      if (err.code !== "P2002") throw err;
    }

    const replayed = await waitAndReplay(res, key, endpoint, requestHash);
    if (replayed) return;
    // La fila desapareció mientras esperábamos: reintentamos el INSERT.
  }

  throw idempotencyInProgress();
}

/** Espera a que el dueño de la key grabe su respuesta y la reenvía. */
async function waitAndReplay(res, key, endpoint, requestHash) {
  const deadline = Date.now() + MAX_WAIT_MS;

  while (Date.now() < deadline) {
    const record = await prisma.idempotencyKey.findUnique({
      where: { key_endpoint: { key, endpoint } },
    });

    if (!record) return false; // el dueño falló y liberó la key

    if (record.requestHash !== requestHash) throw idempotencyKeyReused();

    if (record.responseStatus !== null) {
      res.set("Idempotent-Replay", "true");
      res.status(record.responseStatus).json(JSON.parse(record.responseBody));
      return true;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw idempotencyInProgress();
}

/**
 * Intercepta res.json para guardar la respuesta junto a la key.
 * Los 5xx no se guardan: se libera la key para que el cliente pueda reintentar
 * de verdad en lugar de recibir el mismo fallo replicado para siempre.
 */
function captureResponse(res, key, endpoint) {
  const originalJson = res.json.bind(res);
  let captured;

  res.json = (body) => {
    captured = body;
    return originalJson(body);
  };

  res.on("finish", () => {
    const status = res.statusCode;
    const shouldPersist = status < 500 && captured !== undefined;

    const op = shouldPersist
      ? prisma.idempotencyKey.update({
          where: { key_endpoint: { key, endpoint } },
          data: { responseStatus: status, responseBody: JSON.stringify(captured) },
        })
      : prisma.idempotencyKey.deleteMany({ where: { key, endpoint } });

    op.catch((err) => console.error("[idempotency] persist failed", err));
  });
}

module.exports = { idempotency, hashBody, stableStringify };

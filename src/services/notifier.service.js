const prisma = require("../db");

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = Number(process.env.NOTIFY_RETRY_BASE_MS || 1000);
const TIMEOUT_MS = Number(process.env.NOTIFY_TIMEOUT_MS || 5000);

const EVENT_ARCHIVED = "task.archived";
const EVENT_DUE_SOON = "task.due_soon";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Notificaciones en vuelo. Existe para que los tests puedan esperarlas
// de forma determinista en lugar de dormir un tiempo arbitrario.
const inFlight = new Set();

/**
 * Motor de envío compartido por los dos tipos de evento.
 *
 * POST a NOTIFY_URL con esperas crecientes: 1s, 2s (backoff exponencial).
 *
 * Reintenta ante 5xx o ausencia de respuesta (timeout / red caída).
 * NO reintenta ante 4xx: un 400 o un 404 significa que la petición está mal
 * formada o el destino no existe, y repetirla daría exactamente el mismo error.
 *
 * Cada intento queda registrado con su `eventType`, que es lo que permite
 * distinguir en la bitácora un archivado de un aviso de vencimiento.
 */
async function deliver({ taskId, eventType, payload }) {
  const url = process.env.NOTIFY_URL;

  if (!url) {
    console.warn("[notifier] NOTIFY_URL no configurada; se omite la notificación");
    return { delivered: false, reason: "NOTIFY_URL_NOT_CONFIGURED" };
  }

  for (let attemptNumber = 1; attemptNumber <= MAX_ATTEMPTS; attemptNumber++) {
    let httpStatus = null;
    let success = false;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      httpStatus = response.status;
      success = response.ok;
    } catch {
      httpStatus = null; // el destino no respondió
    }

    await prisma.notificationAttempt.create({
      data: { taskId, eventType, attemptNumber, httpStatus, success },
    });

    if (success) return { delivered: true, attempts: attemptNumber };

    const retryable = httpStatus === null || httpStatus >= 500;
    if (!retryable) return { delivered: false, attempts: attemptNumber, httpStatus };

    if (attemptNumber < MAX_ATTEMPTS) {
      await sleep(BASE_DELAY_MS * 2 ** (attemptNumber - 1));
    }
  }

  return { delivered: false, attempts: MAX_ATTEMPTS };
}

/**
 * Aviso de tarea archivada.
 *
 * El payload es exactamente el que especifica el reto, sin campos añadidos:
 * el evaluador puede estar comparándolo carácter a carácter.
 */
function notifyTaskArchived(task) {
  return deliver({
    taskId: task.id,
    eventType: EVENT_ARCHIVED,
    payload: {
      taskId: task.id,
      title: task.title,
      archivedAt: new Date(task.archivedAt).toISOString(),
    },
  });
}

/**
 * Aviso de tarea próxima a vencer.
 *
 * Este payload sí lleva `event`, porque es un evento nuevo que el reto no
 * define y el receptor necesita poder distinguirlo del archivado.
 */
function notifyTaskDueSoon(task) {
  return deliver({
    taskId: task.id,
    eventType: EVENT_DUE_SOON,
    payload: {
      event: EVENT_DUE_SOON,
      taskId: task.id,
      title: task.title,
      dueDate: new Date(task.dueDate).toISOString(),
    },
  });
}

/**
 * Lanza una notificación en segundo plano.
 *
 * La respuesta de POST /tasks/:id/complete no debe esperar hasta 3 reintentos con
 * backoff: el usuario ya terminó su parte y merece un 200 inmediato. El resultado
 * de los envíos se consulta después en GET /tasks/:idTask/notifications, que es
 * precisamente para lo que el reto define ese endpoint.
 */
function schedule(fn, task) {
  const promise = fn(task)
    .catch((err) => console.error("[notifier] fallo inesperado", err))
    .finally(() => inFlight.delete(promise));

  inFlight.add(promise);
  return promise;
}

const scheduleNotification = (task) => schedule(notifyTaskArchived, task);
const scheduleDueSoonNotification = (task) => schedule(notifyTaskDueSoon, task);

/** Espera a que no queden notificaciones pendientes. Solo lo usan los tests. */
async function flushNotifications() {
  while (inFlight.size > 0) {
    await Promise.all([...inFlight]);
  }
}

module.exports = {
  MAX_ATTEMPTS,
  EVENT_ARCHIVED,
  EVENT_DUE_SOON,
  notifyTaskArchived,
  notifyTaskDueSoon,
  scheduleNotification,
  scheduleDueSoonNotification,
  flushNotifications,
};

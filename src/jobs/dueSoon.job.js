const prisma = require("../db");
const { notifyTaskDueSoon } = require("../services/notifier.service");

const HOUR_MS = 60 * 60 * 1000;

const DUE_SOON_WINDOW_MS = Number(process.env.DUE_SOON_WINDOW_HOURS || 24) * HOUR_MS;
const INTERVAL_MS = Number(process.env.DUE_SOON_INTERVAL_MS || 5 * 60 * 1000);

/**
 * Reclama una tarea para notificar, de forma atómica.
 *
 * Mismo patrón que el archivado: un UPDATE condicional cuyo número de filas
 * afectadas dice si *esta* ejecución fue la que ganó. Sin esto, dos pasadas
 * solapadas del job —o dos instancias del servidor— mandarían el mismo aviso
 * dos veces.
 *
 * `dueSoonNotifiedAt IS NULL` es el candado. Una vez puesto, ninguna pasada
 * posterior vuelve a reclamar la tarea.
 *
 * @returns {boolean} true solo para quien reclamó el aviso.
 */
async function claimDueSoon(taskId, now) {
  const affectedRows = await prisma.$executeRaw`
    UPDATE tasks
       SET dueSoonNotifiedAt = ${now}
     WHERE id = ${taskId}
       AND status = 'open'
       AND dueSoonNotifiedAt IS NULL
  `;

  return affectedRows === 1;
}

/**
 * Una pasada del job.
 *
 * Busca tareas abiertas, con fecha límite, que entren en la ventana de aviso y
 * a las que todavía no se les haya notificado. Por cada una: reclama y envía.
 *
 * Es idempotente y seguro de ejecutar en paralelo consigo mismo.
 *
 * @returns {{scanned:number, notified:number}}
 */
async function runDueSoonScan(now = new Date()) {
  const threshold = new Date(now.getTime() + DUE_SOON_WINDOW_MS);

  const candidates = await prisma.task.findMany({
    where: {
      status: "open",
      dueDate: { not: null, lte: threshold },
      dueSoonNotifiedAt: null,
    },
    select: { id: true, title: true, dueDate: true },
    orderBy: { dueDate: "asc" },
  });

  let notified = 0;

  for (const task of candidates) {
    const claimed = await claimDueSoon(task.id, now);
    if (!claimed) continue;

    // En serie y con await, a diferencia del archivado: aquí no hay ningún
    // cliente HTTP esperando respuesta, y disparar N notificaciones a la vez
    // contra el mismo destino sería una ráfaga innecesaria.
    await notifyTaskDueSoon(task);
    notified += 1;
  }

  return { scanned: candidates.length, notified };
}

let timer = null;

/** Arranca el job periódico. Devuelve una función para detenerlo. */
function startDueSoonJob({ intervalMs = INTERVAL_MS } = {}) {
  if (timer) return stopDueSoonJob;

  const tick = async () => {
    try {
      const { notified } = await runDueSoonScan();
      if (notified > 0) {
        console.log(`[dueSoon] ${notified} aviso(s) de vencimiento enviados`);
      }
    } catch (err) {
      // Un fallo en una pasada no debe matar el intervalo: la siguiente reintenta.
      console.error("[dueSoon] la pasada falló", err);
    }
  };

  timer = setInterval(tick, intervalMs);
  // No mantiene vivo el proceso solo por existir el temporizador.
  timer.unref?.();

  tick(); // primera pasada inmediata, sin esperar al primer intervalo

  const cadence =
    intervalMs >= 1000 ? `${Math.round(intervalMs / 1000)}s` : `${intervalMs}ms`;
  console.log(`[dueSoon] job activo cada ${cadence}`);

  return stopDueSoonJob;
}

function stopDueSoonJob() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  DUE_SOON_WINDOW_MS,
  claimDueSoon,
  runDueSoonScan,
  startDueSoonJob,
  stopDueSoonJob,
};

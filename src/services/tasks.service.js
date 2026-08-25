const prisma = require("../db");
const {
  taskNotFound,
  userNotFound,
  usersNotFound,
  taskArchived,
  userNotAssigned,
} = require("../errors");
const { scheduleNotification } = require("./notifier.service");

const HOUR_MS = 60 * 60 * 1000;
const URGENCY_WARNING_MS = 48 * HOUR_MS;

const TASK_WITH_ASSIGNEES = {
  assignments: {
    orderBy: { userId: "asc" },
    include: { user: true },
  },
};

/**
 * Semáforo de vencimiento, calculado al vuelo — nunca almacenado.
 *
 * Guardarlo en una columna obligaría a recalcularlo con un job para que no
 * quedara obsoleto; derivarlo de `dueDate` en cada lectura es siempre exacto
 * y cuesta una resta.
 *
 *   green   faltan más de 48 h
 *   yellow  faltan menos de 48 h
 *   red     ya venció y la tarea sigue abierta
 *   null    sin fecha límite, o ya archivada
 */
function computeUrgency(task, now = new Date()) {
  if (!task.dueDate) return null;
  if (task.status === "archived") return null;

  const remaining = new Date(task.dueDate).getTime() - now.getTime();

  if (remaining < 0) return "red";
  if (remaining <= URGENCY_WARNING_MS) return "yellow";
  return "green";
}

/** Forma canónica de una tarea en las respuestas. Un solo lugar para cambiarla. */
function taskDTO(task, now = new Date()) {
  const assignments = task.assignments ?? [];

  return {
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    createdAt: task.createdAt,
    archivedAt: task.archivedAt,
    dueDate: task.dueDate ?? null,
    urgency: computeUrgency(task, now),
    progress: {
      completed: assignments.filter((a) => a.completed).length,
      total: assignments.length,
    },
    assignees: assignments.map((a) => ({
      userId: a.userId,
      name: a.user.name,
      lastName: a.user.lastName,
      email: a.user.email,
      completed: a.completed,
      completedAt: a.completedAt,
    })),
  };
}

async function createTask({ title, description, dueDate }) {
  const task = await prisma.task.create({
    data: { title, description, dueDate },
  });
  return taskDTO({ ...task, assignments: [] });
}

async function listTasks(status) {
  const tasks = await prisma.task.findMany({
    where: status ? { status } : undefined,
    orderBy: { id: "asc" },
    include: TASK_WITH_ASSIGNEES,
  });

  // Un único `now` para toda la lista: dos tareas con el mismo dueDate no pueden
  // salir con urgencias distintas porque el reloj avanzó a mitad del map.
  const now = new Date();
  return tasks.map((t) => taskDTO(t, now));
}

async function getTask(taskId) {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: TASK_WITH_ASSIGNEES,
  });
  if (!task) throw taskNotFound(taskId);
  return taskDTO(task);
}

/**
 * Asigna usuarios a una tarea.
 *
 * Todo o nada: si un solo userId no existe, no se asigna ninguno. Una asignación
 * parcial silenciosa dejaría al cliente sin saber qué se aplicó realmente.
 *
 * skipDuplicates + UNIQUE(taskId, userId) hacen que reasignar a alguien ya
 * asignado sea inofensivo, incluso con dos requests simultáneos.
 */
async function assignUsers(taskId, userIds) {
  return prisma.$transaction(async (tx) => {
    const task = await tx.task.findUnique({ where: { id: taskId } });
    if (!task) throw taskNotFound(taskId);
    if (task.status === "archived") throw taskArchived(taskId);

    const users = await tx.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true },
    });

    if (users.length !== userIds.length) {
      const found = new Set(users.map((u) => u.id));
      throw usersNotFound(userIds.filter((id) => !found.has(id)));
    }

    const existing = await tx.taskAssignment.findMany({
      where: { taskId, userId: { in: userIds } },
      select: { userId: true },
    });
    const alreadyAssigned = new Set(existing.map((a) => a.userId));
    const toAssign = userIds.filter((id) => !alreadyAssigned.has(id));

    if (toAssign.length > 0) {
      await tx.taskAssignment.createMany({
        data: toAssign.map((userId) => ({ taskId, userId })),
        skipDuplicates: true,
      });
    }

    return {
      message: "Users assigned successfully",
      taskId,
      assigned: toAssign,
      alreadyAssigned: [...alreadyAssigned],
    };
  });
}

/**
 * Archiva la tarea si —y solo si— ya no le quedan partes pendientes.
 *
 * Toda la decisión ocurre en UNA sentencia atómica. El `NOT EXISTS` no es
 * decorativo: sin él, dos transacciones concurrentes pueden contar las
 * asignaciones pendientes contra el mismo snapshot de REPEATABLE READ, ver
 * ambas "queda 1" y no archivar ninguna. Dentro de un UPDATE, en cambio, MySQL
 * hace lectura bloqueante y ve siempre el último commit.
 *
 * `WHERE status = 'open'` es el segundo cierre: aunque dos peticiones lleguen a
 * ejecutar este UPDATE a la vez, InnoDB serializa la escritura sobre esa fila y
 * la segunda ya no encuentra 'open'.
 *
 * @returns {boolean} true solo para la llamada que efectivamente archivó.
 */
async function archiveIfComplete(taskId, archivedAt) {
  const affectedRows = await prisma.$executeRaw`
    UPDATE tasks t
       SET t.status = 'archived',
           t.archivedAt = ${archivedAt}
     WHERE t.id = ${taskId}
       AND t.status = 'open'
       AND NOT EXISTS (
             SELECT 1 FROM task_assignments a
              WHERE a.taskId = t.id AND a.completed = 0
           )
  `;

  return affectedRows === 1;
}

/**
 * Marca la parte de un usuario como terminada y, si era el último, archiva.
 *
 * Dos fases deliberadamente separadas:
 *
 *   1. Transacción corta: validar y marcar la asignación como completada.
 *   2. Fuera de la transacción: el UPDATE condicional de archivado.
 *
 * Meter la fase 2 dentro de la transacción de la fase 1 alargaría los bloqueos
 * y abriría la puerta a interbloqueos entre dos peticiones que se esperan
 * mutuamente sobre filas de `task_assignments`. Separadas, cada bloqueo dura lo
 * mínimo y el archivado sigue siendo exactamente una vez, porque esa garantía
 * vive en el propio UPDATE y no en la transacción que lo rodea.
 */
async function completeTaskPart(taskId, userId) {
  await prisma.$transaction(async (tx) => {
    const task = await tx.task.findUnique({ where: { id: taskId } });
    if (!task) throw taskNotFound(taskId);

    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) throw userNotFound(userId);

    const assignment = await tx.taskAssignment.findUnique({
      where: { taskId_userId: { taskId, userId } },
    });
    if (!assignment) throw userNotAssigned(userId, taskId);

    // Supuesto: completar dos veces no es un error. Es el doble clic que
    // menciona la sección de Confiabilidad del reto.
    if (!assignment.completed) {
      await tx.taskAssignment.update({
        where: { id: assignment.id },
        data: { completed: true, completedAt: new Date() },
      });
    }
  });

  const archivedAt = new Date();
  const justArchived = await archiveIfComplete(taskId, archivedAt);

  const task = await prisma.task.findUnique({ where: { id: taskId } });
  const remaining = await prisma.taskAssignment.count({
    where: { taskId, completed: false },
  });

  if (justArchived) {
    scheduleNotification({ id: taskId, title: task.title, archivedAt });
  }

  return {
    message: "Task part completed successfully",
    taskId,
    userId,
    completed: true,
    taskStatus: task.status,
    archivedAt: task.archivedAt ?? null,
    remainingUsers: remaining,
  };
}

async function listNotifications(taskId) {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) throw taskNotFound(taskId);

  const attempts = await prisma.notificationAttempt.findMany({
    where: { taskId },
    orderBy: [{ eventType: "asc" }, { attemptNumber: "asc" }],
    select: {
      eventType: true,
      attemptNumber: true,
      timestamp: true,
      httpStatus: true,
      success: true,
    },
  });

  return { taskId, attempts };
}

module.exports = {
  URGENCY_WARNING_MS,
  computeUrgency,
  taskDTO,
  archiveIfComplete,
  createTask,
  listTasks,
  getTask,
  assignUsers,
  completeTaskPart,
  listNotifications,
};

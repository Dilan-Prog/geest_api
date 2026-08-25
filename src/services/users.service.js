const prisma = require("../db");
const { userNotFound, emailAlreadyExists } = require("../errors");

const userDTO = (user) => ({
  id: user.id,
  name: user.name,
  lastName: user.lastName,
  email: user.email,
  createdAt: user.createdAt,
});

async function createUser({ name, lastName, email }) {
  try {
    const user = await prisma.user.create({ data: { name, lastName, email } });
    return userDTO(user);
  } catch (err) {
    // P2002 = violación de UNIQUE. Confiamos en la restricción de la BD en vez de
    // consultar antes de insertar: un findUnique previo tiene una condición de
    // carrera con otro request que inserte el mismo email en ese instante.
    if (err.code === "P2002") throw emailAlreadyExists(email);
    throw err;
  }
}

/** Usuarios con sus tareas pendientes: asignaciones que aún no han completado. */
async function listUsers() {
  const users = await prisma.user.findMany({
    orderBy: { id: "asc" },
    include: {
      assignments: {
        where: { completed: false },
        orderBy: { taskId: "asc" },
        include: { task: true },
      },
    },
  });

  return users.map((user) => ({
    ...userDTO(user),
    pendingTasks: user.assignments.map((a) => ({
      taskId: a.taskId,
      title: a.task.title,
      status: a.task.status,
    })),
  }));
}

/** Todas las tareas del usuario, indicando si completó su parte en cada una. */
async function listUserTasks(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      assignments: {
        orderBy: { taskId: "asc" },
        include: { task: true },
      },
    },
  });
  if (!user) throw userNotFound(userId);

  return {
    userId,
    tasks: user.assignments.map((a) => ({
      id: a.task.id,
      title: a.task.title,
      description: a.task.description,
      status: a.task.status,
      completed: a.completed,
      completedAt: a.completedAt,
    })),
  };
}

module.exports = { userDTO, createUser, listUsers, listUserTasks };

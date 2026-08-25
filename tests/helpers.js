const http = require("http");
const request = require("supertest");

const app = require("../src/app");
const prisma = require("../src/db");
const { flushNotifications } = require("../src/services/notifier.service");

const api = () => request(app);

/**
 * Deja la base de datos vacía respetando el orden de las claves foráneas.
 *
 * El flush primero no es opcional: las notificaciones de archivado se lanzan en
 * segundo plano, y una que siguiera en vuelo escribiría en `notification_attempts`
 * justo después del borrado, reventando la clave foránea en el test siguiente.
 */
async function resetDb() {
  await flushNotifications();
  await prisma.notificationAttempt.deleteMany();
  await prisma.taskAssignment.deleteMany();
  await prisma.task.deleteMany();
  await prisma.user.deleteMany();
  await prisma.idempotencyKey.deleteMany();
}

let userSeq = 0;

async function createUser(overrides = {}) {
  userSeq += 1;
  const res = await api()
    .post("/users")
    .send({
      name: `User${userSeq}`,
      lastName: "Test",
      email: `user${userSeq}.${Date.now()}@geest.test`,
      ...overrides,
    });
  return res.body;
}

async function createTask(overrides = {}) {
  const res = await api()
    .post("/tasks")
    .send({ title: "Tarea de prueba", ...overrides });
  return res.body;
}

/**
 * Servidor HTTP de mentira que hace de NOTIFY_URL.
 *
 * `statuses` es la secuencia de respuestas: un número es un status HTTP,
 * y `"timeout"` simula un destino que nunca responde.
 */
function startWebhook(statuses = [200]) {
  const received = [];
  let call = 0;

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push(JSON.parse(body || "{}"));
      const behaviour = statuses[Math.min(call, statuses.length - 1)];
      call += 1;

      if (behaviour === "timeout") return; // nunca responde
      res.writeHead(behaviour).end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/hook`,
        received,
        callCount: () => call,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections?.();
            server.close(r);
          }),
      });
    });
  });
}

module.exports = {
  api,
  prisma,
  resetDb,
  createUser,
  createTask,
  startWebhook,
  flushNotifications,
};

const {
  api,
  prisma,
  resetDb,
  createUser,
  createTask,
  startWebhook,
  flushNotifications,
} = require("./helpers");
const { archiveIfComplete } = require("../src/services/tasks.service");

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

// ---------------------------------------------------------------------------
// 1. Idempotencia
// ---------------------------------------------------------------------------
describe("Idempotency-Key", () => {
  it("ejecuta una sola vez dos POST /users secuenciales con la misma key", async () => {
    const body = { name: "Ana", lastName: "Torres", email: "idem@geest.com" };

    const first = await api().post("/users").set("Idempotency-Key", "k-1").send(body);
    const second = await api().post("/users").set("Idempotency-Key", "k-1").send(body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(await prisma.user.count()).toBe(1);
  });

  it("ejecuta una sola vez dos POST /users en PARALELO con la misma key", async () => {
    const body = { name: "Ana", lastName: "Torres", email: "race@geest.com" };
    const send = () => api().post("/users").set("Idempotency-Key", "k-race").send(body);

    const [a, b] = await Promise.all([send(), send()]);

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body).toEqual(b.body);
    expect(await prisma.user.count()).toBe(1);

    // Exactamente una de las dos fue una réplica de la otra.
    const replays = [a, b].filter((r) => r.headers["idempotent-replay"] === "true");
    expect(replays).toHaveLength(1);
  });

  it("no duplica tareas con doble clic sobre POST /tasks", async () => {
    const body = { title: "Doble clic" };
    const send = () => api().post("/tasks").set("Idempotency-Key", "k-task").send(body);

    const [a, b] = await Promise.all([send(), send()]);

    expect(a.body.id).toBe(b.body.id);
    expect(await prisma.task.count()).toBe(1);
  });

  it("rechaza reutilizar la key con un body distinto", async () => {
    await api()
      .post("/tasks")
      .set("Idempotency-Key", "k-reuse")
      .send({ title: "Original" });

    const res = await api()
      .post("/tasks")
      .set("Idempotency-Key", "k-reuse")
      .send({ title: "Otro cuerpo" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("la misma key en endpoints distintos no colisiona", async () => {
    const user = await api()
      .post("/users")
      .set("Idempotency-Key", "shared")
      .send({ name: "Ana", lastName: "T", email: "shared@geest.com" });
    const task = await api()
      .post("/tasks")
      .set("Idempotency-Key", "shared")
      .send({ title: "Tarea" });

    expect(user.status).toBe(201);
    expect(task.status).toBe(201);
  });

  it("el orden de las claves del body no afecta al hash", async () => {
    const a = await api()
      .post("/users")
      .set("Idempotency-Key", "k-order")
      .send({ name: "Ana", lastName: "Torres", email: "order@geest.com" });
    const b = await api()
      .post("/users")
      .set("Idempotency-Key", "k-order")
      .send({ email: "order@geest.com", lastName: "Torres", name: "Ana" });

    expect(b.status).toBe(201);
    expect(b.body).toEqual(a.body);
  });

  it("sin el header, cada request se procesa por separado", async () => {
    const body = { title: "Sin key" };
    await api().post("/tasks").send(body);
    await api().post("/tasks").send(body);

    expect(await prisma.task.count()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 2. Archivado sin duplicados
// ---------------------------------------------------------------------------
describe("Archivado exactamente una vez", () => {
  it("dos usuarios completando a la vez archivan y notifican una sola vez", async () => {
    const hook = await startWebhook([200]);
    process.env.NOTIFY_URL = hook.url;

    try {
      const [a, b] = [await createUser(), await createUser()];
      const task = await createTask({ title: "Carrera" });
      await api().post(`/tasks/${task.id}/assign`).send({ userIds: [a.id, b.id] });

      const [r1, r2] = await Promise.all([
        api().post(`/tasks/${task.id}/complete`).send({ userId: a.id }),
        api().post(`/tasks/${task.id}/complete`).send({ userId: b.id }),
      ]);

      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);

      await flushNotifications();

      const stored = await prisma.task.findUnique({ where: { id: task.id } });
      expect(stored.status).toBe("archived");

      // Exactamente una notificación entregada, exactamente un intento registrado.
      expect(hook.received).toHaveLength(1);
      expect(hook.received[0]).toMatchObject({ taskId: task.id, title: "Carrera" });

      const attempts = await prisma.notificationAttempt.findMany({
        where: { taskId: task.id },
      });
      expect(attempts).toHaveLength(1);
      expect(attempts[0].eventType).toBe("task.archived");
    } finally {
      await hook.close();
      process.env.NOTIFY_URL = "";
    }
  });

  it("archiveIfComplete devuelve true una sola vez ante 5 llamadas en paralelo", async () => {
    const user = await createUser();
    const task = await createTask();
    await api().post(`/tasks/${task.id}/assign`).send({ userIds: [user.id] });
    await prisma.taskAssignment.updateMany({
      where: { taskId: task.id },
      data: { completed: true, completedAt: new Date() },
    });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => archiveIfComplete(task.id, new Date()))
    );

    // El UPDATE condicional es el árbitro: solo una llamada afecta a 1 fila.
    expect(results.filter(Boolean)).toHaveLength(1);

    const stored = await prisma.task.findUnique({ where: { id: task.id } });
    expect(stored.status).toBe("archived");
  });

  it("archiveIfComplete no archiva mientras quede una parte pendiente", async () => {
    const [a, b] = [await createUser(), await createUser()];
    const task = await createTask();
    await api().post(`/tasks/${task.id}/assign`).send({ userIds: [a.id, b.id] });
    await api().post(`/tasks/${task.id}/complete`).send({ userId: a.id });

    expect(await archiveIfComplete(task.id, new Date())).toBe(false);

    const stored = await prisma.task.findUnique({ where: { id: task.id } });
    expect(stored.status).toBe("open");
  });

  it("el doble clic sobre el último usuario no genera una segunda notificación", async () => {
    const hook = await startWebhook([200]);
    process.env.NOTIFY_URL = hook.url;

    try {
      const user = await createUser();
      const task = await createTask();
      await api().post(`/tasks/${task.id}/assign`).send({ userIds: [user.id] });

      await api().post(`/tasks/${task.id}/complete`).send({ userId: user.id });
      await api().post(`/tasks/${task.id}/complete`).send({ userId: user.id });

      await flushNotifications();

      expect(hook.received).toHaveLength(1);
    } finally {
      await hook.close();
      process.env.NOTIFY_URL = "";
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Notificaciones con reintentos
// ---------------------------------------------------------------------------
describe("Notificaciones con reintentos", () => {
  async function archiveTask(title = "Notificable") {
    const user = await createUser();
    const task = await createTask({ title });
    await api().post(`/tasks/${task.id}/assign`).send({ userIds: [user.id] });
    await api().post(`/tasks/${task.id}/complete`).send({ userId: user.id });
    await flushNotifications();
    return task;
  }

  it("envía el payload exigido por el reto", async () => {
    const hook = await startWebhook([200]);
    process.env.NOTIFY_URL = hook.url;

    try {
      const task = await archiveTask("Payload");

      expect(hook.received[0]).toEqual({
        taskId: task.id,
        title: "Payload",
        archivedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
      });
    } finally {
      await hook.close();
      process.env.NOTIFY_URL = "";
    }
  });

  it("reintenta tras un 5xx y registra cada intento", async () => {
    const hook = await startWebhook([500, 503, 200]);
    process.env.NOTIFY_URL = hook.url;

    try {
      const task = await archiveTask();

      const res = await api().get(`/tasks/${task.id}/notifications`);

      expect(res.status).toBe(200);
      expect(res.body.attempts).toHaveLength(3);
      expect(res.body.attempts.map((a) => a.attemptNumber)).toEqual([1, 2, 3]);
      expect(res.body.attempts.map((a) => a.httpStatus)).toEqual([500, 503, 200]);
      expect(res.body.attempts.map((a) => a.success)).toEqual([false, false, true]);
      res.body.attempts.forEach((a) => expect(a.timestamp).toBeDefined());
    } finally {
      await hook.close();
      process.env.NOTIFY_URL = "";
    }
  });

  it("se detiene en 3 intentos aunque todos fallen", async () => {
    const hook = await startWebhook([500]);
    process.env.NOTIFY_URL = hook.url;

    try {
      const task = await archiveTask();

      const res = await api().get(`/tasks/${task.id}/notifications`);

      expect(res.body.attempts).toHaveLength(3);
      expect(res.body.attempts.every((a) => a.success === false)).toBe(true);
      expect(hook.callCount()).toBe(3);
    } finally {
      await hook.close();
      process.env.NOTIFY_URL = "";
    }
  });

  it("registra httpStatus null cuando el destino no responde", async () => {
    const hook = await startWebhook(["timeout"]);
    process.env.NOTIFY_URL = hook.url;

    try {
      const task = await archiveTask();

      const res = await api().get(`/tasks/${task.id}/notifications`);

      expect(res.body.attempts).toHaveLength(3);
      expect(res.body.attempts.every((a) => a.httpStatus === null)).toBe(true);
    } finally {
      await hook.close();
      process.env.NOTIFY_URL = "";
    }
  });

  it("no reintenta ante un 4xx: repetirlo daría el mismo error", async () => {
    const hook = await startWebhook([400]);
    process.env.NOTIFY_URL = hook.url;

    try {
      const task = await archiveTask();

      const res = await api().get(`/tasks/${task.id}/notifications`);

      expect(res.body.attempts).toHaveLength(1);
      expect(res.body.attempts[0].httpStatus).toBe(400);
    } finally {
      await hook.close();
      process.env.NOTIFY_URL = "";
    }
  });

  it("una tarea nunca archivada no tiene intentos", async () => {
    const task = await createTask();
    const res = await api().get(`/tasks/${task.id}/notifications`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ taskId: task.id, attempts: [] });
  });

  it("devuelve 404 si la tarea no existe", async () => {
    const res = await api().get("/tasks/999999/notifications");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("TASK_NOT_FOUND");
  });
});

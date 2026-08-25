const {
  api,
  prisma,
  resetDb,
  createUser,
  createTask,
  startWebhook,
  flushNotifications,
} = require("./helpers");
const usersService = require("../src/services/users.service");
const { computeUrgency, URGENCY_WARNING_MS } = require("../src/services/tasks.service");
const {
  startDueSoonJob,
  stopDueSoonJob,
  runDueSoonScan,
} = require("../src/jobs/dueSoon.job");

const HOUR = 60 * 60 * 1000;
const inHours = (h) => new Date(Date.now() + h * HOUR).toISOString();

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

// ---------------------------------------------------------------------------
// Errores de transporte: todo debe salir con el formato { error: { code, message } }
// ---------------------------------------------------------------------------
describe("Errores de transporte", () => {
  it("un body por encima del límite devuelve 413, no 500", async () => {
    // Regresión: sin la rama `entity.too.large` en el errorHandler, este caso
    // caía al 500 genérico y el cliente creía que el fallo era del servidor.
    const res = await api()
      .post("/tasks")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ title: "grande", description: "x".repeat(200_000) }));

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("JSON malformado devuelve 400 VALIDATION_ERROR", async () => {
    const res = await api()
      .post("/users")
      .set("Content-Type", "application/json")
      .send('{"name":');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.message).toMatch(/JSON/i);
  });

  it.each([
    ["GET", "/noexiste"],
    ["DELETE", "/tasks/1"],
    ["PUT", "/users/1"],
  ])("%s %s devuelve 404 ROUTE_NOT_FOUND", async (method, path) => {
    const res = await api()[method.toLowerCase()](path);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("ROUTE_NOT_FOUND");
  });

  it("GET /health responde", async () => {
    const res = await api().get("/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(typeof res.body.uptime).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Idempotencia en los endpoints que faltaban
// ---------------------------------------------------------------------------
describe("Idempotencia en assign y complete", () => {
  it("dos assign en paralelo con la misma key asignan una sola vez", async () => {
    const [a, b] = [await createUser(), await createUser()];
    const task = await createTask();

    const send = () =>
      api()
        .post(`/tasks/${task.id}/assign`)
        .set("Idempotency-Key", "assign-race")
        .send({ userIds: [a.id, b.id] });

    const [r1, r2] = await Promise.all([send(), send()]);

    expect(r1.status).toBe(200);
    expect(r2.body).toEqual(r1.body);

    const count = await prisma.taskAssignment.count({ where: { taskId: task.id } });
    expect(count).toBe(2);

    const replays = [r1, r2].filter((r) => r.headers["idempotent-replay"] === "true");
    expect(replays).toHaveLength(1);
  });

  it("dos complete en paralelo con la misma key archivan y notifican una vez", async () => {
    const hook = await startWebhook([200]);
    process.env.NOTIFY_URL = hook.url;

    try {
      const user = await createUser();
      const task = await createTask();
      await api().post(`/tasks/${task.id}/assign`).send({ userIds: [user.id] });

      const send = () =>
        api()
          .post(`/tasks/${task.id}/complete`)
          .set("Idempotency-Key", "complete-race")
          .send({ userId: user.id });

      const [r1, r2] = await Promise.all([send(), send()]);

      expect(r1.body).toEqual(r2.body);
      expect(r1.body.taskStatus).toBe("archived");

      await flushNotifications();
      expect(hook.received).toHaveLength(1);
    } finally {
      await hook.close();
      process.env.NOTIFY_URL = "";
    }
  });

  it("la misma key en /complete de dos tareas distintas no colisiona", async () => {
    const user = await createUser();
    const t1 = await createTask();
    const t2 = await createTask();
    await api().post(`/tasks/${t1.id}/assign`).send({ userIds: [user.id] });
    await api().post(`/tasks/${t2.id}/assign`).send({ userIds: [user.id] });

    const r1 = await api()
      .post(`/tasks/${t1.id}/complete`)
      .set("Idempotency-Key", "misma")
      .send({ userId: user.id });
    const r2 = await api()
      .post(`/tasks/${t2.id}/complete`)
      .set("Idempotency-Key", "misma")
      .send({ userId: user.id });

    expect(r1.body.taskId).toBe(t1.id);
    expect(r2.body.taskId).toBe(t2.id);
  });
});

// ---------------------------------------------------------------------------
// Caminos de error del middleware de idempotencia
// ---------------------------------------------------------------------------
describe("Idempotencia: caminos de error", () => {
  it("un 5xx libera la key para que el reintento vuelva a ejecutar", async () => {
    const spy = jest
      .spyOn(usersService, "createUser")
      .mockRejectedValueOnce(new Error("fallo simulado"));

    const body = { name: "Ana", lastName: "Torres", email: "libera@geest.com" };

    const fallo = await api().post("/users").set("Idempotency-Key", "k-5xx").send(body);
    expect(fallo.status).toBe(500);

    // La fila se borra en el evento 'finish', que puede llegar justo después.
    await new Promise((r) => setTimeout(r, 100));
    expect(await prisma.idempotencyKey.count({ where: { key: "k-5xx" } })).toBe(0);

    // El reintento con la misma key ejecuta de verdad, no replica el 500.
    const ok = await api().post("/users").set("Idempotency-Key", "k-5xx").send(body);
    expect(ok.status).toBe(201);
    expect(ok.body.email).toBe("libera@geest.com");

    spy.mockRestore();
  });

  it("replica también una respuesta de error por debajo de 500", async () => {
    const body = { name: "Ana", lastName: "T", email: "dup-idem@geest.com" };
    await api().post("/users").send(body); // ocupa el email

    const primera = await api().post("/users").set("Idempotency-Key", "k-409").send(body);
    const segunda = await api().post("/users").set("Idempotency-Key", "k-409").send(body);

    expect(primera.status).toBe(409);
    expect(segunda.status).toBe(409);
    expect(segunda.body).toEqual(primera.body);
    expect(segunda.headers["idempotent-replay"]).toBe("true");
  });

  it("devuelve IDEMPOTENCY_IN_PROGRESS si la original nunca termina", async () => {
    const body = { title: "Colgada" };
    const endpoint = "POST /tasks";
    const { hashBody } = require("../src/middleware/idempotency");

    // Simula una petición que arrancó y murió sin grabar su respuesta.
    await prisma.idempotencyKey.create({
      data: {
        key: "k-colgada",
        endpoint,
        requestHash: hashBody(body),
        responseStatus: null,
      },
    });

    const res = await api()
      .post("/tasks")
      .set("Idempotency-Key", "k-colgada")
      .send(body);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IDEMPOTENCY_IN_PROGRESS");
  });
});

// ---------------------------------------------------------------------------
// Validaciones que no se ejercitaban
// ---------------------------------------------------------------------------
describe("Validaciones límite", () => {
  it("normaliza el email a minúsculas", async () => {
    const res = await api()
      .post("/users")
      .send({ name: "Ana", lastName: "T", email: "Ana.Torres@GEEST.com" });

    expect(res.status).toBe(201);
    expect(res.body.email).toBe("ana.torres@geest.com");
  });

  it("detecta el duplicado aunque cambie el uso de mayúsculas", async () => {
    await api().post("/users").send({ name: "A", lastName: "B", email: "case@geest.com" });

    const res = await api()
      .post("/users")
      .send({ name: "A", lastName: "B", email: "CASE@GEEST.COM" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("EMAIL_ALREADY_EXISTS");
  });

  it("recorta los espacios sin perder el contenido", async () => {
    const res = await api()
      .post("/users")
      .send({ name: "  Ana  ", lastName: " Torres ", email: " trim@geest.com " });

    expect(res.body.name).toBe("Ana");
    expect(res.body.lastName).toBe("Torres");
    expect(res.body.email).toBe("trim@geest.com");
  });

  it("rechaza un name de más de 191 caracteres", async () => {
    const res = await api()
      .post("/users")
      .send({ name: "a".repeat(192), lastName: "T", email: "long@geest.com" });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/191/);
  });

  it("rechaza una description de más de 5000 caracteres", async () => {
    const res = await api()
      .post("/tasks")
      .send({ title: "T", description: "a".repeat(5001) });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/5000/);
  });

  it.each([
    ["array", "[]"],
    ["string", '"hola"'],
    ["número", "42"],
  ])("rechaza un body que es un %s JSON", async (_label, raw) => {
    const res = await api()
      .post("/users")
      .set("Content-Type", "application/json")
      .send(raw);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("una description en blanco se guarda como null, no da error", async () => {
    const res = await api().post("/tasks").send({ title: "T", description: "   " });

    expect(res.status).toBe(201);
    expect(res.body.description).toBeNull();
  });

  it("rechaza una description que no es string", async () => {
    const res = await api().post("/tasks").send({ title: "T", description: 42 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it.each(["abc", "99999999999999999999", "-1", "1.5"])(
    "rechaza el id de path %s con 400",
    async (id) => {
      const res = await api().get(`/tasks/${id}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    }
  );
});

// ---------------------------------------------------------------------------
// Bordes exactos del semáforo
// ---------------------------------------------------------------------------
describe("Bordes del semáforo urgency", () => {
  const now = new Date("2026-08-24T12:00:00Z");

  it("exactamente 48 h es yellow, no green", () => {
    const dueDate = new Date(now.getTime() + URGENCY_WARNING_MS);
    expect(computeUrgency({ dueDate, status: "open" }, now)).toBe("yellow");
  });

  it("un milisegundo más de 48 h ya es green", () => {
    const dueDate = new Date(now.getTime() + URGENCY_WARNING_MS + 1);
    expect(computeUrgency({ dueDate, status: "open" }, now)).toBe("green");
  });

  it("vencimiento exacto (0 ms) es yellow, todavía no red", () => {
    expect(computeUrgency({ dueDate: now, status: "open" }, now)).toBe("yellow");
  });

  it("un milisegundo pasado ya es red", () => {
    const dueDate = new Date(now.getTime() - 1);
    expect(computeUrgency({ dueDate, status: "open" }, now)).toBe("red");
  });
});

// ---------------------------------------------------------------------------
// Notificador sin NOTIFY_URL
// ---------------------------------------------------------------------------
describe("NOTIFY_URL sin configurar", () => {
  it("archiva igualmente y no registra ningún intento", async () => {
    const previo = process.env.NOTIFY_URL;
    process.env.NOTIFY_URL = "";

    try {
      const user = await createUser();
      const task = await createTask();
      await api().post(`/tasks/${task.id}/assign`).send({ userIds: [user.id] });

      const res = await api()
        .post(`/tasks/${task.id}/complete`)
        .send({ userId: user.id });
      await flushNotifications();

      expect(res.status).toBe(200);
      expect(res.body.taskStatus).toBe("archived");

      const attempts = await prisma.notificationAttempt.count({
        where: { taskId: task.id },
      });
      expect(attempts).toBe(0);
    } finally {
      process.env.NOTIFY_URL = previo;
    }
  });
});

// ---------------------------------------------------------------------------
// Ciclo de vida del job
// ---------------------------------------------------------------------------
describe("Ciclo de vida del job de vencimientos", () => {
  afterEach(stopDueSoonJob);

  it("arranca, hace una pasada inmediata y se puede detener", async () => {
    const hook = await startWebhook([200]);
    process.env.NOTIFY_URL = hook.url;

    try {
      await createTask({ title: "Job vivo", dueDate: inHours(3) });

      startDueSoonJob({ intervalMs: 50 });
      await new Promise((r) => setTimeout(r, 300));
      stopDueSoonJob();

      expect(hook.received).toHaveLength(1);

      // Tras detenerlo, una tarea nueva ya no se procesa.
      await createTask({ title: "Despues de parar", dueDate: inHours(3) });
      await new Promise((r) => setTimeout(r, 200));

      expect(hook.received).toHaveLength(1);
    } finally {
      await hook.close();
      process.env.NOTIFY_URL = "";
    }
  });

  it("llamar startDueSoonJob dos veces no duplica el temporizador", async () => {
    const hook = await startWebhook([200]);
    process.env.NOTIFY_URL = hook.url;

    try {
      await createTask({ title: "Un solo timer", dueDate: inHours(3) });

      startDueSoonJob({ intervalMs: 50 });
      startDueSoonJob({ intervalMs: 50 });
      await new Promise((r) => setTimeout(r, 300));
      stopDueSoonJob();

      expect(hook.received).toHaveLength(1);
    } finally {
      await hook.close();
      process.env.NOTIFY_URL = "";
    }
  });
});

// ---------------------------------------------------------------------------
// Forma y orden de las respuestas
// ---------------------------------------------------------------------------
describe("Forma y orden de las respuestas", () => {
  it("una tarea recién creada trae progress a cero y assignees vacío", async () => {
    const res = await api().post("/tasks").send({ title: "Vacía" });

    expect(res.body.progress).toEqual({ completed: 0, total: 0 });
    expect(res.body.assignees).toEqual([]);
  });

  it("GET /tasks devuelve las tareas en orden ascendente de id", async () => {
    await createTask({ title: "1" });
    await createTask({ title: "2" });
    await createTask({ title: "3" });

    const res = await api().get("/tasks");
    const ids = res.body.map((t) => t.id);

    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it("la bitácora mezcla ambos tipos de evento", async () => {
    const hook = await startWebhook([200]);
    process.env.NOTIFY_URL = hook.url;

    try {
      const user = await createUser();
      const task = await createTask({ title: "Dos eventos", dueDate: inHours(2) });
      await api().post(`/tasks/${task.id}/assign`).send({ userIds: [user.id] });

      await runDueSoonScan(); // task.due_soon
      await api().post(`/tasks/${task.id}/complete`).send({ userId: user.id });
      await flushNotifications(); // task.archived

      const res = await api().get(`/tasks/${task.id}/notifications`);
      const tipos = res.body.attempts.map((a) => a.eventType);

      expect(tipos).toContain("task.due_soon");
      expect(tipos).toContain("task.archived");
      // Ordenados por eventType: archived va antes que due_soon.
      expect(tipos).toEqual([...tipos].sort());
    } finally {
      await hook.close();
      process.env.NOTIFY_URL = "";
    }
  });
});

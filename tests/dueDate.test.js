const {
  api,
  prisma,
  resetDb,
  createUser,
  createTask,
  startWebhook,
  flushNotifications,
} = require("./helpers");
const { computeUrgency } = require("../src/services/tasks.service");
const { runDueSoonScan, claimDueSoon } = require("../src/jobs/dueSoon.job");

const HOUR = 60 * 60 * 1000;
const inHours = (h) => new Date(Date.now() + h * HOUR).toISOString();

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

// ---------------------------------------------------------------------------
// dueDate en la creación
// ---------------------------------------------------------------------------
describe("POST /tasks con dueDate", () => {
  it("acepta y persiste la fecha límite", async () => {
    const dueDate = inHours(72);
    const res = await api().post("/tasks").send({ title: "Con fecha", dueDate });

    expect(res.status).toBe(201);
    expect(new Date(res.body.dueDate).toISOString()).toBe(dueDate);

    const stored = await prisma.task.findUnique({ where: { id: res.body.id } });
    expect(stored.dueDate).toBeInstanceOf(Date);
  });

  it("dueDate sigue siendo opcional", async () => {
    const res = await api().post("/tasks").send({ title: "Sin fecha" });

    expect(res.status).toBe(201);
    expect(res.body.dueDate).toBeNull();
    expect(res.body.urgency).toBeNull();
  });

  it.each([
    ["texto que no es fecha", "mañana por la tarde"],
    ["fecha imposible", "2026-13-45T00:00:00Z"],
    ["número", 12345],
    ["objeto", { year: 2026 }],
  ])("rechaza %s", async (_label, dueDate) => {
    const res = await api().post("/tasks").send({ title: "T", dueDate });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("acepta una fecha ya pasada", async () => {
    // Registrar una tarea que ya venció es legítimo; el semáforo la marca en rojo.
    const res = await api().post("/tasks").send({ title: "Tarde", dueDate: inHours(-5) });

    expect(res.status).toBe(201);
    expect(res.body.urgency).toBe("red");
  });
});

// ---------------------------------------------------------------------------
// El semáforo urgency
// ---------------------------------------------------------------------------
describe("Campo urgency", () => {
  const now = new Date("2026-08-24T12:00:00Z");
  const at = (h) => new Date(now.getTime() + h * HOUR);

  it.each([
    ["green", 100, "open"],
    ["green", 49, "open"],
    ["yellow", 47, "open"],
    ["yellow", 1, "open"],
    ["red", -1, "open"],
    ["red", -500, "open"],
  ])("devuelve %s a %i h de la fecha límite", (expected, hours, status) => {
    expect(computeUrgency({ dueDate: at(hours), status }, now)).toBe(expected);
  });

  it("es null sin fecha límite", () => {
    expect(computeUrgency({ dueDate: null, status: "open" }, now)).toBeNull();
  });

  it("es null en una tarea archivada, aunque haya vencido", () => {
    expect(computeUrgency({ dueDate: at(-10), status: "archived" }, now)).toBeNull();
  });

  it("aparece en GET /tasks y en GET /tasks/:idTask", async () => {
    const task = await createTask({ title: "Urgente", dueDate: inHours(10) });

    const lista = await api().get("/tasks");
    const detalle = await api().get(`/tasks/${task.id}`);

    expect(lista.body.find((t) => t.id === task.id).urgency).toBe("yellow");
    expect(detalle.body.urgency).toBe("yellow");
  });

  it("pasa a null cuando la tarea se archiva", async () => {
    const user = await createUser();
    const task = await createTask({ title: "Se archiva", dueDate: inHours(5) });
    await api().post(`/tasks/${task.id}/assign`).send({ userIds: [user.id] });

    const antes = await api().get(`/tasks/${task.id}`);
    expect(antes.body.urgency).toBe("yellow");

    await api().post(`/tasks/${task.id}/complete`).send({ userId: user.id });

    const despues = await api().get(`/tasks/${task.id}`);
    expect(despues.body.status).toBe("archived");
    expect(despues.body.urgency).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// El job de avisos
// ---------------------------------------------------------------------------
describe("Job de alertas de vencimiento", () => {
  async function withWebhook(statuses, fn) {
    const hook = await startWebhook(statuses);
    process.env.NOTIFY_URL = hook.url;
    try {
      return await fn(hook);
    } finally {
      await hook.close();
      process.env.NOTIFY_URL = "";
    }
  }

  it("notifica una tarea que vence en menos de 24 h", async () => {
    await withWebhook([200], async (hook) => {
      const task = await createTask({ title: "Vence pronto", dueDate: inHours(12) });

      const result = await runDueSoonScan();

      expect(result.notified).toBe(1);
      expect(hook.received).toHaveLength(1);
      expect(hook.received[0]).toEqual({
        event: "task.due_soon",
        taskId: task.id,
        title: "Vence pronto",
        dueDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
      });
    });
  });

  it("registra el intento con eventType task.due_soon", async () => {
    await withWebhook([200], async () => {
      const task = await createTask({ title: "Bitácora", dueDate: inHours(3) });
      await runDueSoonScan();

      const res = await api().get(`/tasks/${task.id}/notifications`);

      expect(res.body.attempts).toHaveLength(1);
      expect(res.body.attempts[0]).toMatchObject({
        eventType: "task.due_soon",
        attemptNumber: 1,
        httpStatus: 200,
        success: true,
      });
    });
  });

  it("no vuelve a notificar en pasadas posteriores", async () => {
    await withWebhook([200], async (hook) => {
      await createTask({ title: "Una sola vez", dueDate: inHours(6) });

      await runDueSoonScan();
      await runDueSoonScan();
      await runDueSoonScan();

      expect(hook.received).toHaveLength(1);
    });
  });

  it.each([
    ["sin dueDate", {}],
    ["con dueDate lejano", { dueDate: inHours(100) }],
  ])("ignora una tarea %s", async (_label, extra) => {
    await withWebhook([200], async (hook) => {
      await createTask({ title: "Ignorada", ...extra });

      const result = await runDueSoonScan();

      expect(result.notified).toBe(0);
      expect(hook.received).toHaveLength(0);
    });
  });

  it("ignora una tarea ya archivada aunque haya vencido", async () => {
    await withWebhook([200], async (hook) => {
      const user = await createUser();
      const task = await createTask({ title: "Archivada", dueDate: inHours(2) });
      await api().post(`/tasks/${task.id}/assign`).send({ userIds: [user.id] });
      await api().post(`/tasks/${task.id}/complete`).send({ userId: user.id });
      await flushNotifications(); // deja llegar la notificación de archivado

      const antes = hook.received.length;
      const result = await runDueSoonScan();

      expect(result.notified).toBe(0);
      expect(hook.received.length).toBe(antes);
    });
  });

  it("también avisa de una tarea ya vencida que sigue abierta", async () => {
    await withWebhook([200], async (hook) => {
      await createTask({ title: "Vencida", dueDate: inHours(-8) });

      const result = await runDueSoonScan();

      expect(result.notified).toBe(1);
      expect(hook.received).toHaveLength(1);
    });
  });

  it("reintenta el aviso igual que el archivado: 500 → 503 → 200", async () => {
    await withWebhook([500, 503, 200], async () => {
      const task = await createTask({ title: "Reintentos", dueDate: inHours(1) });

      await runDueSoonScan();

      const res = await api().get(`/tasks/${task.id}/notifications`);

      expect(res.body.attempts).toHaveLength(3);
      expect(res.body.attempts.map((a) => a.httpStatus)).toEqual([500, 503, 200]);
      expect(res.body.attempts.every((a) => a.eventType === "task.due_soon")).toBe(true);
    });
  });

  it("se detiene en 3 intentos si el destino siempre falla", async () => {
    await withWebhook([500], async (hook) => {
      const task = await createTask({ title: "Siempre falla", dueDate: inHours(1) });

      await runDueSoonScan();

      const res = await api().get(`/tasks/${task.id}/notifications`);
      expect(res.body.attempts).toHaveLength(3);
      expect(hook.callCount()).toBe(3);
    });
  });

  it("procesa varias tareas en la misma pasada", async () => {
    await withWebhook([200], async (hook) => {
      await createTask({ title: "A", dueDate: inHours(2) });
      await createTask({ title: "B", dueDate: inHours(20) });
      await createTask({ title: "C", dueDate: inHours(200) }); // fuera de ventana

      const result = await runDueSoonScan();

      expect(result.notified).toBe(2);
      expect(hook.received.map((r) => r.title).sort()).toEqual(["A", "B"]);
    });
  });
});

// ---------------------------------------------------------------------------
// Concurrencia del job
// ---------------------------------------------------------------------------
describe("Concurrencia del job de vencimientos", () => {
  it("dos pasadas simultáneas envían el aviso exactamente una vez", async () => {
    const hook = await startWebhook([200]);
    process.env.NOTIFY_URL = hook.url;

    try {
      const task = await createTask({ title: "Carrera", dueDate: inHours(4) });

      const [a, b] = await Promise.all([runDueSoonScan(), runDueSoonScan()]);

      // Las dos pasadas vieron la tarea como candidata...
      expect(a.scanned + b.scanned).toBeGreaterThanOrEqual(1);
      // ...pero solo una la reclamó.
      expect(a.notified + b.notified).toBe(1);
      expect(hook.received).toHaveLength(1);

      const attempts = await prisma.notificationAttempt.count({
        where: { taskId: task.id, eventType: "task.due_soon" },
      });
      expect(attempts).toBe(1);
    } finally {
      await hook.close();
      process.env.NOTIFY_URL = "";
    }
  });

  it("claimDueSoon devuelve true una sola vez ante 5 intentos en paralelo", async () => {
    const task = await createTask({ title: "Claim", dueDate: inHours(4) });
    const now = new Date();

    const results = await Promise.all(
      Array.from({ length: 5 }, () => claimDueSoon(task.id, now))
    );

    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

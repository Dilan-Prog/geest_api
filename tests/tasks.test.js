const { api, prisma, resetDb, createUser, createTask } = require("./helpers");

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

describe("POST /tasks", () => {
  it("crea la tarea en estado open", async () => {
    const res = await api()
      .post("/tasks")
      .send({ title: "Migrar servidor", description: "Pasar a la nueva VPS" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      title: "Migrar servidor",
      description: "Pasar a la nueva VPS",
      status: "open",
      archivedAt: null,
    });
    expect(typeof res.body.id).toBe("number");
  });

  it("acepta tareas sin descripción", async () => {
    const res = await api().post("/tasks").send({ title: "Solo título" });

    expect(res.status).toBe(201);
    expect(res.body.description).toBeNull();
  });

  it.each([
    ["sin título", {}],
    ["título vacío", { title: "   " }],
    ["título no string", { title: 42 }],
  ])("rechaza %s", async (_label, body) => {
    const res = await api().post("/tasks").send(body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("POST /tasks/:idTask/assign", () => {
  it("asigna varios usuarios de una vez", async () => {
    const [a, b] = [await createUser(), await createUser()];
    const task = await createTask();

    const res = await api()
      .post(`/tasks/${task.id}/assign`)
      .send({ userIds: [a.id, b.id] });

    expect(res.status).toBe(200);
    expect(res.body.message).toBeDefined();
    expect(res.body.assigned.sort()).toEqual([a.id, b.id].sort());
  });

  it("no duplica la relación al reasignar", async () => {
    const user = await createUser();
    const task = await createTask();

    await api().post(`/tasks/${task.id}/assign`).send({ userIds: [user.id] });
    const res = await api().post(`/tasks/${task.id}/assign`).send({ userIds: [user.id] });

    expect(res.status).toBe(200);
    expect(res.body.assigned).toEqual([]);
    expect(res.body.alreadyAssigned).toEqual([user.id]);

    const count = await prisma.taskAssignment.count({ where: { taskId: task.id } });
    expect(count).toBe(1);
  });

  it("deduplica userIds repetidos en el mismo body", async () => {
    const user = await createUser();
    const task = await createTask();

    await api()
      .post(`/tasks/${task.id}/assign`)
      .send({ userIds: [user.id, user.id, user.id] });

    const count = await prisma.taskAssignment.count({ where: { taskId: task.id } });
    expect(count).toBe(1);
  });

  it("devuelve 404 si la tarea no existe", async () => {
    const user = await createUser();
    const res = await api().post("/tasks/999999/assign").send({ userIds: [user.id] });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("TASK_NOT_FOUND");
  });

  it("no asigna a nadie si algún usuario no existe (todo o nada)", async () => {
    const user = await createUser();
    const task = await createTask();

    const res = await api()
      .post(`/tasks/${task.id}/assign`)
      .send({ userIds: [user.id, 999999] });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("USER_NOT_FOUND");

    const count = await prisma.taskAssignment.count({ where: { taskId: task.id } });
    expect(count).toBe(0);
  });

  it("rechaza asignar a una tarea archivada", async () => {
    const [a, b] = [await createUser(), await createUser()];
    const task = await createTask();

    await api().post(`/tasks/${task.id}/assign`).send({ userIds: [a.id] });
    await api().post(`/tasks/${task.id}/complete`).send({ userId: a.id });

    const res = await api().post(`/tasks/${task.id}/assign`).send({ userIds: [b.id] });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("TASK_ARCHIVED");
  });

  it.each([
    ["userIds ausente", {}],
    ["userIds vacío", { userIds: [] }],
    ["userIds no array", { userIds: 1 }],
    ["userIds con basura", { userIds: [1, "abc"] }],
  ])("rechaza %s", async (_label, body) => {
    const task = await createTask();
    const res = await api().post(`/tasks/${task.id}/assign`).send(body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("POST /tasks/:idTask/complete", () => {
  it("marca la parte del usuario y deja la tarea abierta si faltan otros", async () => {
    const [a, b] = [await createUser(), await createUser()];
    const task = await createTask();
    await api().post(`/tasks/${task.id}/assign`).send({ userIds: [a.id, b.id] });

    const res = await api().post(`/tasks/${task.id}/complete`).send({ userId: a.id });

    expect(res.status).toBe(200);
    expect(res.body.taskStatus).toBe("open");
    expect(res.body.remainingUsers).toBe(1);
    expect(res.body.archivedAt).toBeNull();
  });

  it("archiva la tarea cuando el último usuario termina", async () => {
    const [a, b] = [await createUser(), await createUser()];
    const task = await createTask();
    await api().post(`/tasks/${task.id}/assign`).send({ userIds: [a.id, b.id] });

    await api().post(`/tasks/${task.id}/complete`).send({ userId: a.id });
    const res = await api().post(`/tasks/${task.id}/complete`).send({ userId: b.id });

    expect(res.body.taskStatus).toBe("archived");
    expect(res.body.remainingUsers).toBe(0);
    expect(res.body.archivedAt).not.toBeNull();

    const stored = await prisma.task.findUnique({ where: { id: task.id } });
    expect(stored.status).toBe("archived");
    expect(stored.archivedAt).toBeInstanceOf(Date);
  });

  it("completar dos veces es idempotente y no rompe nada", async () => {
    const [a, b] = [await createUser(), await createUser()];
    const task = await createTask();
    await api().post(`/tasks/${task.id}/assign`).send({ userIds: [a.id, b.id] });

    await api().post(`/tasks/${task.id}/complete`).send({ userId: a.id });
    const res = await api().post(`/tasks/${task.id}/complete`).send({ userId: a.id });

    expect(res.status).toBe(200);
    expect(res.body.remainingUsers).toBe(1);
  });

  it("devuelve 409 si el usuario no está asignado", async () => {
    const [asignado, ajeno] = [await createUser(), await createUser()];
    const task = await createTask();
    await api().post(`/tasks/${task.id}/assign`).send({ userIds: [asignado.id] });

    const res = await api().post(`/tasks/${task.id}/complete`).send({ userId: ajeno.id });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("USER_NOT_ASSIGNED");
  });

  it("devuelve 404 si la tarea no existe", async () => {
    const user = await createUser();
    const res = await api().post("/tasks/999999/complete").send({ userId: user.id });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("TASK_NOT_FOUND");
  });

  it("devuelve 404 si el usuario no existe", async () => {
    const task = await createTask();
    const res = await api().post(`/tasks/${task.id}/complete`).send({ userId: 999999 });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("USER_NOT_FOUND");
  });
});

describe("GET /tasks", () => {
  it("indica qué usuarios completaron su parte", async () => {
    const [a, b] = [await createUser(), await createUser()];
    const task = await createTask();
    await api().post(`/tasks/${task.id}/assign`).send({ userIds: [a.id, b.id] });
    await api().post(`/tasks/${task.id}/complete`).send({ userId: a.id });

    const res = await api().get("/tasks");
    const row = res.body.find((t) => t.id === task.id);

    expect(res.status).toBe(200);
    expect(row.progress).toEqual({ completed: 1, total: 2 });
    expect(row.assignees.find((u) => u.userId === a.id).completed).toBe(true);
    expect(row.assignees.find((u) => u.userId === b.id).completed).toBe(false);
  });

  it("filtra por status", async () => {
    const user = await createUser();
    const abierta = await createTask({ title: "Abierta" });
    const cerrada = await createTask({ title: "Cerrada" });

    await api().post(`/tasks/${cerrada.id}/assign`).send({ userIds: [user.id] });
    await api().post(`/tasks/${cerrada.id}/complete`).send({ userId: user.id });

    const abiertas = await api().get("/tasks?status=open");
    const archivadas = await api().get("/tasks?status=archived");

    expect(abiertas.body.map((t) => t.id)).toEqual([abierta.id]);
    expect(archivadas.body.map((t) => t.id)).toEqual([cerrada.id]);
  });

  it("rechaza un status desconocido", async () => {
    const res = await api().get("/tasks?status=pending");

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("GET /tasks/:idTask", () => {
  it("devuelve la información completa de la tarea", async () => {
    const user = await createUser({ name: "Ana" });
    const task = await createTask({ title: "Detalle", description: "Con desc" });
    await api().post(`/tasks/${task.id}/assign`).send({ userIds: [user.id] });

    const res = await api().get(`/tasks/${task.id}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: task.id,
      title: "Detalle",
      description: "Con desc",
      status: "open",
    });
    expect(res.body.assignees[0]).toMatchObject({
      userId: user.id,
      name: "Ana",
      completed: false,
    });
  });

  it("devuelve 404 si no existe", async () => {
    const res = await api().get("/tasks/999999");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("TASK_NOT_FOUND");
  });
});

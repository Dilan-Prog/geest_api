const { api, prisma, resetDb, createUser, createTask } = require("./helpers");

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

describe("POST /users", () => {
  it("registra un usuario y devuelve su id", async () => {
    const res = await api()
      .post("/users")
      .send({ name: "Ana", lastName: "Torres", email: "ana@geest.com" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: "Ana",
      lastName: "Torres",
      email: "ana@geest.com",
    });
    expect(typeof res.body.id).toBe("number");
    expect(res.body.createdAt).toBeDefined();
  });

  it.each([
    ["falta name", { lastName: "Torres", email: "a@b.com" }],
    ["falta lastName", { name: "Ana", email: "a@b.com" }],
    ["falta email", { name: "Ana", lastName: "Torres" }],
    ["name vacío", { name: "  ", lastName: "Torres", email: "a@b.com" }],
  ])("rechaza cuando %s", async (_label, body) => {
    const res = await api().post("/users").send(body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(typeof res.body.error.message).toBe("string");
  });

  it.each(["sin-arroba", "a@b", "@geest.com", "ana@.com", "ana torres@geest.com"])(
    "rechaza el email inválido %s",
    async (email) => {
      const res = await api()
        .post("/users")
        .send({ name: "Ana", lastName: "Torres", email });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    }
  );

  it("rechaza un email duplicado", async () => {
    const body = { name: "Ana", lastName: "Torres", email: "dup@geest.com" };
    await api().post("/users").send(body);

    const res = await api().post("/users").send(body);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("EMAIL_ALREADY_EXISTS");
  });
});

describe("GET /users", () => {
  it("devuelve lista vacía sin usuarios", async () => {
    const res = await api().get("/users");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("muestra las tareas pendientes de cada usuario", async () => {
    const ana = await createUser({ name: "Ana" });
    const luis = await createUser({ name: "Luis" });
    const task = await createTask({ title: "Migrar servidor" });

    await api().post(`/tasks/${task.id}/assign`).send({ userIds: [ana.id, luis.id] });
    await api().post(`/tasks/${task.id}/complete`).send({ userId: ana.id });

    const res = await api().get("/users");
    const anaRow = res.body.find((u) => u.id === ana.id);
    const luisRow = res.body.find((u) => u.id === luis.id);

    // Ana ya terminó su parte, así que la tarea deja de estar pendiente para ella.
    expect(anaRow.pendingTasks).toEqual([]);
    expect(luisRow.pendingTasks).toEqual([
      { taskId: task.id, title: "Migrar servidor", status: "open" },
    ]);
  });
});

describe("GET /users/:idUser/tasks", () => {
  it("indica si el usuario completó su parte en cada tarea", async () => {
    const ana = await createUser();
    const hecha = await createTask({ title: "Hecha" });
    const pendiente = await createTask({ title: "Pendiente" });

    await api().post(`/tasks/${hecha.id}/assign`).send({ userIds: [ana.id] });
    await api().post(`/tasks/${pendiente.id}/assign`).send({ userIds: [ana.id] });
    await api().post(`/tasks/${hecha.id}/complete`).send({ userId: ana.id });

    const res = await api().get(`/users/${ana.id}/tasks`);

    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(ana.id);
    expect(res.body.tasks).toHaveLength(2);

    const byTitle = Object.fromEntries(res.body.tasks.map((t) => [t.title, t]));
    expect(byTitle.Hecha.completed).toBe(true);
    expect(byTitle.Hecha.status).toBe("archived");
    expect(byTitle.Pendiente.completed).toBe(false);
    expect(byTitle.Pendiente.completedAt).toBeNull();
  });

  it("devuelve 404 si el usuario no existe", async () => {
    const res = await api().get("/users/999999/tasks");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("USER_NOT_FOUND");
  });

  it("devuelve 400 si el id no es numérico", async () => {
    const res = await api().get("/users/abc/tasks");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

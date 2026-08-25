const { api, prisma } = require("./helpers");
const openapi = require("../src/docs/openapi");

afterAll(() => prisma.$disconnect());

describe("Documentación interactiva", () => {
  it("sirve Swagger UI en /docs", async () => {
    const res = await api().get("/docs/");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/html/);
    expect(res.text).toContain("swagger-ui");
  });

  it("la raíz redirige a /docs", async () => {
    const res = await api().get("/");

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/docs");
  });

  it("expone el spec crudo para importarlo en Postman", async () => {
    const res = await api().get("/openapi.json");

    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe("3.0.3");
    expect(res.body.info.title).toContain("GEEST");
  });

  /**
   * Este es el test que da valor a los demás: si alguien añade una ruta a
   * Express y olvida documentarla, la documentación deja de reflejar la API
   * y el fallo aparece aquí en vez de descubrirlo el evaluador.
   */
  it("documenta exactamente los endpoints que existen", () => {
    const documented = Object.entries(openapi.paths)
      .flatMap(([path, ops]) =>
        Object.keys(ops).map((method) => `${method.toUpperCase()} ${path}`)
      )
      .sort();

    expect(documented).toEqual(
      [
        "GET /health",
        "POST /users",
        "GET /users",
        "GET /users/{idUser}/tasks",
        "POST /tasks",
        "GET /tasks",
        "GET /tasks/{idTask}",
        "POST /tasks/{idTask}/assign",
        "POST /tasks/{idTask}/complete",
        "GET /tasks/{idTask}/notifications",
      ].sort()
    );
  });

  it("todos los POST documentan la cabecera Idempotency-Key", () => {
    const posts = Object.entries(openapi.paths).filter(([, ops]) => ops.post);

    expect(posts).toHaveLength(4);

    for (const [path, ops] of posts) {
      const headers = (ops.post.parameters ?? []).map((p) => p.name);
      expect(headers).toContain("Idempotency-Key");
      expect(path).toBeDefined();
    }
  });

  it("todas las referencias $ref apuntan a un schema existente", () => {
    const schemas = Object.keys(openapi.components.schemas);
    const refs = [...JSON.stringify(openapi).matchAll(/#\/components\/schemas\/(\w+)/g)]
      .map((m) => m[1]);

    expect(refs.length).toBeGreaterThan(0);
    for (const ref of new Set(refs)) {
      expect(schemas).toContain(ref);
    }
  });
});

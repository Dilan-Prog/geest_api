const express = require("express");
const swaggerUi = require("swagger-ui-express");
const usersRoutes = require("./routes/users.routes");
const tasksRoutes = require("./routes/tasks.routes");
const openapi = require("./docs/openapi");
const { errorHandler, notFoundHandler } = require("./middleware/errorHandler");

const app = express();

// express.json() va primero: el middleware de idempotencia necesita el body
// ya parseado para poder hashearlo.
app.use(express.json({ limit: "100kb" }));

app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// Documentación interactiva. El spec crudo se expone aparte para que se pueda
// importar en Postman o Insomnia sin pasar por la interfaz.
app.get("/openapi.json", (req, res) => res.json(openapi));
app.use(
  "/docs",
  swaggerUi.serve,
  swaggerUi.setup(openapi, {
    customSiteTitle: "GEEST API — Documentación",
    swaggerOptions: { docExpansion: "list", defaultModelsExpandDepth: 0 },
  })
);

// La raíz redirige a la documentación: quien abra la URL pública sin saber
// qué es, aterriza en algo utilizable en lugar de en un 404.
app.get("/", (req, res) => res.redirect("/docs"));

app.use("/users", usersRoutes);
app.use("/tasks", tasksRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;

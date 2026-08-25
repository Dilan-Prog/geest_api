require("dotenv/config");

const app = require("./app");
const prisma = require("./db");
const { startDueSoonJob, stopDueSoonJob } = require("./jobs/dueSoon.job");

const PORT = Number(process.env.PORT || 3000);

const server = app.listen(PORT, () => {
  console.log(`geest_api escuchando en http://localhost:${PORT}`);
});

// El job vive en el proceso del servidor, no en el módulo de la app: así los
// tests pueden importar `app` sin que arranque un temporizador de fondo.
startDueSoonJob();

// Cierre ordenado: deja terminar las peticiones en curso y suelta el pool de MySQL.
// Sin esto, cada redeploy en el servidor deja conexiones colgando.
async function shutdown(signal) {
  console.log(`\n${signal} recibido, cerrando...`);
  stopDueSoonJob();
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

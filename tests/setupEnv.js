// Se ejecuta ANTES de que el archivo de test importe nada, para que el
// PrismaClient de src/db.js se construya apuntando a la base de datos de test
// y no a la de desarrollo.
const path = require("path");

require("dotenv").config({
  path: path.resolve(__dirname, "..", ".env.test"),
  override: true,
  quiet: true, // sin el banner "injected env" en cada suite
});

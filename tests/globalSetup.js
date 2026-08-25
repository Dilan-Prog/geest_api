const path = require("path");
const { execSync } = require("child_process");

/**
 * Crea la base de datos de test y aplica las migraciones versionadas del repo.
 * Se usan las mismas migraciones que en producción, no un `db push`: si una
 * migración está rota, los tests lo revelan.
 *
 * La salida de Prisma se captura en lugar de heredarse: en el camino feliz no
 * aporta nada y ensucia el arranque de la suite. Si algo falla, se imprime
 * entera antes de propagar el error.
 */
module.exports = async () => {
  const root = path.resolve(__dirname, "..");

  require("dotenv").config({
    path: path.join(root, ".env.test"),
    override: true,
    quiet: true,
  });

  try {
    execSync("npx prisma migrate deploy", {
      cwd: root,
      stdio: "pipe",
      env: { ...process.env },
    });
  } catch (err) {
    console.error("\nFalló `prisma migrate deploy`:\n");
    console.error(err.stdout?.toString() ?? "");
    console.error(err.stderr?.toString() ?? "");
    throw err;
  }
};

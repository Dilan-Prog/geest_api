const { PrismaClient } = require("@prisma/client");

// Un único cliente para todo el proceso. Crear uno por request agotaría
// el pool de conexiones de MySQL en cuanto hubiera algo de carga.
const prisma = new PrismaClient();

module.exports = prisma;

const { validationError } = require("../errors");

// Suficientemente estricta para atrapar errores reales de tipeo sin rechazar
// direcciones válidas poco comunes. La validación definitiva de un email
// siempre es mandar un correo, no una expresión regular.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;

const TASK_STATUSES = ["open", "archived"];

function requireString(value, field, { maxLength = 191 } = {}) {
  if (value === undefined || value === null) {
    throw validationError(`Field "${field}" is required`);
  }
  if (typeof value !== "string") {
    throw validationError(`Field "${field}" must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw validationError(`Field "${field}" cannot be empty`);
  }
  if (trimmed.length > maxLength) {
    throw validationError(`Field "${field}" exceeds ${maxLength} characters`);
  }
  return trimmed;
}

function optionalString(value, field, { maxLength = 5000 } = {}) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw validationError(`Field "${field}" must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > maxLength) {
    throw validationError(`Field "${field}" exceeds ${maxLength} characters`);
  }
  return trimmed;
}

function requirePositiveInt(value, field) {
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(n) || n <= 0) {
    throw validationError(`Field "${field}" must be a positive integer`);
  }
  return n;
}

/** Valida un :id de la URL. Un id no numérico es una petición mal formada (400), no un 404. */
function parseIdParam(raw, field) {
  if (!/^\d+$/.test(String(raw))) {
    throw validationError(`Parameter "${field}" must be a positive integer`);
  }
  const n = Number(raw);
  if (n <= 0 || !Number.isSafeInteger(n)) {
    throw validationError(`Parameter "${field}" must be a positive integer`);
  }
  return n;
}

function assertPlainObject(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw validationError("Request body must be a JSON object");
  }
}

function validateCreateUser(body) {
  assertPlainObject(body);
  const name = requireString(body.name, "name");
  const lastName = requireString(body.lastName, "lastName");
  const email = requireString(body.email, "email").toLowerCase();

  if (!EMAIL_RE.test(email)) {
    throw validationError(`"${email}" is not a valid email address`);
  }
  return { name, lastName, email };
}

/**
 * Fecha límite opcional. Se acepta cualquier cosa que `Date` sepa interpretar,
 * pero se recomienda ISO 8601. No se exige que sea futura: registrar una tarea
 * que ya venció es legítimo, y el semáforo la marcará en rojo.
 */
function optionalDate(value, field) {
  if (value === undefined || value === null || value === "") return null;

  if (typeof value !== "string" && !(value instanceof Date)) {
    throw validationError(`Field "${field}" must be an ISO 8601 date string`);
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw validationError(`Field "${field}" is not a valid date`);
  }
  return date;
}

function validateCreateTask(body) {
  assertPlainObject(body);
  return {
    title: requireString(body.title, "title"),
    description: optionalString(body.description, "description"),
    dueDate: optionalDate(body.dueDate, "dueDate"),
  };
}

function validateAssign(body) {
  assertPlainObject(body);
  const { userIds } = body;

  if (!Array.isArray(userIds)) {
    throw validationError('Field "userIds" must be an array');
  }
  if (userIds.length === 0) {
    throw validationError('Field "userIds" cannot be empty');
  }
  const parsed = userIds.map((id, i) => requirePositiveInt(id, `userIds[${i}]`));

  // Supuesto: userIds repetidos en el mismo body se deduplican sin error.
  return [...new Set(parsed)];
}

function validateComplete(body) {
  assertPlainObject(body);
  return requirePositiveInt(body.userId, "userId");
}

function validateStatusQuery(status) {
  if (status === undefined) return undefined;
  if (!TASK_STATUSES.includes(status)) {
    throw validationError(
      `Query parameter "status" must be one of: ${TASK_STATUSES.join(", ")}`
    );
  }
  return status;
}

module.exports = {
  TASK_STATUSES,
  optionalDate,
  parseIdParam,
  validateCreateUser,
  validateCreateTask,
  validateAssign,
  validateComplete,
  validateStatusQuery,
};

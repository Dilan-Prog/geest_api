/**
 * Error de dominio. Todo lo que llegue al errorHandler siendo un AppError
 * se traduce tal cual al formato { error: { code, message } } que exige el reto.
 * Cualquier otra cosa se convierte en un 500 genérico sin filtrar detalles internos.
 */
class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
  }
}

const validationError = (message) =>
  new AppError(400, "VALIDATION_ERROR", message);

const taskNotFound = (id) =>
  new AppError(404, "TASK_NOT_FOUND", `Task with id ${id} does not exist`);

const userNotFound = (id) =>
  new AppError(404, "USER_NOT_FOUND", `User with id ${id} does not exist`);

const usersNotFound = (ids) =>
  new AppError(
    404,
    "USER_NOT_FOUND",
    `The following users do not exist: ${ids.join(", ")}`
  );

const emailAlreadyExists = (email) =>
  new AppError(409, "EMAIL_ALREADY_EXISTS", `Email ${email} is already registered`);

const taskArchived = (id) =>
  new AppError(
    409,
    "TASK_ARCHIVED",
    `Task ${id} is archived and cannot accept new assignments`
  );

const userNotAssigned = (userId, taskId) =>
  new AppError(
    409,
    "USER_NOT_ASSIGNED",
    `User ${userId} is not assigned to task ${taskId}`
  );

const idempotencyKeyReused = () =>
  new AppError(
    409,
    "IDEMPOTENCY_KEY_REUSED",
    "This Idempotency-Key was already used with a different request body"
  );

const idempotencyInProgress = () =>
  new AppError(
    409,
    "IDEMPOTENCY_IN_PROGRESS",
    "A request with this Idempotency-Key is still being processed. Retry shortly."
  );

module.exports = {
  AppError,
  validationError,
  taskNotFound,
  userNotFound,
  usersNotFound,
  emailAlreadyExists,
  taskArchived,
  userNotAssigned,
  idempotencyKeyReused,
  idempotencyInProgress,
};

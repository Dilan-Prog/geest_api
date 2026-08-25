const { Router } = require("express");
const { idempotency } = require("../middleware/idempotency");
const {
  parseIdParam,
  validateCreateTask,
  validateAssign,
  validateComplete,
  validateStatusQuery,
} = require("../validators");
const tasksService = require("../services/tasks.service");

const router = Router();

// POST /tasks
router.post("/", idempotency, async (req, res) => {
  const data = validateCreateTask(req.body);
  const task = await tasksService.createTask(data);
  res.status(201).json(task);
});

// GET /tasks?status=open|archived
router.get("/", async (req, res) => {
  const status = validateStatusQuery(req.query.status);
  res.json(await tasksService.listTasks(status));
});

// GET /tasks/:idTask
router.get("/:idTask", async (req, res) => {
  const taskId = parseIdParam(req.params.idTask, "idTask");
  res.json(await tasksService.getTask(taskId));
});

// POST /tasks/:idTask/assign
router.post("/:idTask/assign", idempotency, async (req, res) => {
  const taskId = parseIdParam(req.params.idTask, "idTask");
  const userIds = validateAssign(req.body);
  res.json(await tasksService.assignUsers(taskId, userIds));
});

// POST /tasks/:idTask/complete
router.post("/:idTask/complete", idempotency, async (req, res) => {
  const taskId = parseIdParam(req.params.idTask, "idTask");
  const userId = validateComplete(req.body);
  res.json(await tasksService.completeTaskPart(taskId, userId));
});

// GET /tasks/:idTask/notifications
router.get("/:idTask/notifications", async (req, res) => {
  const taskId = parseIdParam(req.params.idTask, "idTask");
  res.json(await tasksService.listNotifications(taskId));
});

module.exports = router;

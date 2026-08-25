const { Router } = require("express");
const { idempotency } = require("../middleware/idempotency");
const { parseIdParam, validateCreateUser } = require("../validators");
const usersService = require("../services/users.service");

const router = Router();

// POST /users
router.post("/", idempotency, async (req, res) => {
  const data = validateCreateUser(req.body);
  const user = await usersService.createUser(data);
  res.status(201).json(user);
});

// GET /users
router.get("/", async (req, res) => {
  res.json(await usersService.listUsers());
});

// GET /users/:idUser/tasks
router.get("/:idUser/tasks", async (req, res) => {
  const userId = parseIdParam(req.params.idUser, "idUser");
  res.json(await usersService.listUserTasks(userId));
});

module.exports = router;

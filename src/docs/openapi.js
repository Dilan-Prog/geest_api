/**
 * Documento OpenAPI 3.0 de la API.
 *
 * Se escribe a mano en un solo módulo en lugar de generarlo con anotaciones
 * JSDoc repartidas por las rutas: así el contrato completo se lee de un vistazo
 * y no hay un paso de generación que pueda quedar desincronizado en el deploy.
 */

const ERROR_CODES = {
  VALIDATION_ERROR: "Falta un campo obligatorio, tipo incorrecto o email inválido",
  TASK_NOT_FOUND: "La tarea no existe",
  USER_NOT_FOUND: "El usuario no existe",
  EMAIL_ALREADY_EXISTS: "Ya hay un usuario registrado con ese email",
  TASK_ARCHIVED: "La tarea está archivada y no admite nuevas asignaciones",
  USER_NOT_ASSIGNED: "El usuario no está asignado a esa tarea",
  IDEMPOTENCY_KEY_REUSED: "Misma Idempotency-Key con un body distinto",
  IDEMPOTENCY_IN_PROGRESS: "La petición original sigue en curso",
  INTERNAL_ERROR: "Fallo no controlado",
};

const idempotencyHeader = {
  name: "Idempotency-Key",
  in: "header",
  required: false,
  schema: { type: "string", example: "8f14e45f-ea3b-4b21-9c1d-2a7f6b0e1c33" },
  description:
    "Identificador único de la operación. Si llegan dos peticiones con la misma " +
    "clave y el mismo cuerpo, la operación se ejecuta una sola vez y ambas " +
    "respuestas son idénticas, incluso si llegan en paralelo.",
};

/** Construye una respuesta de error con los códigos posibles listados. */
const errorResponse = (description, codes) => ({
  description,
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/Error" },
      examples: Object.fromEntries(
        codes.map((code) => [
          code,
          { value: { error: { code, message: ERROR_CODES[code] } } },
        ])
      ),
    },
  },
});

const jsonBody = (schemaRef, example) => ({
  required: true,
  content: {
    "application/json": {
      schema: { $ref: schemaRef },
      example,
    },
  },
});

const jsonResponse = (description, schema) => ({
  description,
  content: { "application/json": { schema } },
});

const openapi = {
  openapi: "3.0.3",

  info: {
    title: "GEEST — API de gestión de trabajo",
    version: "1.0.0",
    description: `
API REST para crear tareas, asignarlas a varias personas y archivarlas
automáticamente cuando todas completan su parte.

### Cómo probarla
Pulsa **Try it out** en cualquier endpoint, edita el cuerpo y ejecuta.
Las peticiones salen contra este mismo servidor, con datos reales.

### Flujo completo sugerido
1. \`POST /users\` — crea dos usuarios y apunta sus \`id\`.
2. \`POST /tasks\` — crea una tarea; nace en estado \`open\`.
3. \`POST /tasks/{idTask}/assign\` — asígnale los dos usuarios.
4. \`POST /tasks/{idTask}/complete\` — complétala con el primer usuario.
   La tarea sigue \`open\` y \`remainingUsers\` vale 1.
5. \`POST /tasks/{idTask}/complete\` — ahora con el segundo.
   La tarea pasa a \`archived\` y se dispara la notificación.
6. \`GET /tasks/{idTask}/notifications\` — consulta los intentos de envío.

### Idempotencia
Los cuatro endpoints POST aceptan la cabecera \`Idempotency-Key\`.
Repite la misma llamada con la misma clave y el mismo cuerpo: la respuesta
será idéntica y la operación se habrá ejecutado una sola vez.

### Alertas de vencimiento
Al crear una tarea puedes pasar \`dueDate\`. Cada tarea expone entonces un
semáforo \`urgency\` calculado al vuelo, y un job periódico envía un aviso
\`task.due_soon\` a \`NOTIFY_URL\` cuando faltan menos de 24 h.

### Formato de error
Todos los errores comparten la misma forma:
\`\`\`json
{ "error": { "code": "VALIDATION_ERROR", "message": "..." } }
\`\`\`
`.trim(),
  },

  servers: [
    ...(process.env.PUBLIC_URL
      ? [{ url: process.env.PUBLIC_URL, description: "Producción" }]
      : []),
    {
      url: `http://localhost:${process.env.PORT || 3000}`,
      description: "Local",
    },
  ],

  tags: [
    { name: "Usuarios", description: "Registro y consulta de personas" },
    { name: "Tareas", description: "Creación, asignación y archivado" },
    { name: "Sistema", description: "Estado del servicio" },
  ],

  paths: {
    "/health": {
      get: {
        tags: ["Sistema"],
        summary: "Comprobar que el servicio está vivo",
        responses: {
          200: jsonResponse("Servicio operativo", {
            type: "object",
            properties: {
              status: { type: "string", example: "ok" },
              uptime: { type: "number", example: 1234.5 },
            },
          }),
        },
      },
    },

    "/users": {
      post: {
        tags: ["Usuarios"],
        summary: "Registrar un usuario",
        description:
          "Crea un usuario con un ID único. El email debe tener formato válido " +
          "y no puede estar repetido.",
        parameters: [idempotencyHeader],
        requestBody: jsonBody("#/components/schemas/CreateUser", {
          name: "Ana",
          lastName: "Torres",
          email: "ana.torres@geest.com",
        }),
        responses: {
          201: jsonResponse("Usuario creado", {
            $ref: "#/components/schemas/User",
          }),
          400: errorResponse("Datos inválidos", ["VALIDATION_ERROR"]),
          409: errorResponse("Conflicto", [
            "EMAIL_ALREADY_EXISTS",
            "IDEMPOTENCY_KEY_REUSED",
          ]),
        },
      },
      get: {
        tags: ["Usuarios"],
        summary: "Listar usuarios y sus tareas pendientes",
        description:
          "Una tarea es *pendiente* para un usuario si tiene la asignación sin " +
          "completar, independientemente del estado de la tarea.",
        responses: {
          200: jsonResponse("Lista de usuarios", {
            type: "array",
            items: { $ref: "#/components/schemas/UserWithPending" },
          }),
        },
      },
    },

    "/users/{idUser}/tasks": {
      get: {
        tags: ["Usuarios"],
        summary: "Tareas de un usuario",
        description:
          "Todas las tareas asignadas al usuario, indicando si completó su parte " +
          "en cada una.",
        parameters: [
          {
            name: "idUser",
            in: "path",
            required: true,
            schema: { type: "integer", minimum: 1 },
            example: 1,
          },
        ],
        responses: {
          200: jsonResponse("Tareas del usuario", {
            $ref: "#/components/schemas/UserTasks",
          }),
          400: errorResponse("ID no numérico", ["VALIDATION_ERROR"]),
          404: errorResponse("No existe", ["USER_NOT_FOUND"]),
        },
      },
    },

    "/tasks": {
      post: {
        tags: ["Tareas"],
        summary: "Crear una tarea",
        description:
          "El título es obligatorio; la descripción es opcional. " +
          "La tarea nace siempre en estado `open`.",
        parameters: [idempotencyHeader],
        requestBody: jsonBody("#/components/schemas/CreateTask", {
          title: "Migrar servidor",
          description: "Pasar la aplicación a la nueva VPS",
          dueDate: "2026-09-01T18:00:00Z",
        }),
        responses: {
          201: jsonResponse("Tarea creada", { $ref: "#/components/schemas/Task" }),
          400: errorResponse("Datos inválidos", ["VALIDATION_ERROR"]),
          409: errorResponse("Conflicto", ["IDEMPOTENCY_KEY_REUSED"]),
        },
      },
      get: {
        tags: ["Tareas"],
        summary: "Listar tareas",
        description:
          "Devuelve cada tarea con sus asignados y quién ya completó su parte. " +
          "El parámetro `status` filtra por estado.",
        parameters: [
          {
            name: "status",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["open", "archived"] },
            description: "Sin el parámetro se devuelven todas las tareas.",
          },
        ],
        responses: {
          200: jsonResponse("Lista de tareas", {
            type: "array",
            items: { $ref: "#/components/schemas/Task" },
          }),
          400: errorResponse("Status desconocido", ["VALIDATION_ERROR"]),
        },
      },
    },

    "/tasks/{idTask}": {
      get: {
        tags: ["Tareas"],
        summary: "Detalle de una tarea",
        parameters: [
          {
            name: "idTask",
            in: "path",
            required: true,
            schema: { type: "integer", minimum: 1 },
            example: 1,
          },
        ],
        responses: {
          200: jsonResponse("Tarea", { $ref: "#/components/schemas/Task" }),
          400: errorResponse("ID no numérico", ["VALIDATION_ERROR"]),
          404: errorResponse("No existe", ["TASK_NOT_FOUND"]),
        },
      },
    },

    "/tasks/{idTask}/assign": {
      post: {
        tags: ["Tareas"],
        summary: "Asignar usuarios a una tarea",
        description:
          "**Todo o nada**: si un solo `userId` no existe, no se asigna ninguno.\n\n" +
          "Reasignar a alguien ya asignado no duplica la relación ni produce error. " +
          "Los `userIds` repetidos en el mismo cuerpo se deduplican.",
        parameters: [
          {
            name: "idTask",
            in: "path",
            required: true,
            schema: { type: "integer", minimum: 1 },
            example: 1,
          },
          idempotencyHeader,
        ],
        requestBody: jsonBody("#/components/schemas/AssignUsers", {
          userIds: [1, 2],
        }),
        responses: {
          200: jsonResponse("Usuarios asignados", {
            $ref: "#/components/schemas/AssignResult",
          }),
          400: errorResponse("Datos inválidos", ["VALIDATION_ERROR"]),
          404: errorResponse("No existe", ["TASK_NOT_FOUND", "USER_NOT_FOUND"]),
          409: errorResponse("Conflicto", [
            "TASK_ARCHIVED",
            "IDEMPOTENCY_KEY_REUSED",
          ]),
        },
      },
    },

    "/tasks/{idTask}/complete": {
      post: {
        tags: ["Tareas"],
        summary: "Completar la parte de un usuario",
        description:
          "Marca como terminada la parte del usuario indicado.\n\n" +
          "Cuando **todos** los asignados han terminado, la tarea pasa a `archived` " +
          "y se dispara un POST a `NOTIFY_URL` con hasta 3 reintentos. La respuesta " +
          "no espera a esos reintentos: se consultan en " +
          "`GET /tasks/{idTask}/notifications`.\n\n" +
          "Completar dos veces la misma parte devuelve éxito, no error: es el caso " +
          "del doble clic. Si los dos últimos usuarios completan a la vez, la tarea " +
          "se archiva y se notifica **exactamente una vez**.",
        parameters: [
          {
            name: "idTask",
            in: "path",
            required: true,
            schema: { type: "integer", minimum: 1 },
            example: 1,
          },
          idempotencyHeader,
        ],
        requestBody: jsonBody("#/components/schemas/CompleteTask", { userId: 1 }),
        responses: {
          200: jsonResponse("Parte completada", {
            $ref: "#/components/schemas/CompleteResult",
          }),
          400: errorResponse("Datos inválidos", ["VALIDATION_ERROR"]),
          404: errorResponse("No existe", ["TASK_NOT_FOUND", "USER_NOT_FOUND"]),
          409: errorResponse("Conflicto", [
            "USER_NOT_ASSIGNED",
            "IDEMPOTENCY_KEY_REUSED",
          ]),
        },
      },
    },

    "/tasks/{idTask}/notifications": {
      get: {
        tags: ["Tareas"],
        summary: "Intentos de notificación de una tarea",
        description:
          "Bitácora de los envíos hacia `NOTIFY_URL`, de ambos tipos de evento " +
          "(`task.archived` y `task.due_soon`). Un `httpStatus` en `null` " +
          "significa que el destino no respondió (timeout o red caída). " +
          "Una tarea sin notificaciones devuelve una lista vacía.",
        parameters: [
          {
            name: "idTask",
            in: "path",
            required: true,
            schema: { type: "integer", minimum: 1 },
            example: 1,
          },
        ],
        responses: {
          200: jsonResponse("Intentos registrados", {
            $ref: "#/components/schemas/Notifications",
          }),
          400: errorResponse("ID no numérico", ["VALIDATION_ERROR"]),
          404: errorResponse("No existe", ["TASK_NOT_FOUND"]),
        },
      },
    },
  },

  components: {
    schemas: {
      Error: {
        type: "object",
        required: ["error"],
        properties: {
          error: {
            type: "object",
            required: ["code", "message"],
            properties: {
              code: { type: "string", enum: Object.keys(ERROR_CODES) },
              message: { type: "string" },
            },
          },
        },
      },

      CreateUser: {
        type: "object",
        required: ["name", "lastName", "email"],
        properties: {
          name: { type: "string", minLength: 1, example: "Ana" },
          lastName: { type: "string", minLength: 1, example: "Torres" },
          email: { type: "string", format: "email", example: "ana@geest.com" },
        },
      },

      User: {
        type: "object",
        properties: {
          id: { type: "integer", example: 1 },
          name: { type: "string", example: "Ana" },
          lastName: { type: "string", example: "Torres" },
          email: { type: "string", example: "ana@geest.com" },
          createdAt: { type: "string", format: "date-time" },
        },
      },

      UserWithPending: {
        allOf: [
          { $ref: "#/components/schemas/User" },
          {
            type: "object",
            properties: {
              pendingTasks: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    taskId: { type: "integer", example: 9 },
                    title: { type: "string", example: "Revisar contrato" },
                    status: { type: "string", enum: ["open", "archived"] },
                  },
                },
              },
            },
          },
        ],
      },

      UserTasks: {
        type: "object",
        properties: {
          userId: { type: "integer", example: 1 },
          tasks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "integer", example: 7 },
                title: { type: "string" },
                description: { type: "string", nullable: true },
                status: { type: "string", enum: ["open", "archived"] },
                completed: { type: "boolean" },
                completedAt: { type: "string", format: "date-time", nullable: true },
              },
            },
          },
        },
      },

      CreateTask: {
        type: "object",
        required: ["title"],
        properties: {
          title: { type: "string", minLength: 1, example: "Migrar servidor" },
          description: {
            type: "string",
            nullable: true,
            example: "Pasar la aplicación a la nueva VPS",
          },
          dueDate: {
            type: "string",
            format: "date-time",
            nullable: true,
            description:
              "Fecha límite opcional (ISO 8601). Alimenta el campo `urgency` y " +
              "el aviso automático `task.due_soon`.",
            example: "2026-09-01T18:00:00Z",
          },
        },
      },

      Assignee: {
        type: "object",
        properties: {
          userId: { type: "integer", example: 1 },
          name: { type: "string", example: "Ana" },
          lastName: { type: "string", example: "Torres" },
          email: { type: "string", example: "ana@geest.com" },
          completed: { type: "boolean", example: false },
          completedAt: { type: "string", format: "date-time", nullable: true },
        },
      },

      Task: {
        type: "object",
        properties: {
          id: { type: "integer", example: 7 },
          title: { type: "string", example: "Migrar servidor" },
          description: { type: "string", nullable: true },
          status: { type: "string", enum: ["open", "archived"], example: "open" },
          createdAt: { type: "string", format: "date-time" },
          archivedAt: { type: "string", format: "date-time", nullable: true },
          dueDate: { type: "string", format: "date-time", nullable: true },
          urgency: {
            type: "string",
            nullable: true,
            enum: ["green", "yellow", "red", null],
            description:
              "Semáforo calculado al vuelo. `green` faltan más de 48 h · " +
              "`yellow` faltan menos de 48 h · `red` ya venció y sigue abierta · " +
              "`null` sin fecha límite o ya archivada.",
            example: "green",
          },
          progress: {
            type: "object",
            properties: {
              completed: { type: "integer", example: 1 },
              total: { type: "integer", example: 3 },
            },
          },
          assignees: {
            type: "array",
            items: { $ref: "#/components/schemas/Assignee" },
          },
        },
      },

      AssignUsers: {
        type: "object",
        required: ["userIds"],
        properties: {
          userIds: {
            type: "array",
            minItems: 1,
            items: { type: "integer", minimum: 1 },
            example: [1, 2],
          },
        },
      },

      AssignResult: {
        type: "object",
        properties: {
          message: { type: "string", example: "Users assigned successfully" },
          taskId: { type: "integer", example: 7 },
          assigned: {
            type: "array",
            items: { type: "integer" },
            description: "Usuarios que se asignaron en esta llamada",
            example: [1, 2],
          },
          alreadyAssigned: {
            type: "array",
            items: { type: "integer" },
            description: "Usuarios que ya estaban asignados; no se duplicaron",
            example: [],
          },
        },
      },

      CompleteTask: {
        type: "object",
        required: ["userId"],
        properties: {
          userId: { type: "integer", minimum: 1, example: 1 },
        },
      },

      CompleteResult: {
        type: "object",
        properties: {
          message: { type: "string", example: "Task part completed successfully" },
          taskId: { type: "integer", example: 7 },
          userId: { type: "integer", example: 1 },
          completed: { type: "boolean", example: true },
          taskStatus: { type: "string", enum: ["open", "archived"] },
          archivedAt: { type: "string", format: "date-time", nullable: true },
          remainingUsers: {
            type: "integer",
            description: "Cuántos asignados faltan por completar su parte",
            example: 0,
          },
        },
      },

      Notifications: {
        type: "object",
        properties: {
          taskId: { type: "integer", example: 7 },
          attempts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                eventType: {
                  type: "string",
                  enum: ["task.archived", "task.due_soon"],
                  description:
                    "`task.archived` al completarse la tarea · " +
                    "`task.due_soon` aviso automático de vencimiento próximo.",
                  example: "task.archived",
                },
                attemptNumber: { type: "integer", example: 1 },
                timestamp: { type: "string", format: "date-time" },
                httpStatus: {
                  type: "integer",
                  nullable: true,
                  description: "null si el destino no respondió",
                  example: 500,
                },
                success: { type: "boolean", example: false },
              },
            },
          },
        },
      },
    },
  },
};

module.exports = openapi;

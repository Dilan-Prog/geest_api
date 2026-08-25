# RETO GEEST — Contrato de la API

Base URL local: `http://localhost:3000`
Formato de error único en toda la API:

```json
{ "error": { "code": "...", "message": "..." } }
```

## Catálogo de códigos de error

| HTTP | `code` | Cuándo |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Falta un campo obligatorio, tipo incorrecto, email inválido, `status` fuera de `open\|archived` |
| 404 | `TASK_NOT_FOUND` | La tarea del path no existe |
| 404 | `USER_NOT_FOUND` | El usuario del path o del body no existe |
| 409 | `EMAIL_ALREADY_EXISTS` | Ya hay un usuario con ese email |
| 409 | `TASK_ARCHIVED` | Se intenta asignar usuarios a una tarea ya archivada |
| 409 | `USER_NOT_ASSIGNED` | El usuario intenta completar una tarea que no tiene asignada |
| 409 | `IDEMPOTENCY_KEY_REUSED` | Misma `Idempotency-Key` con un body distinto |
| 409 | `IDEMPOTENCY_IN_PROGRESS` | La petición original sigue en vuelo tras el tiempo de espera |
| 500 | `INTERNAL_ERROR` | Fallo no controlado |

---

## 1. `POST /users`

**Body**
```json
{ "name": "Ana", "lastName": "Torres", "email": "ana@geest.com" }
```

**Validaciones**
- `name` — string no vacío. Obligatorio.
- `lastName` — string no vacío. Obligatorio.
- `email` — string, formato válido, único en la BD. Obligatorio.

**201 Created**
```json
{
  "id": 1,
  "name": "Ana",
  "lastName": "Torres",
  "email": "ana@geest.com",
  "createdAt": "2026-08-23T10:00:00.000Z"
}
```

**Errores** `400 VALIDATION_ERROR` · `409 EMAIL_ALREADY_EXISTS`

---

## 2. `POST /tasks`

**Body**
```json
{ "title": "Migrar servidor", "description": "Pasar a la nueva VPS" }
```

**Validaciones**
- `title` — string no vacío. **Obligatorio.**
- `description` — string o ausente. **Opcional** → se guarda `null`.

**201 Created**
```json
{
  "id": 7,
  "title": "Migrar servidor",
  "description": "Pasar a la nueva VPS",
  "status": "open",
  "createdAt": "2026-08-23T10:05:00.000Z",
  "archivedAt": null
}
```

**Errores** `400 VALIDATION_ERROR`

---

## 3. `POST /tasks/:idTask/assign`

**Body**
```json
{ "userIds": [1, 2, 3] }
```

**Validaciones**
- `userIds` — array no vacío de enteros positivos. Se deduplica en memoria antes de tocar la BD.
- La tarea debe existir y estar `open`.
- **Todos** los usuarios deben existir. Si alguno no existe, no se asigna ninguno (todo o nada).

**Comportamiento**
Se insertan las asignaciones dentro de una transacción con `createMany({ skipDuplicates: true })`.
El `UNIQUE(taskId, userId)` garantiza que reasignar a alguien ya asignado no duplique la fila.

**200 OK**
```json
{
  "message": "Users assigned successfully",
  "taskId": 7,
  "assigned": [1, 2],
  "alreadyAssigned": [3]
}
```

**Errores** `400 VALIDATION_ERROR` · `404 TASK_NOT_FOUND` · `404 USER_NOT_FOUND` · `409 TASK_ARCHIVED`

---

## 4. `POST /tasks/:idTask/complete`

**Body**
```json
{ "userId": 1 }
```

El endpoint más delicado del reto. Toda la lógica va dentro de una transacción que
abre con `SELECT id FROM tasks WHERE id = ? FOR UPDATE`, lo que serializa a dos
usuarios que completan al mismo tiempo.

**Pasos dentro de la transacción**
1. Bloquear la fila de la tarea (`FOR UPDATE`).
2. Verificar que la tarea y el usuario existen.
3. Verificar que existe la asignación → si no, `USER_NOT_ASSIGNED`.
4. Si `completed` ya era `true` → no se toca nada (idempotente natural).
5. Marcar `completed = true`, `completedAt = now()`.
6. Contar asignaciones pendientes de esa tarea.
7. Si quedan **0** pendientes **y** `status = 'open'` → `status = 'archived'`, `archivedAt = now()` y se activa la bandera `justArchived`.

**Fuera de la transacción**
Si `justArchived` es `true`, se dispara la notificación en segundo plano
(ver `docs/reliability.md`). La respuesta HTTP no espera a los reintentos.

**200 OK**
```json
{
  "message": "Task part completed successfully",
  "taskId": 7,
  "userId": 1,
  "completed": true,
  "taskStatus": "archived",
  "archivedAt": "2026-08-23T11:00:00.000Z",
  "remainingUsers": 0
}
```

**Errores** `400 VALIDATION_ERROR` · `404 TASK_NOT_FOUND` · `404 USER_NOT_FOUND` · `409 USER_NOT_ASSIGNED`

---

## 5. `GET /tasks`

**Query** `?status=open` · `?status=archived` · sin parámetro → todas.

**200 OK**
```json
[
  {
    "id": 7,
    "title": "Migrar servidor",
    "description": "Pasar a la nueva VPS",
    "status": "open",
    "createdAt": "2026-08-23T10:05:00.000Z",
    "archivedAt": null,
    "progress": { "completed": 1, "total": 3 },
    "assignees": [
      {
        "userId": 1,
        "name": "Ana",
        "lastName": "Torres",
        "email": "ana@geest.com",
        "completed": true,
        "completedAt": "2026-08-23T10:40:00.000Z"
      }
    ]
  }
]
```

**Errores** `400 VALIDATION_ERROR` si `status` no es `open` ni `archived`.

---

## 6. `GET /users`

Lista los usuarios con su información básica y **sus tareas pendientes**
(asignaciones con `completed = false`, sin importar el estado de la tarea).

**200 OK**
```json
[
  {
    "id": 1,
    "name": "Ana",
    "lastName": "Torres",
    "email": "ana@geest.com",
    "createdAt": "2026-08-23T10:00:00.000Z",
    "pendingTasks": [
      { "taskId": 9, "title": "Revisar contrato", "status": "open" }
    ]
  }
]
```

---

## 7. `GET /users/:idUser/tasks`

Todas las tareas del usuario, completadas o no.

**200 OK**
```json
{
  "userId": 1,
  "tasks": [
    {
      "id": 7,
      "title": "Migrar servidor",
      "description": "Pasar a la nueva VPS",
      "status": "archived",
      "completed": true,
      "completedAt": "2026-08-23T10:40:00.000Z"
    }
  ]
}
```

**Errores** `404 USER_NOT_FOUND`

---

## 8. `GET /tasks/:idTask`

Misma forma que un elemento de `GET /tasks`.

**Errores** `404 TASK_NOT_FOUND`

---

## 9. `GET /tasks/:idTask/notifications`

**200 OK**
```json
{
  "taskId": 7,
  "attempts": [
    { "attemptNumber": 1, "timestamp": "2026-08-23T11:00:00.000Z", "httpStatus": 500, "success": false },
    { "attemptNumber": 2, "timestamp": "2026-08-23T11:00:01.000Z", "httpStatus": null,  "success": false },
    { "attemptNumber": 3, "timestamp": "2026-08-23T11:00:03.000Z", "httpStatus": 200,   "success": true  }
  ]
}
```

`httpStatus: null` significa que el destino **no respondió** (timeout o red caída).
Una tarea nunca archivada devuelve `attempts: []`.

**Errores** `404 TASK_NOT_FOUND`

---

## Supuestos tomados ante ambigüedades

El enunciado no define estos casos. Se decidió y se documenta:

1. **Completar dos veces la misma parte** devuelve `200` con éxito, no error. Es el
   caso literal del doble clic que menciona la sección *Confiabilidad*.
2. **Asignar usuarios a una tarea archivada** devuelve `409 TASK_ARCHIVED`. Permitirlo
   dejaría una tarea archivada con partes pendientes, un estado incoherente.
3. **`assign` es todo o nada.** Si un solo `userId` del array no existe, no se asigna
   ninguno. Evita asignaciones parciales silenciosas.
4. **`userIds` duplicados en el mismo body** (`[1, 1, 2]`) se deduplican sin error.
5. **Email único.** El reto no lo pide, pero un sistema de gestión de personal sin
   email único permite registrar la misma persona dos veces.
6. **Los IDs no numéricos en el path** (`/tasks/abc`) devuelven `400 VALIDATION_ERROR`,
   no `404`.

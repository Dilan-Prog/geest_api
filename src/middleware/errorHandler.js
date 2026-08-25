const { AppError } = require("../errors");

function notFoundHandler(req, res) {
  res.status(404).json({
    error: {
      code: "ROUTE_NOT_FOUND",
      message: `Cannot ${req.method} ${req.path}`,
    },
  });
}

// eslint-disable-next-line no-unused-vars -- Express identifica el errorHandler por su aridad de 4
function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message },
    });
  }

  // JSON malformado en el body: lo lanza express.json()
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({
      error: { code: "VALIDATION_ERROR", message: "Request body is not valid JSON" },
    });
  }

  // Body por encima del límite de express.json(). Sin esta rama caería al 500
  // genérico de abajo: el cliente vería un fallo del servidor cuando en realidad
  // el error es suyo y sabe cómo corregirlo.
  if (err.type === "entity.too.large") {
    return res.status(413).json({
      error: {
        code: "PAYLOAD_TOO_LARGE",
        message: "Request body exceeds the maximum allowed size",
      },
    });
  }

  console.error("[unhandled]", err);
  return res.status(500).json({
    error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" },
  });
}

module.exports = { errorHandler, notFoundHandler };

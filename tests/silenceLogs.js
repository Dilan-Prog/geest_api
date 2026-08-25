/**
 * Silencia la consola durante los tests.
 *
 * Varias pruebas ejercitan a propósito caminos que registran algo: el notificador
 * sin NOTIFY_URL, el errorHandler ante un fallo simulado, el arranque del job.
 * Esos mensajes son la señal de que el código hace lo correcto, pero llenan la
 * salida de stack traces en una suite que pasa al 100% y dan la impresión
 * equivocada a quien la ejecuta por primera vez.
 *
 * Para verlos cuando haga falta depurar:
 *
 *   TEST_LOGS=1 npm test        (bash)
 *   $env:TEST_LOGS=1; npm test  (PowerShell)
 */
const SILENCED = ["log", "info", "warn", "error", "debug"];

if (!process.env.TEST_LOGS) {
  let spies = [];

  beforeAll(() => {
    spies = SILENCED.map((method) =>
      jest.spyOn(console, method).mockImplementation(() => {})
    );
  });

  afterAll(() => {
    spies.forEach((spy) => spy.mockRestore());
  });
}

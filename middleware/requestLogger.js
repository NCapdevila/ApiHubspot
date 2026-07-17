const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'access.log');

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Loguea una línea JSON por request a logs/access.log, con la agencia que la hizo
// (si la ruta usa authMiddleware). req.alianza recién queda seteado cuando termina
// el response, por eso se lee dentro del listener "finish" y no acá arriba.
function requestLogger(req, res, next) {
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    const line = {
      timestamp: new Date().toISOString(),
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Math.round(durationMs),
      agency: req.alianza?.agency ?? null,
      alianza: req.alianza?.name ?? null,
    };

    try {
      fs.appendFileSync(LOG_FILE, JSON.stringify(line) + '\n');
    } catch (err) {
      console.error('No se pudo escribir en logs/access.log:', err.message);
    }
  });

  next();
}

module.exports = requestLogger;

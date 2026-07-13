// Las keys viven en ALIANZAS_JSON (.env), nunca en el código fuente,
// porque este archivo sí se trackea en git.
// Formato: {"<api-key>": {"name": "<nombre>", "agency": "<valor exacto de Productor/Agencia en HubSpot>", "scopes": ["stats", "contacts"]}}
// "agency" es lo que autoriza a consultar esa key: no se toma de lo que mande el cliente.
// "scopes" es la lista de endpoints que esa key puede usar (ver requireScope).
function loadAlianzas() {
  const raw = process.env.ALIANZAS_JSON;
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error('ALIANZAS_JSON inválido en .env:', err.message);
    return {};
  }
}

const ALIANZAS = loadAlianzas();

function authMiddleware(req, res, next) {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey || !ALIANZAS[apiKey]) {
    return res.status(401).json({ error: 'API key inválida o ausente' });
  }

  req.alianza = ALIANZAS[apiKey];
  next();
}

// Restringe una ruta a las keys que tengan el scope indicado en su entrada de ALIANZAS_JSON.
function requireScope(scope) {
  return (req, res, next) => {
    if (!req.alianza?.scopes?.includes(scope)) {
      return res.status(403).json({ error: 'Esta alianza no tiene acceso a este endpoint' });
    }
    next();
  };
}

module.exports = { authMiddleware, requireScope };
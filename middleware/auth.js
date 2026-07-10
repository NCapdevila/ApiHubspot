// Las keys viven en ALIANZAS_JSON (.env), nunca en el código fuente,
// porque este archivo sí se trackea en git.
// Formato: {"<api-key>": {"name": "<nombre>", "agency": "<valor exacto de Productor/Agencia en HubSpot>"}}
// "agency" es lo que autoriza a consultar esa key: no se toma de lo que mande el cliente.
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

module.exports = authMiddleware;
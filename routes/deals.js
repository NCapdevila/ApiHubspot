const express = require('express');
const router = express.Router();
const { authMiddleware: auth, requireScope } = require('../middleware/auth');
const hubspotService = require('../services/hubspotServices');
const { toPublicDeal, toPublicContact } = require('../utils/filters');

// GET /deals/:id/status  -> estado de un deal puntual (uso interno, no expuesto a alianzas)
router.get('/deals/:id/status', auth, requireScope('internal'), async (req, res) => {
  try {
    const deal = await hubspotService.getDealById(req.params.id);
    res.json(toPublicDeal(deal));
  } catch (err) {
    console.error(err.response?.data || err.message);
    if (err.response?.status === 404) {
      return res.status(404).json({ error: 'Deal no encontrado' });
    }
    res.status(500).json({ error: 'Error consultando HubSpot' });
  }
});

// GET /deals/by-contact?email=xxx  -> deals asociados a un contacto por email (uso interno, no expuesto a alianzas)
router.get('/deals/by-contact', auth, requireScope('internal'), async (req, res) => {
  const { email } = req.query;
  if (!email) {
    return res.status(400).json({ error: 'Falta el parámetro email' });
  }

  try {
    const contact = await hubspotService.searchContactByEmail(email);
    if (!contact) {
      return res.status(404).json({ error: 'Contacto no encontrado' });
    }

    const dealAssociations = await hubspotService.getDealsByContactId(contact.id);
    const deals = await Promise.all(
      dealAssociations.map((assoc) => hubspotService.getDealById(assoc.id))
    );

    res.json({
      contact: toPublicContact(contact),
      deals: deals.map(toPublicDeal),
    });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Error consultando HubSpot' });
  }
});

function parseAgencyDateParams(req, res) {
  const { agency: requestedAgency, from, to } = req.query;
  const dateField = req.query.dateField || 'createdate';
  const agency = req.alianza.agency;

  if (!agency) {
    res.status(403).json({ error: 'Esta alianza no tiene una agencia asociada' });
    return null;
  }
  if (requestedAgency && requestedAgency !== agency) {
    res.status(403).json({ error: 'No autorizado para consultar esa agencia' });
    return null;
  }
  if (!['createdate', 'closedate'].includes(dateField)) {
    res.status(400).json({ error: 'dateField debe ser "createdate" o "closedate"' });
    return null;
  }

  return { agency, from, to, dateField };
}

// GET /deals/stats/by-producer-agency?from=2026-01-01&to=2026-06-30&dateField=createdate
// Cantidad de deals de contactos cuyo "Productor/Agencia" == la agencia autorizada
// para la api-key usada, agrupados por etapa.
router.get('/deals/stats/by-producer-agency', auth, requireScope('stats'), async (req, res) => {
  const params = parseAgencyDateParams(req, res);
  if (!params) return;

  try {
    const stats = await hubspotService.getDealStatsByProducerAgency(params.agency, params);
    res.json(stats);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Error consultando HubSpot' });
  }
});

// GET /deals/by-producer-agency?from=2026-01-01&to=2026-06-30&dateField=createdate
// Listado de deals de la agencia autorizada, con datos del contacto y etapa.
// Si la etapa es "No interesado", incluye el comentario cargado en el deal.
router.get('/deals/by-producer-agency', auth, requireScope('contacts'), async (req, res) => {
  const params = parseAgencyDateParams(req, res);
  if (!params) return;

  try {
    const list = await hubspotService.getDealsListByProducerAgency(params.agency, params);
    res.json(list);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Error consultando HubSpot' });
  }
});

module.exports = router;

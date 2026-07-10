const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const hubspotService = require('../services/hubspotServices');
const { toPublicDeal, toPublicContact } = require('../utils/filters');

// GET /deals/:id/status  -> estado de un deal puntual
router.get('/deals/:id/status', auth, async (req, res) => {
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

// GET /deals/by-contact?email=xxx  -> deals asociados a un contacto por email
router.get('/deals/by-contact', auth, async (req, res) => {
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

// GET /deals/stats/by-producer-agency?from=2026-01-01&to=2026-06-30&dateField=createdate
// Cantidad de deals de contactos cuyo "Productor/Agencia" == la agencia autorizada
// para la api-key usada, agrupados por etapa.
router.get('/deals/stats/by-producer-agency', auth, async (req, res) => {
  const { agency: requestedAgency, from, to } = req.query;
  const dateField = req.query.dateField || 'createdate';
  const agency = req.alianza.agency;

  if (!agency) {
    return res.status(403).json({ error: 'Esta alianza no tiene una agencia asociada' });
  }
  if (requestedAgency && requestedAgency !== agency) {
    return res.status(403).json({ error: 'No autorizado para consultar esa agencia' });
  }
  if (!['createdate', 'closedate'].includes(dateField)) {
    return res.status(400).json({ error: 'dateField debe ser "createdate" o "closedate"' });
  }

  try {
    const stats = await hubspotService.getDealStatsByProducerAgency(agency, { from, to, dateField });
    res.json(stats);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Error consultando HubSpot' });
  }
});

module.exports = router;
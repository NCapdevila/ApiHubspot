const express = require('express');
const router = express.Router();
const { authMiddleware: auth, requireScope } = require('../middleware/auth');
const hubspotService = require('../services/hubspotServices');
const { validateLeadPayload } = require('../utils/leadValidation');

// POST /leads (scope "leads")
// Crea (o actualiza) un cliente y su deal asociado en HubSpot, para la agencia de
// la alianza autenticada. La agencia y el origen del lead nunca se toman del body:
// siempre salen de la api-key usada.
//
// Body esperado:
// {
//   "contact": { "email", "phone", "firstName"?, "lastName"?, "companyName"?, "whatsappPhone"?,
//                "dateOfBirth"?, "country"?, "state"?, "city"?, "zip"? },
//   "deal": { "tipoRiesgo": "AUTO", "agencia"?, "details": { ...campos según tipoRiesgo... } }
// }
// "email" y "phone" son siempre obligatorios. "companyName" es la alternativa a
// firstName + lastName: si viene, el cliente es una empresa y se crea como Company
// en HubSpot (buscada por nombre + agencia) en vez de como Contact; firstName y
// lastName dejan de ser obligatorios, y "dateOfBirth"/"whatsappPhone" no aplican
// (el objeto Company no tiene esas propiedades). Si no viene companyName,
// firstName y lastName siguen siendo obligatorios.
// "agencia" es opcional: identifica la sub-agencia dentro de una alianza multi-agencia
// (ej. Lucy). No reemplaza "productor_agencia", que siempre sale de la alianza autenticada.
router.post('/leads', auth, requireScope('leads'), async (req, res) => {
  if (!req.alianza.agency) {
    return res.status(403).json({ error: 'Esta alianza no tiene una agencia asociada' });
  }

  const errors = validateLeadPayload(req.body);
  if (errors.length > 0) {
    return res.status(400).json({ error: 'Datos inválidos', details: errors });
  }

  const { contact, deal } = req.body;

  try {
    const result = await hubspotService.createLead({
      agency: req.alianza.agency,
      leadSource: "AlianzasExternas",
      contact,
      tipoRiesgo: deal.tipoRiesgo,
      details: deal.details,
      agencia: deal.agencia,
    });
    res.status(201).json(result);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Error creando el lead en HubSpot' });
  }
});

module.exports = router;

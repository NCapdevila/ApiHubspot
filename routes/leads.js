const express = require('express');
const multer = require('multer');
const router = express.Router();
const { authMiddleware: auth, requireScope } = require('../middleware/auth');
const hubspotService = require('../services/hubspotServices');
const { validateLeadPayload } = require('../utils/leadValidation');

const MAX_FILE_MB = 10;
const ALLOWED_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

// El archivo se procesa en memoria y se manda derecho a HubSpot: no se escribe
// a disco, así no quedan facturas de clientes en el filesystem del server.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 1 },
});

// Envuelve a multer para devolver 400 con el mismo shape que el resto de los
// errores de validación, en vez de que el error caiga en el handler de Express.
function uploadAttachment(req, res, next) {
  upload.single('archivo')(req, res, (err) => {
    if (!err) return next();

    const detail =
      err.code === 'LIMIT_FILE_SIZE'
        ? `El archivo supera el máximo de ${MAX_FILE_MB} MB`
        : `No se pudo leer el archivo adjunto: ${err.message}`;

    return res.status(400).json({ error: 'Datos inválidos', details: [detail] });
  });
}

// POST /leads (scope "leads")
// Crea (o actualiza) un cliente y su deal asociado en HubSpot, para la agencia de
// la alianza autenticada. La agencia y el origen del lead nunca se toman del body:
// siempre salen de la api-key usada.
//
// Body esperado:
// {
//   "contact": { "email", "phone", "firstName"?, "lastName"?, "companyName"?, "dni"?,
//                "whatsappPhone"?, "dateOfBirth"?, "country"?, "state"?, "city"?, "zip"? },
//   "deal": { "tipoRiesgo": "AUTO"|"HOGAR", "agencia"?, "emitida"?, "dealstage"?,
//             "details": { ...campos según tipoRiesgo... } }
// }
// "emitida" (opcional, default false) elige la variante de alta: sin ella el lead
// entra como oportunidad nueva (etapa "Nuevo" del pipeline de ventas); con
// "emitida": true entra directo al pipeline de pólizas ya emitidas.
// "dealstage" (opcional) permite mandar cualquier otra etapa por ID de HubSpot.
// El pipeline NO se manda: se deriva del ID de la etapa. Prioridad para fijar la
// etapa: dealstage > emitida > "Nuevo". Mandar dealstage y emitida juntos da 400.
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
      emitida: deal.emitida === true,
      dealstage: deal.dealstage,
    });
    res.status(201).json(result);
  } catch (err) {
    console.error(err.response?.data || err.message);
    // Errores por datos del request (ej. un dealstage que no existe) van como 400:
    // el que manda el lead puede corregirlo, no es una falla del server.
    if (err.isRequestError) {
      return res.status(400).json({ error: 'Datos inválidos', details: [err.message] });
    }
    res.status(500).json({ error: 'Error creando el lead en HubSpot' });
  }
});

// POST /leads/with-attachment (scope "leads")
// Igual que POST /leads pero con un archivo adjunto (ej. la factura de compra en
// MOVILIDAD). El archivo se sube a HubSpot y se cuelga del deal como nota, que es
// lo que lo hace aparecer en la tarjeta "Archivos adjuntos" del registro.
//
// Se manda como multipart/form-data con dos campos:
//   payload  -> el MISMO JSON que recibe POST /leads, como string
//   archivo  -> el archivo (PDF/JPG/PNG/WEBP, hasta 10 MB)
//
// No es específico de una alianza ni de un tipoRiesgo: sirve para cualquier lead
// que tenga que venir con un adjunto.
router.post(
  '/leads/with-attachment',
  auth,
  requireScope('leads'),
  uploadAttachment,
  async (req, res) => {
    if (!req.alianza.agency) {
      return res.status(403).json({ error: 'Esta alianza no tiene una agencia asociada' });
    }

    if (!req.file) {
      return res.status(400).json({
        error: 'Datos inválidos',
        details: ['Falta el archivo adjunto (campo "archivo" del form-data)'],
      });
    }

    if (!ALLOWED_MIME_TYPES.includes(req.file.mimetype)) {
      return res.status(400).json({
        error: 'Datos inválidos',
        details: [
          `Tipo de archivo no permitido: ${req.file.mimetype}. Válidos: ${ALLOWED_MIME_TYPES.join(', ')}`,
        ],
      });
    }

    // En multipart los campos llegan como texto: el JSON del lead viaja en "payload".
    let body;
    try {
      body = JSON.parse(req.body.payload);
    } catch {
      return res.status(400).json({
        error: 'Datos inválidos',
        details: ['El campo "payload" debe ser un JSON válido con { contact, deal }'],
      });
    }

    const errors = validateLeadPayload(body);
    if (errors.length > 0) {
      return res.status(400).json({ error: 'Datos inválidos', details: errors });
    }

    const { contact, deal } = body;

    try {
      const result = await hubspotService.createLeadWithAttachment({
        agency: req.alianza.agency,
        leadSource: 'AlianzasExternas',
        contact,
        tipoRiesgo: deal.tipoRiesgo,
        details: deal.details,
        agencia: deal.agencia,
        emitida: deal.emitida === true,
        dealstage: deal.dealstage,
        attachment: req.file,
        noteBody: deal.notaAdjunto,
      });
      res.status(201).json(result);
    } catch (err) {
      console.error(err.response?.data || err.message);
      if (err.isRequestError) {
        return res.status(400).json({ error: 'Datos inválidos', details: [err.message] });
      }
      res.status(500).json({ error: 'Error creando el lead en HubSpot' });
    }
  }
);

module.exports = router;

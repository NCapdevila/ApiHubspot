const { getDealSchema, getSupportedRiskTypes } = require('../services/leadSchemas');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTACT_REQUIRED_FIELDS = ['email', 'firstName', 'lastName', 'phone'];

// Valida el body de POST /leads.
// Devuelve un array de errores (vacío si el body es válido).
// No valida ni conoce "agency"/"leadSource": eso lo fuerza el server, nunca viene del body.
function validateLeadPayload(body) {
  const errors = [];
  const contact = body?.contact;
  const deal = body?.deal;

  if (!contact || typeof contact !== 'object') {
    errors.push('Falta el objeto "contact"');
  } else {
    for (const field of CONTACT_REQUIRED_FIELDS) {
      if (!contact[field]) errors.push(`Falta el campo contact.${field}`);
    }
    if (contact.email && !EMAIL_REGEX.test(contact.email)) {
      errors.push('contact.email no tiene un formato válido');
    }
  }

  if (!deal || typeof deal !== 'object') {
    errors.push('Falta el objeto "deal"');
    return errors;
  }

  const { tipoRiesgo, details } = deal;
  if (!tipoRiesgo) {
    errors.push('Falta deal.tipoRiesgo');
  } else {
    const schema = getDealSchema(tipoRiesgo);
    if (!schema) {
      errors.push(
        `deal.tipoRiesgo "${tipoRiesgo}" no soportado. Válidos: ${getSupportedRiskTypes().join(', ')}`
      );
    } else {
      const data = details || {};
      for (const field of schema.requiredFields) {
        if (data[field] === undefined || data[field] === null || data[field] === '') {
          errors.push(`Falta el campo deal.details.${field}`);
        }
      }
    }
  }

  return errors;
}

module.exports = { validateLeadPayload };

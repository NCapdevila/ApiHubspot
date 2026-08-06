const { getDealSchema, getSupportedRiskTypes } = require('../services/leadSchemas');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PERSON_REQUIRED_FIELDS = ['email', 'firstName', 'lastName', 'phone'];
const COMPANY_REQUIRED_FIELDS = ['email', 'phone'];

// Valida el body de POST /leads.
// Devuelve un array de errores (vacío si el body es válido).
// No valida ni conoce "agency"/"leadSource": eso lo fuerza el server, nunca viene del body.
//
// El cliente puede ser una persona o una empresa:
// - persona: firstName + lastName obligatorios (flujo histórico).
// - empresa: companyName en vez de firstName/lastName (se modela como Company en HubSpot).
// email y phone son obligatorios en ambos casos.
function validateLeadPayload(body) {
  const errors = [];
  const contact = body?.contact;
  const deal = body?.deal;

  if (!contact || typeof contact !== 'object') {
    errors.push('Falta el objeto "contact"');
  } else {
    const { companyName } = contact;
    const hasCompanyNameField = companyName !== undefined && companyName !== null;
    const isCompany = typeof companyName === 'string' && companyName.trim() !== '';

    if (hasCompanyNameField && !isCompany) {
      errors.push('contact.companyName debe ser un string no vacío');
    }

    for (const field of isCompany ? COMPANY_REQUIRED_FIELDS : PERSON_REQUIRED_FIELDS) {
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

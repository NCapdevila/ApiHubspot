// Define, por tipo de riesgo, qué campos son obligatorios en "deal.details"
// y cómo se mapean a las propiedades internas de HubSpot.
//
// Para sumar un tipo de riesgo nuevo (ej. VIDA), agregar una entrada acá con su
// propio requiredFields y toHubspotProperties. No requiere tocar rutas ni
// servicios: el endpoint /leads valida y mapea automáticamente contra esto.
//
// Hooks opcionales por schema:
//   normalizeDetails(details) -> details   se aplica ANTES de validar y de mapear,
//                                          para aceptar alias de nombres de campo.
//   validateDetails(details)  -> string[]  validaciones propias del riesgo, además
//                                          de requiredFields.

// "amount" en HubSpot es numérico. Aceptamos número o string y limpiamos espacios
// y símbolo de moneda, pero NO adivinamos separador de miles: mandar un monto
// equivocado es peor que rechazar el lead. Se rechaza todo lo ambiguo:
//   "150.000"    -> ¿150000 o 150? (punto + 3 dígitos = separador de miles es-AR)
//   "150.000,50" -> tiene coma, no sabemos qué separador es cuál
// Se acepta el formato sin ambigüedad: entero, o punto con 1-2 decimales.
function parseAmount(value) {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { ok: true, value: String(value) } : { ok: false, value: null };
  }

  const cleaned = String(value).replace(/\s/g, '').replace(/^(ars|\$)+/i, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return { ok: false, value: null };

  return { ok: true, value: cleaned };
}

const DEAL_SCHEMAS = {
  AUTO: {
    requiredFields: [
      'marca',
      'modelo',
      'version',
      'anio',
      'numeroMotor',
      'numeroChasis',
      'es0km',
    ],
    // "patente" y "esPrendado" son opcionales: si no vienen, no mandamos la
    // propiedad a HubSpot (queda vacía) en vez de guardar un valor inventado.
    toHubspotProperties: (details) => ({
      tipo_riesgo: 'AUTO',
      ...(details.patente ? { patente_vehiculo: details.patente } : {}),
      marca_vehiculo: details.marca,
      modelo_vehiculo: details.modelo,
      version_vehiculo: details.version,
      anio_vehiculo: details.anio,
      numero_motor: details.numeroMotor,
      numero_chasis: details.numeroChasis,
      es_0km: !!details.es0km,
      ...(details.esPrendado === undefined || details.esPrendado === null
        ? {}
        : { es_prendado: !!details.esPrendado }),
    }),
  },

  HOGAR: {
    // El form de esta alianza manda los nombres internos de HubSpot; el resto de
    // las alianzas usa camelCase. Se aceptan las dos formas y se normaliza acá,
    // así el resto del flujo trabaja con un solo juego de nombres.
    normalizeDetails: (details = {}) => ({
      tipoHogar: details.tipoHogar ?? details.tipo_hogar,
      ambientes: details.ambientes ?? details.ambientes_hogar,
      amount: details.amount,
      comentarios: details.comentarios ?? details.comments,
    }),

    requiredFields: ['tipoHogar', 'ambientes'],

    validateDetails: (details) => {
      const errors = [];
      const { ambientes, amount } = details;

      if (ambientes !== undefined && ambientes !== null && ambientes !== '') {
        if (!Number.isFinite(Number(ambientes))) {
          errors.push('deal.details.ambientes debe ser un número');
        }
      }
      if (!parseAmount(amount).ok) {
        errors.push(
          'deal.details.amount debe ser un número sin separador de miles ni símbolo de moneda (ej. 150000 o 150000.50)'
        );
      }

      return errors;
    },

    // "amount" y "comentarios" son opcionales: si no vienen, no se manda la
    // propiedad en vez de pisarla con un valor vacío.
    toHubspotProperties: (details) => {
      const amount = parseAmount(details.amount).value;
      return {
        tipo_riesgo: 'HOGAR',
        tipo_hogar: details.tipoHogar,
        ambientes_hogar: Number(details.ambientes),
        ...(amount !== null ? { amount } : {}),
        ...(details.comentarios ? { comentarios: details.comentarios } : {}),
      };
    },
  },

  // VIDA:  { requiredFields: [...], toHubspotProperties: (details) => ({...}) },
};

function getDealSchema(tipoRiesgo) {
  return DEAL_SCHEMAS[tipoRiesgo] || null;
}

function getSupportedRiskTypes() {
  return Object.keys(DEAL_SCHEMAS);
}

// Aplica el normalizeDetails del schema (si tiene). Se usa tanto al validar como
// al mapear, para que ambos vean exactamente los mismos campos.
function normalizeDealDetails(schema, details) {
  const data = details || {};
  return schema?.normalizeDetails ? schema.normalizeDetails(data) : data;
}

module.exports = { getDealSchema, getSupportedRiskTypes, normalizeDealDetails };

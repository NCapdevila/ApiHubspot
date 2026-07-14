// Define, por tipo de riesgo, qué campos son obligatorios en "deal.details"
// y cómo se mapean a las propiedades internas de HubSpot.
//
// Para sumar un tipo de riesgo nuevo (ej. HOGAR, VIDA), agregar una entrada acá
// con su propio requiredFields y toHubspotProperties. No requiere tocar rutas
// ni servicios: el endpoint /leads valida y mapea automáticamente contra esto.

const DEAL_SCHEMAS = {
  AUTO: {
    requiredFields: [
      'patente',
      'marca',
      'modelo',
      'version',
      'anio',
      'numeroMotor',
      'numeroChasis',
      'es0km',
    ],
    toHubspotProperties: (details) => ({
      tipo_riesgo: 'AUTO',
      patente_vehiculo: details.patente,
      marca_vehiculo: details.marca,
      modelo_vehiculo: details.modelo,
      version_vehiculo: details.version,
      anio_vehiculo: details.anio,
      numero_motor: details.numeroMotor,
      numero_chasis: details.numeroChasis,
      es_0km: !!details.es0km,
    }),
  },

  // HOGAR: { requiredFields: [...], toHubspotProperties: (details) => ({...}) },
  // VIDA:  { requiredFields: [...], toHubspotProperties: (details) => ({...}) },
};

function getDealSchema(tipoRiesgo) {
  return DEAL_SCHEMAS[tipoRiesgo] || null;
}

function getSupportedRiskTypes() {
  return Object.keys(DEAL_SCHEMAS);
}

module.exports = { getDealSchema, getSupportedRiskTypes };

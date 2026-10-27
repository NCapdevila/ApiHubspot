// Test sin framework: `node test/leads.test.js`.
// Mockea el cliente HTTP de HubSpot (config/hubspot) reemplazando sus métodos
// antes de cargar el servicio, y verifica contra las requests realmente emitidas.
//
// Cubre:
//  1. lead persona (firstName/lastName) -> mismo flujo de siempre (upsert Contact + deal asociado)
//  2. lead empresa (companyName) -> crea Company y asocia el deal
//  3. lead empresa existente -> PATCH sobre la Company, sin crear una nueva
//  4. payload sin companyName y sin firstName/lastName -> falla la validación
//  5. listado por agencia -> unifica deals de contactos y de empresas, con "type" y email real

const assert = require('assert');
const hubspotClient = require('../config/hubspot');

// --- Mock del cliente HTTP -------------------------------------------------

let calls = [];
let handlers = {};

function handle(method, url, body) {
  calls.push({ method, url, body });

  const key = `${method} ${url}`;
  const handler = handlers[key] || handlers[`${method} *`];
  if (!handler) {
    throw new Error(`Request no mockeada: ${key}`);
  }
  return Promise.resolve({ data: typeof handler === 'function' ? handler(body, url) : handler });
}

hubspotClient.get = (url) => handle('GET', url);
hubspotClient.post = (url, body) => handle('POST', url, body);
hubspotClient.patch = (url, body) => handle('PATCH', url, body);
hubspotClient.put = (url, body) => handle('PUT', url, body);

// Metadata compartida. Los internal names a propósito NO son iguales entre
// contacts y companies: si el código hardcodeara uno, los tests fallan.
const STAGE_NUEVO = 'stage-nuevo';
const STAGE_EN_PROCESO = 'stage-en-proceso';
const PIPELINE_ID = 'pipeline-1';
// IDs reales del pipeline de pólizas ya emitidas (CE BROKERS - CLIENTES).
const EMITIDA_PIPELINE_ID = '907998512';
const EMITIDA_STAGE_ID = '1377519216';
const CONTACT_AGENCY_PROPERTY = 'productor_agencia';
const COMPANY_AGENCY_PROPERTY = 'productor_agencia_empresa';

const META_HANDLERS = {
  'GET /crm/v3/properties/contacts': {
    results: [
      { name: 'email', label: 'Email' },
      { name: CONTACT_AGENCY_PROPERTY, label: 'Productor/Agencia' },
    ],
  },
  'GET /crm/v3/properties/companies': {
    results: [
      { name: 'name', label: 'Nombre de la empresa' },
      { name: COMPANY_AGENCY_PROPERTY, label: 'Productor/Agencia' },
    ],
  },
  'GET /crm/v3/pipelines/deals': {
    results: [
      {
        id: PIPELINE_ID,
        stages: [
          { id: STAGE_NUEVO, label: 'Nuevo' },
          { id: STAGE_EN_PROCESO, label: 'En proceso' },
          { id: 'stage-emitida', label: 'Emitida' },
          { id: 'stage-no-interesado', label: 'No interesado' },
          // "Cliente" existe en los dos pipelines: por eso la variante emitida
          // se resuelve por ID y no por label.
          { id: 'stage-cliente-ventas', label: 'Cliente' },
        ],
      },
      {
        id: EMITIDA_PIPELINE_ID,
        stages: [
          { id: EMITIDA_STAGE_ID, label: 'Cliente' },
          { id: '1377519218', label: 'Axr Emitido' },
        ],
      },
    ],
  },
};

function setup(extraHandlers) {
  calls = [];
  handlers = { ...META_HANDLERS, ...extraHandlers };
}

function callsTo(method, url) {
  return calls.filter((c) => c.method === method && c.url === url);
}

// El servicio se carga DESPUÉS de mockear el cliente.
const hubspotService = require('../services/hubspotServices');
const { validateLeadPayload } = require('../utils/leadValidation');

// --- Fixtures --------------------------------------------------------------

const AGENCY = 'Alianza Test';

const DEAL_DETAILS = {
  marca: 'Ford',
  modelo: 'Focus',
  version: 'SE',
  anio: '2020',
  numeroMotor: 'M123',
  numeroChasis: 'C456',
  es0km: false,
  patente: 'AB123CD',
};

const PERSON_CONTACT = {
  email: 'juan@example.com',
  firstName: 'Juan',
  lastName: 'Perez',
  phone: '+541100000000',
  city: 'CABA',
};

const COMPANY_CONTACT = {
  email: 'contacto@transportes.com',
  companyName: 'Transportes SRL',
  phone: '+541199999999',
  whatsappPhone: '+541198888888',
  country: 'Argentina',
  state: 'Buenos Aires',
  city: 'La Plata',
  zip: '1900',
};

// --- Runner ----------------------------------------------------------------

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// --- 1. Lead persona: flujo intacto ---------------------------------------

test('lead persona: hace upsert de Contact y crea el deal asociado al contacto', async () => {
  setup({
    'POST /crm/v3/objects/contacts/batch/upsert': { results: [{ id: '101' }] },
    'POST /crm/v3/objects/deals': { id: '901' },
  });

  const result = await hubspotService.createLead({
    agency: AGENCY,
    leadSource: 'AlianzasExternas',
    contact: PERSON_CONTACT,
    tipoRiesgo: 'AUTO',
    details: DEAL_DETAILS,
    agencia: 'SubAgencia1',
  });

  const [upsert] = callsTo('POST', '/crm/v3/objects/contacts/batch/upsert');
  assert.ok(upsert, 'debe hacer upsert del contacto');
  const props = upsert.body.inputs[0].properties;
  assert.strictEqual(upsert.body.inputs[0].idProperty, 'email');
  assert.strictEqual(props.firstname, 'Juan');
  assert.strictEqual(props.lastname, 'Perez');
  assert.strictEqual(props.email, PERSON_CONTACT.email);
  assert.strictEqual(props.phone, PERSON_CONTACT.phone);
  assert.strictEqual(props.hs_whatsapp_phone_number, PERSON_CONTACT.phone, 'cae al phone');
  assert.strictEqual(props.city, 'CABA');
  assert.strictEqual(props.productor_agencia, AGENCY);
  assert.strictEqual(props.lead_source, 'AlianzasExternas');
  assert.strictEqual(props.lifecyclestage, 'lead');

  const [deal] = callsTo('POST', '/crm/v3/objects/deals');
  assert.deepStrictEqual(deal.body.associations, [
    { to: { id: '101' }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }] },
  ]);
  assert.strictEqual(deal.body.properties.dealstage, STAGE_NUEVO);
  assert.strictEqual(deal.body.properties.pipeline, PIPELINE_ID);
  assert.strictEqual(deal.body.properties.agencia, 'SubAgencia1');
  assert.strictEqual(
    deal.body.properties.dealname,
    `${AGENCY} - SubAgencia1 - AUTO - AB123CD - ${PERSON_CONTACT.email}`
  );
  assert.strictEqual(deal.body.properties.patente_vehiculo, 'AB123CD');

  // Nada del flujo de empresas debe dispararse.
  assert.strictEqual(callsTo('POST', '/crm/v3/objects/companies/search').length, 0);
  assert.strictEqual(callsTo('POST', '/crm/v3/objects/companies').length, 0);

  // Shape de respuesta igual que antes del cambio.
  assert.deepStrictEqual(result, {
    contact: { id: '101', email: PERSON_CONTACT.email, firstName: 'Juan', lastName: 'Perez' },
    deal: {
      id: '901',
      name: `${AGENCY} - SubAgencia1 - AUTO - AB123CD - ${PERSON_CONTACT.email}`,
      stage: 'Nuevo',
      pipeline: PIPELINE_ID,
    },
  });
});

// --- 2. Lead empresa nuevo ------------------------------------------------

test('lead empresa: crea la Company y asocia el deal con la asociación default', async () => {
  setup({
    'POST /crm/v3/objects/companies/search': { results: [] }, // no existe todavía
    'POST /crm/v3/objects/companies': { id: '501' },
    'POST /crm/v3/objects/deals': { id: '902' },
    'PUT /crm/v4/objects/deals/902/associations/default/companies/501': {},
  });

  const result = await hubspotService.createLead({
    agency: AGENCY,
    leadSource: 'AlianzasExternas',
    contact: COMPANY_CONTACT,
    tipoRiesgo: 'AUTO',
    details: DEAL_DETAILS,
  });

  // No se toca el objeto Contact.
  assert.strictEqual(callsTo('POST', '/crm/v3/objects/contacts/batch/upsert').length, 0);

  // Búsqueda por nombre exacto + agencia, usando el internal name resuelto por label.
  const [search] = callsTo('POST', '/crm/v3/objects/companies/search');
  assert.deepStrictEqual(search.body.filterGroups, [
    {
      filters: [
        { propertyName: 'name', operator: 'EQ', value: 'Transportes SRL' },
        { propertyName: COMPANY_AGENCY_PROPERTY, operator: 'EQ', value: AGENCY },
      ],
    },
  ]);

  // Nunca vía batch/upsert con idProperty name/domain: HubSpot lo rechaza.
  assert.strictEqual(callsTo('POST', '/crm/v3/objects/companies/batch/upsert').length, 0);

  const [created] = callsTo('POST', '/crm/v3/objects/companies');
  assert.ok(created, 'debe crear la company');
  assert.strictEqual(created.body.properties.name, 'Transportes SRL');
  assert.strictEqual(created.body.properties.email, COMPANY_CONTACT.email);
  assert.strictEqual(created.body.properties.phone, COMPANY_CONTACT.phone);
  assert.strictEqual(
    created.body.properties.hs_whatsapp_phone_number,
    undefined,
    'la propiedad no existe en Companies'
  );
  assert.strictEqual(created.body.properties.country, 'Argentina');
  assert.strictEqual(created.body.properties.state, 'Buenos Aires');
  assert.strictEqual(created.body.properties.city, 'La Plata');
  assert.strictEqual(created.body.properties.zip, '1900');
  assert.strictEqual(created.body.properties[COMPANY_AGENCY_PROPERTY], AGENCY);
  assert.strictEqual(created.body.properties.date_of_birth, undefined, 'no aplica a empresas');

  // El deal se crea sin associations inline y se asocia después, sin typeId numérico.
  const [deal] = callsTo('POST', '/crm/v3/objects/deals');
  assert.strictEqual(deal.body.associations, undefined);
  assert.strictEqual(deal.body.properties.dealstage, STAGE_NUEVO);
  assert.strictEqual(
    deal.body.properties.dealname,
    `${AGENCY} - AUTO - AB123CD - ${COMPANY_CONTACT.email}`
  );

  assert.strictEqual(
    callsTo('PUT', '/crm/v4/objects/deals/902/associations/default/companies/501').length,
    1,
    'debe asociar el deal a la company'
  );

  assert.deepStrictEqual(result, {
    company: { id: '501', name: 'Transportes SRL', email: COMPANY_CONTACT.email },
    deal: {
      id: '902',
      name: `${AGENCY} - AUTO - AB123CD - ${COMPANY_CONTACT.email}`,
      stage: 'Nuevo',
      pipeline: PIPELINE_ID,
    },
  });
});

// --- 3. Lead empresa ya existente -----------------------------------------

test('lead empresa existente: hace PATCH y no crea una company duplicada', async () => {
  setup({
    'POST /crm/v3/objects/companies/search': { results: [{ id: '777', properties: {} }] },
    'PATCH /crm/v3/objects/companies/777': { id: '777' },
    'POST /crm/v3/objects/deals': { id: '903' },
    'PUT /crm/v4/objects/deals/903/associations/default/companies/777': {},
  });

  const result = await hubspotService.createLead({
    agency: AGENCY,
    leadSource: 'AlianzasExternas',
    contact: COMPANY_CONTACT,
    tipoRiesgo: 'AUTO',
    details: DEAL_DETAILS,
  });

  assert.strictEqual(callsTo('POST', '/crm/v3/objects/companies').length, 0, 'no debe crear otra');
  const [patch] = callsTo('PATCH', '/crm/v3/objects/companies/777');
  assert.ok(patch, 'debe actualizar la company existente');
  assert.strictEqual(patch.body.properties.email, COMPANY_CONTACT.email);
  assert.strictEqual(result.company.id, '777');
  assert.strictEqual(
    callsTo('PUT', '/crm/v4/objects/deals/903/associations/default/companies/777').length,
    1
  );
});

// --- 4. Validación --------------------------------------------------------

test('validación: sin companyName y sin firstName/lastName falla', () => {
  const errors = validateLeadPayload({
    contact: { email: 'x@example.com', phone: '+5411' },
    deal: { tipoRiesgo: 'AUTO', details: DEAL_DETAILS },
  });

  assert.ok(errors.includes('Falta el campo contact.firstName'), JSON.stringify(errors));
  assert.ok(errors.includes('Falta el campo contact.lastName'), JSON.stringify(errors));
});

test('validación: lead persona completo pasa', () => {
  const errors = validateLeadPayload({
    contact: PERSON_CONTACT,
    deal: { tipoRiesgo: 'AUTO', details: DEAL_DETAILS },
  });
  assert.deepStrictEqual(errors, []);
});

test('validación: lead empresa sin firstName/lastName pasa', () => {
  const errors = validateLeadPayload({
    contact: COMPANY_CONTACT,
    deal: { tipoRiesgo: 'AUTO', details: DEAL_DETAILS },
  });
  assert.deepStrictEqual(errors, []);
});

test('validación: email y phone siguen siendo obligatorios para empresas', () => {
  const errors = validateLeadPayload({
    contact: { companyName: 'Transportes SRL' },
    deal: { tipoRiesgo: 'AUTO', details: DEAL_DETAILS },
  });
  assert.ok(errors.includes('Falta el campo contact.email'), JSON.stringify(errors));
  assert.ok(errors.includes('Falta el campo contact.phone'), JSON.stringify(errors));
});

test('validación: companyName vacío o no-string es inválido', () => {
  for (const companyName of ['', '   ', 42, {}]) {
    const errors = validateLeadPayload({
      contact: { email: 'x@example.com', phone: '+5411', companyName },
      deal: { tipoRiesgo: 'AUTO', details: DEAL_DETAILS },
    });
    assert.ok(
      errors.includes('contact.companyName debe ser un string no vacío'),
      `companyName=${JSON.stringify(companyName)} -> ${JSON.stringify(errors)}`
    );
  }
});

// --- 5. Listado por agencia: personas + empresas ---------------------------

test('listado por agencia: unifica deals de contactos y de empresas', async () => {
  setup({
    'POST /crm/v3/objects/contacts/search': {
      results: [
        {
          id: 'c1',
          properties: {
            email: 'juan@example.com',
            firstname: 'Juan',
            lastname: 'Perez',
            phone: '+5411',
          },
        },
      ],
    },
    'POST /crm/v3/objects/companies/search': {
      results: [
        {
          id: 'co1',
          properties: {
            name: 'Transportes SRL',
            email: 'contacto@transportes.com',
            phone: '+5411999',
          },
        },
      ],
    },
    'POST /crm/v4/associations/contacts/deals/batch/read': {
      results: [{ from: { id: 'c1' }, to: [{ toObjectId: 901 }] }],
    },
    'POST /crm/v4/associations/companies/deals/batch/read': {
      results: [{ from: { id: 'co1' }, to: [{ toObjectId: 902 }] }],
    },
    'POST /crm/v3/objects/deals/batch/read': {
      results: [
        { id: '901', properties: { dealstage: STAGE_EN_PROCESO, createdate: '2026-01-15T10:00:00Z' } },
        { id: '902', properties: { dealstage: STAGE_EN_PROCESO, createdate: '2026-01-16T10:00:00Z' } },
      ],
    },
  });

  const list = await hubspotService.getDealsListByProducerAgency(AGENCY);

  assert.strictEqual(list.total, 2, 'los deals de empresa no deben quedar afuera');

  const person = list.deals.find((d) => d.dealId === '901');
  assert.deepStrictEqual(person, {
    dealId: '901',
    type: 'person',
    firstName: 'Juan',
    lastName: 'Perez',
    phone: '+5411',
    email: 'juan@example.com',
    stage: 'En proceso',
  });

  const company = list.deals.find((d) => d.dealId === '902');
  assert.deepStrictEqual(company, {
    dealId: '902',
    type: 'company',
    companyName: 'Transportes SRL',
    phone: '+5411999',
    email: 'contacto@transportes.com', // email real de la company, no null
    stage: 'En proceso',
  });

  // La búsqueda de empresas usa el internal name resuelto por label.
  const [companySearch] = callsTo('POST', '/crm/v3/objects/companies/search');
  assert.strictEqual(
    companySearch.body.filterGroups[0].filters[0].propertyName,
    COMPANY_AGENCY_PROPERTY
  );

  // Y las stats cuentan ambos.
  setup({
    'POST /crm/v3/objects/contacts/search': { results: [{ id: 'c1', properties: {} }] },
    'POST /crm/v3/objects/companies/search': { results: [{ id: 'co1', properties: {} }] },
    'POST /crm/v4/associations/contacts/deals/batch/read': {
      results: [{ from: { id: 'c1' }, to: [{ toObjectId: 901 }] }],
    },
    'POST /crm/v4/associations/companies/deals/batch/read': {
      results: [{ from: { id: 'co1' }, to: [{ toObjectId: 902 }] }],
    },
    'POST /crm/v3/objects/deals/batch/read': {
      results: [
        { id: '901', properties: { dealstage: STAGE_EN_PROCESO, createdate: '2026-01-15T10:00:00Z' } },
        { id: '902', properties: { dealstage: STAGE_EN_PROCESO, createdate: '2026-01-16T10:00:00Z' } },
      ],
    },
  });

  const stats = await hubspotService.getDealStatsByProducerAgency(AGENCY);
  assert.strictEqual(stats.totalDeals, 2);
  assert.strictEqual(stats.byStage['En proceso'], 2);
});

// --- 6. Campos opcionales del listado: agencia y comments -----------------

const OPTIONAL_FIELDS_HANDLERS = {
  'POST /crm/v3/objects/contacts/search': {
    results: [
      { id: 'c1', properties: { email: 'juan@example.com', firstname: 'Juan', lastname: 'Perez' } },
    ],
  },
  'POST /crm/v3/objects/companies/search': {
    results: [{ id: 'co1', properties: { name: 'Transportes SRL', email: 'contacto@t.com' } }],
  },
  'POST /crm/v4/associations/contacts/deals/batch/read': {
    results: [{ from: { id: 'c1' }, to: [{ toObjectId: 901 }] }],
  },
  'POST /crm/v4/associations/companies/deals/batch/read': {
    results: [{ from: { id: 'co1' }, to: [{ toObjectId: 902 }] }],
  },
  'POST /crm/v3/objects/deals/batch/read': {
    results: [
      {
        id: '901',
        properties: {
          dealstage: 'stage-no-interesado',
          createdate: '2026-01-15T10:00:00Z',
          comentarios: 'Ya tiene póliza vigente',
        },
      },
      {
        id: '902',
        properties: {
          dealstage: STAGE_EN_PROCESO,
          createdate: '2026-01-16T10:00:00Z',
          agencia: 'SubAgencia1',
        },
      },
    ],
  },
};

test('listado: "comments" sólo en No interesado y "agencia" sólo si el deal la tiene', async () => {
  setup(OPTIONAL_FIELDS_HANDLERS);

  const list = await hubspotService.getDealsListByProducerAgency('Lucy', {
    from: '2026-01-01',
    to: '2026-01-31',
  });

  // El sobre repite los parámetros recibidos.
  assert.strictEqual(list.agency, 'Lucy');
  assert.strictEqual(list.dateField, 'createdate');
  assert.deepStrictEqual(list.range, { from: '2026-01-01', to: '2026-01-31' });
  assert.strictEqual(list.total, 2);

  const noInteresado = list.deals.find((d) => d.dealId === '901');
  assert.strictEqual(noInteresado.stage, 'No interesado');
  assert.strictEqual(noInteresado.comments, 'Ya tiene póliza vigente');
  assert.ok(!('agencia' in noInteresado), 'sin sub-agencia, la clave no debe estar');

  const conAgencia = list.deals.find((d) => d.dealId === '902');
  assert.strictEqual(conAgencia.agencia, 'SubAgencia1');
  assert.ok(!('comments' in conAgencia), 'comments sólo aplica a No interesado');
});

test('stats: byAgencia desglosa por sub-agencia incluyendo deals de empresa', async () => {
  setup(OPTIONAL_FIELDS_HANDLERS);

  const stats = await hubspotService.getDealStatsByProducerAgency('Lucy', {
    from: '2026-01-01',
    to: '2026-01-31',
  });

  assert.strictEqual(stats.totalDeals, 2);
  assert.deepStrictEqual(stats.byStage, {
    'En proceso': 1,
    Emitida: 0,
    'No interesado': 1,
  });
  assert.strictEqual(stats.otrasEtapas, 0);
  // El deal de la sub-agencia es de un cliente empresa: antes no entraba acá.
  assert.deepStrictEqual(stats.byAgencia, {
    SubAgencia1: {
      byStage: { 'En proceso': 1, Emitida: 0, 'No interesado': 0 },
      otrasEtapas: 0,
      totalDeals: 1,
    },
  });
  assert.strictEqual(stats.etapasNoEncontradas, undefined);
});

// --- 7. HOGAR -------------------------------------------------------------

const HOGAR_CONTACT = {
  email: 'ana@example.com',
  firstName: 'Ana',
  lastName: 'Gomez',
  dni: '30123456',
  phone: '+541155555555',
  state: 'Buenos Aires',
  city: 'La Plata',
  zip: '1900',
};

const HOGAR_DETAILS = {
  tipoHogar: 'Casa',
  ambientes: 3,
  amount: '150000',
  comentarios: 'Cliente derivado',
};

test('HOGAR: mapea las propiedades del riesgo y el dni del contacto', async () => {
  setup({
    'POST /crm/v3/objects/contacts/batch/upsert': { results: [{ id: '111' }] },
    'POST /crm/v3/objects/deals': { id: '910' },
  });

  const result = await hubspotService.createLead({
    agency: 'AlianzaHogar',
    leadSource: 'AlianzasExternas',
    contact: HOGAR_CONTACT,
    tipoRiesgo: 'HOGAR',
    details: HOGAR_DETAILS,
  });

  const [upsert] = callsTo('POST', '/crm/v3/objects/contacts/batch/upsert');
  assert.strictEqual(upsert.body.inputs[0].properties.dni, '30123456');
  assert.strictEqual(upsert.body.inputs[0].properties.state, 'Buenos Aires');

  const [deal] = callsTo('POST', '/crm/v3/objects/deals');
  assert.strictEqual(deal.body.properties.tipo_riesgo, 'HOGAR');
  assert.strictEqual(deal.body.properties.tipo_hogar, 'Casa');
  assert.strictEqual(deal.body.properties.ambientes_hogar, 3);
  assert.strictEqual(deal.body.properties.amount, '150000');
  assert.strictEqual(deal.body.properties.comentarios, 'Cliente derivado');
  assert.strictEqual(deal.body.properties.m2_hogar, undefined, 'el form no lo manda');
  // Sin patente: HOGAR no la usa aunque el dealname la soporte para AUTO.
  assert.strictEqual(
    deal.body.properties.dealname,
    `AlianzaHogar - HOGAR - ${HOGAR_CONTACT.email}`
  );

  // Variante por defecto: pipeline de ventas, etapa "Nuevo".
  assert.strictEqual(deal.body.properties.pipeline, PIPELINE_ID);
  assert.strictEqual(deal.body.properties.dealstage, STAGE_NUEVO);
  assert.strictEqual(result.deal.stage, 'Nuevo');
  assert.strictEqual(result.deal.pipeline, PIPELINE_ID);
});

test('HOGAR: acepta los nombres internos de HubSpot como alias', async () => {
  setup({
    'POST /crm/v3/objects/contacts/batch/upsert': { results: [{ id: '112' }] },
    'POST /crm/v3/objects/deals': { id: '911' },
  });

  const snakeDetails = { tipo_hogar: 'Departamento', ambientes_hogar: 2, amount: 90000 };

  assert.deepStrictEqual(
    validateLeadPayload({ contact: HOGAR_CONTACT, deal: { tipoRiesgo: 'HOGAR', details: snakeDetails } }),
    [],
    'el alias snake_case debe pasar la validación'
  );

  await hubspotService.createLead({
    agency: 'AlianzaHogar',
    leadSource: 'AlianzasExternas',
    contact: HOGAR_CONTACT,
    tipoRiesgo: 'HOGAR',
    details: snakeDetails,
  });

  const [deal] = callsTo('POST', '/crm/v3/objects/deals');
  assert.strictEqual(deal.body.properties.tipo_hogar, 'Departamento');
  assert.strictEqual(deal.body.properties.ambientes_hogar, 2);
  assert.strictEqual(deal.body.properties.amount, '90000');
});

test('HOGAR emitida: usa el pipeline y la etapa de pólizas emitidas', async () => {
  setup({
    'POST /crm/v3/objects/contacts/batch/upsert': { results: [{ id: '113' }] },
    'POST /crm/v3/objects/deals': { id: '912' },
  });

  const result = await hubspotService.createLead({
    agency: 'AlianzaHogar',
    leadSource: 'AlianzasExternas',
    contact: HOGAR_CONTACT,
    tipoRiesgo: 'HOGAR',
    details: HOGAR_DETAILS,
    emitida: true,
  });

  const [deal] = callsTo('POST', '/crm/v3/objects/deals');
  assert.strictEqual(deal.body.properties.pipeline, EMITIDA_PIPELINE_ID);
  assert.strictEqual(deal.body.properties.dealstage, EMITIDA_STAGE_ID);
  // El label sale del pipeline real, no de una constante del código.
  assert.strictEqual(result.deal.stage, 'Cliente');
  assert.strictEqual(result.deal.pipeline, EMITIDA_PIPELINE_ID);

  // El resto del alta no cambia: sigue siendo un contacto con su deal asociado.
  assert.deepStrictEqual(deal.body.associations, [
    { to: { id: '113' }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }] },
  ]);
});

test('HOGAR: faltan tipoHogar/ambientes -> error de validación', () => {
  const errors = validateLeadPayload({
    contact: HOGAR_CONTACT,
    deal: { tipoRiesgo: 'HOGAR', details: { amount: '1000' } },
  });
  assert.ok(errors.includes('Falta el campo deal.details.tipoHogar'), JSON.stringify(errors));
  assert.ok(errors.includes('Falta el campo deal.details.ambientes'), JSON.stringify(errors));
});

test('HOGAR: amount ambiguo se rechaza en vez de mandar un monto mal', () => {
  // "150.000" y "1.500" son ambiguos (¿separador de miles o decimal?): se rechazan.
  const malos = ['150.000,50', '$150.000', '150.000', '1.500', '1.500,00', '1.500.000', 'abc'];
  for (const amount of malos) {
    const errors = validateLeadPayload({
      contact: HOGAR_CONTACT,
      deal: { tipoRiesgo: 'HOGAR', details: { ...HOGAR_DETAILS, amount } },
    });
    assert.ok(
      errors.some((e) => e.startsWith('deal.details.amount')),
      `amount="${amount}" debería fallar -> ${JSON.stringify(errors)}`
    );
  }

  const buenos = ['150000', '150000.50', 150000, '$150000', ' 150000 ', undefined];
  for (const amount of buenos) {
    const errors = validateLeadPayload({
      contact: HOGAR_CONTACT,
      deal: { tipoRiesgo: 'HOGAR', details: { ...HOGAR_DETAILS, amount } },
    });
    assert.deepStrictEqual(errors, [], `amount=${JSON.stringify(amount)} debería pasar`);
  }
});

test('deal.emitida debe ser booleano', () => {
  const errors = validateLeadPayload({
    contact: HOGAR_CONTACT,
    deal: { tipoRiesgo: 'HOGAR', details: HOGAR_DETAILS, emitida: 'si' },
  });
  assert.ok(errors.includes('deal.emitida debe ser true o false'), JSON.stringify(errors));
});

test('AUTO sigue sin verse afectado por los hooks nuevos', () => {
  assert.deepStrictEqual(
    validateLeadPayload({ contact: PERSON_CONTACT, deal: { tipoRiesgo: 'AUTO', details: DEAL_DETAILS } }),
    []
  );
  assert.ok(
    validateLeadPayload({
      contact: PERSON_CONTACT,
      deal: { tipoRiesgo: 'AUTO', details: { ...DEAL_DETAILS, marca: undefined } },
    }).includes('Falta el campo deal.details.marca')
  );
});

// --- 8. deal.dealstage: etapa explícita por ID ----------------------------

test('dealstage: usa la etapa mandada y deriva el pipeline del ID', async () => {
  setup({
    'POST /crm/v3/objects/contacts/batch/upsert': { results: [{ id: '120' }] },
    'POST /crm/v3/objects/deals': { id: '920' },
  });

  // Etapa del pipeline de ventas, distinta de "Nuevo".
  const result = await hubspotService.createLead({
    agency: 'AlianzaHogar',
    leadSource: 'AlianzasExternas',
    contact: HOGAR_CONTACT,
    tipoRiesgo: 'HOGAR',
    details: HOGAR_DETAILS,
    dealstage: 'stage-emitida',
  });

  const [deal] = callsTo('POST', '/crm/v3/objects/deals');
  assert.strictEqual(deal.body.properties.dealstage, 'stage-emitida');
  assert.strictEqual(deal.body.properties.pipeline, PIPELINE_ID, 'pipeline derivado del ID');
  assert.strictEqual(result.deal.stage, 'Emitida');
});

test('dealstage: una etapa de otro pipeline arrastra su propio pipeline', async () => {
  setup({
    'POST /crm/v3/objects/contacts/batch/upsert': { results: [{ id: '121' }] },
    'POST /crm/v3/objects/deals': { id: '921' },
  });

  const result = await hubspotService.createLead({
    agency: 'AlianzaHogar',
    leadSource: 'AlianzasExternas',
    contact: HOGAR_CONTACT,
    tipoRiesgo: 'HOGAR',
    details: HOGAR_DETAILS,
    dealstage: '1377519218', // "Axr Emitido", del pipeline de clientes
  });

  const [deal] = callsTo('POST', '/crm/v3/objects/deals');
  assert.strictEqual(deal.body.properties.dealstage, '1377519218');
  assert.strictEqual(deal.body.properties.pipeline, EMITIDA_PIPELINE_ID);
  assert.strictEqual(result.deal.stage, 'Axr Emitido');
});

test('dealstage: acepta number y tiene prioridad sobre emitida', async () => {
  setup({
    'POST /crm/v3/objects/contacts/batch/upsert': { results: [{ id: '122' }] },
    'POST /crm/v3/objects/deals': { id: '922' },
  });

  await hubspotService.createLead({
    agency: 'AlianzaHogar',
    leadSource: 'AlianzasExternas',
    contact: HOGAR_CONTACT,
    tipoRiesgo: 'HOGAR',
    details: HOGAR_DETAILS,
    dealstage: 1377519218,
    emitida: true, // el service prioriza dealstage; la ruta igual rechaza el combo
  });

  const [deal] = callsTo('POST', '/crm/v3/objects/deals');
  assert.strictEqual(deal.body.properties.dealstage, '1377519218', 'number -> string');
});

test('dealstage: sin dealstage ni emitida sigue entrando en "Nuevo"', async () => {
  setup({
    'POST /crm/v3/objects/contacts/batch/upsert': { results: [{ id: '123' }] },
    'POST /crm/v3/objects/deals': { id: '923' },
  });

  const result = await hubspotService.createLead({
    agency: 'AlianzaHogar',
    leadSource: 'AlianzasExternas',
    contact: HOGAR_CONTACT,
    tipoRiesgo: 'HOGAR',
    details: HOGAR_DETAILS,
  });

  const [deal] = callsTo('POST', '/crm/v3/objects/deals');
  assert.strictEqual(deal.body.properties.dealstage, STAGE_NUEVO);
  assert.strictEqual(result.deal.stage, 'Nuevo');
});

test('dealstage: un ID inexistente da error de request (400), no 500', async () => {
  setup({
    'POST /crm/v3/objects/contacts/batch/upsert': { results: [{ id: '124' }] },
    'POST /crm/v3/objects/deals': { id: '924' },
  });

  let err = null;
  try {
    await hubspotService.createLead({
      agency: 'AlianzaHogar',
      leadSource: 'AlianzasExternas',
      contact: HOGAR_CONTACT,
      tipoRiesgo: 'HOGAR',
      details: HOGAR_DETAILS,
      dealstage: '999999999',
    });
  } catch (e) {
    err = e;
  }

  assert.ok(err, 'debe lanzar');
  assert.strictEqual(err.isRequestError, true, 'la ruta lo traduce a 400');
  assert.ok(err.message.includes('999999999'), err.message);
  // Refresca la caché de pipelines una vez antes de rechazar, por si es nueva.
  assert.strictEqual(callsTo('GET', '/crm/v3/pipelines/deals').length, 1);
  // Y no crea el deal.
  assert.strictEqual(callsTo('POST', '/crm/v3/objects/deals').length, 0);
});

test('validación: dealstage mal formado y combinado con emitida', () => {
  for (const dealstage of ['', '   ', {}, true]) {
    const errors = validateLeadPayload({
      contact: HOGAR_CONTACT,
      deal: { tipoRiesgo: 'HOGAR', details: HOGAR_DETAILS, dealstage },
    });
    assert.ok(
      errors.some((e) => e.startsWith('deal.dealstage')),
      `dealstage=${JSON.stringify(dealstage)} -> ${JSON.stringify(errors)}`
    );
  }

  // Formas válidas
  for (const dealstage of ['1333717761', 1333717761]) {
    assert.deepStrictEqual(
      validateLeadPayload({
        contact: HOGAR_CONTACT,
        deal: { tipoRiesgo: 'HOGAR', details: HOGAR_DETAILS, dealstage },
      }),
      []
    );
  }

  // Combinado con emitida -> contradictorio
  const combo = validateLeadPayload({
    contact: HOGAR_CONTACT,
    deal: { tipoRiesgo: 'HOGAR', details: HOGAR_DETAILS, dealstage: '1333717761', emitida: true },
  });
  assert.ok(
    combo.some((e) => e.includes('No se pueden combinar')),
    JSON.stringify(combo)
  );
});

// --- 9. MOVILIDAD ---------------------------------------------------------

// Los 6 campos que manda la alianza: nombre, apellido, telefono, mail, codigo
// postal (todos en contact) + el riesgo. La factura va aparte, como adjunto.
const MOVILIDAD_CONTACT = {
  firstName: 'Lucas',
  lastName: 'Diaz',
  email: 'lucas.diaz@example.com',
  phone: '+5491155550010',
  zip: '1425',
};

test('MOVILIDAD: alta con los 6 campos, sin details obligatorios', async () => {
  setup({
    'POST /crm/v3/objects/contacts/batch/upsert': { results: [{ id: '130' }] },
    'POST /crm/v3/objects/deals': { id: '930' },
  });

  // details es opcional: el riesgo no tiene campos propios.
  assert.deepStrictEqual(
    validateLeadPayload({ contact: MOVILIDAD_CONTACT, deal: { tipoRiesgo: 'MOVILIDAD' } }),
    []
  );

  const result = await hubspotService.createLead({
    agency: 'lauty',
    leadSource: 'AlianzasExternas',
    contact: MOVILIDAD_CONTACT,
    tipoRiesgo: 'MOVILIDAD',
  });

  const [upsert] = callsTo('POST', '/crm/v3/objects/contacts/batch/upsert');
  const props = upsert.body.inputs[0].properties;
  assert.strictEqual(props.firstname, 'Lucas');
  assert.strictEqual(props.lastname, 'Diaz');
  assert.strictEqual(props.email, MOVILIDAD_CONTACT.email);
  assert.strictEqual(props.phone, MOVILIDAD_CONTACT.phone);
  assert.strictEqual(props.zip, '1425');
  assert.strictEqual(props.productor_agencia, 'lauty');

  const [deal] = callsTo('POST', '/crm/v3/objects/deals');
  assert.strictEqual(deal.body.properties.tipo_riesgo, 'MOVILIDAD');
  assert.strictEqual(deal.body.properties.dealstage, STAGE_NUEVO);
  assert.strictEqual(
    deal.body.properties.dealname,
    `lauty - MOVILIDAD - ${MOVILIDAD_CONTACT.email}`
  );
  assert.strictEqual(result.deal.stage, 'Nuevo');
});

test('MOVILIDAD: amount y comentarios opcionales, con la misma validacion', async () => {
  setup({
    'POST /crm/v3/objects/contacts/batch/upsert': { results: [{ id: '131' }] },
    'POST /crm/v3/objects/deals': { id: '931' },
  });

  await hubspotService.createLead({
    agency: 'lauty',
    leadSource: 'AlianzasExternas',
    contact: MOVILIDAD_CONTACT,
    tipoRiesgo: 'MOVILIDAD',
    details: { amount: '85000', comments: 'Monopatin electrico' },
  });

  const [deal] = callsTo('POST', '/crm/v3/objects/deals');
  assert.strictEqual(deal.body.properties.amount, '85000');
  assert.strictEqual(deal.body.properties.comentarios, 'Monopatin electrico');

  // El amount ambiguo se rechaza igual que en HOGAR.
  const errors = validateLeadPayload({
    contact: MOVILIDAD_CONTACT,
    deal: { tipoRiesgo: 'MOVILIDAD', details: { amount: '85.000' } },
  });
  assert.ok(errors.some((e) => e.startsWith('deal.details.amount')), JSON.stringify(errors));
});

test('MOVILIDAD: aparece en los tipos de riesgo soportados', () => {
  const errors = validateLeadPayload({
    contact: MOVILIDAD_CONTACT,
    deal: { tipoRiesgo: 'NOEXISTE' },
  });
  assert.ok(errors.some((e) => e.includes('MOVILIDAD')), JSON.stringify(errors));
});

// --- 10. Lead con adjunto -------------------------------------------------

const FACTURA = {
  buffer: Buffer.from('factura-falsa'),
  originalname: 'factura.pdf',
  mimetype: 'application/pdf',
};

const ATTACHMENT_HANDLERS = {
  'POST /files/v3/files': { id: '7001', name: 'factura.pdf', url: 'https://files/7001' },
  'POST /crm/v3/objects/contacts/batch/upsert': { results: [{ id: '140' }] },
  'POST /crm/v3/objects/deals': { id: '940' },
  'POST /crm/v3/objects/notes': { id: '8001' },
  'PUT /crm/v4/objects/notes/8001/associations/default/deals/940': {},
  'PUT /crm/v4/objects/notes/8001/associations/default/contacts/140': {},
};

test('adjunto: sube el archivo ANTES de crear nada en el CRM', async () => {
  setup(ATTACHMENT_HANDLERS);

  const result = await hubspotService.createLeadWithAttachment({
    agency: 'Seguros Movilidad Sancor',
    leadSource: 'AlianzasExternas',
    contact: MOVILIDAD_CONTACT,
    tipoRiesgo: 'MOVILIDAD',
    attachment: FACTURA,
  });

  // El orden importa: si el archivo falla, no debe quedar un lead sin factura.
  const escrituras = calls.filter((c) => c.method !== 'GET').map((c) => c.url);
  const idxArchivo = escrituras.indexOf('/files/v3/files');
  const idxContacto = escrituras.indexOf('/crm/v3/objects/contacts/batch/upsert');
  assert.ok(idxArchivo >= 0, 'debe subir el archivo');
  assert.ok(idxArchivo < idxContacto, `archivo (${idxArchivo}) debe ir antes del contacto (${idxContacto})`);

  // Nota con el adjunto, asociada al deal y al contacto.
  const [nota] = callsTo('POST', '/crm/v3/objects/notes');
  assert.strictEqual(nota.body.properties.hs_attachment_ids, '7001');
  assert.ok(nota.body.properties.hs_note_body.includes('Seguros Movilidad Sancor'));
  assert.ok(nota.body.properties.hs_timestamp, 'la nota necesita timestamp');

  assert.strictEqual(
    callsTo('PUT', '/crm/v4/objects/notes/8001/associations/default/deals/940').length,
    1,
    'la nota se asocia al deal'
  );
  assert.strictEqual(
    callsTo('PUT', '/crm/v4/objects/notes/8001/associations/default/contacts/140').length,
    1,
    'y al contacto'
  );

  assert.deepStrictEqual(result.attachment, {
    fileId: '7001',
    name: 'factura.pdf',
    url: 'https://files/7001',
    noteId: '8001',
  });
  // Y sigue devolviendo el lead normal.
  assert.strictEqual(result.contact.id, '140');
  assert.strictEqual(result.deal.id, '940');
});

test('adjunto: si falla la subida no se crea nada en el CRM', async () => {
  setup({
    ...ATTACHMENT_HANDLERS,
    'POST /files/v3/files': () => {
      throw new Error('413 archivo demasiado grande');
    },
  });

  await assert.rejects(() =>
    hubspotService.createLeadWithAttachment({
      agency: 'Seguros Movilidad Sancor',
      leadSource: 'AlianzasExternas',
      contact: MOVILIDAD_CONTACT,
      tipoRiesgo: 'MOVILIDAD',
      attachment: FACTURA,
    })
  );

  assert.strictEqual(callsTo('POST', '/crm/v3/objects/contacts/batch/upsert').length, 0);
  assert.strictEqual(callsTo('POST', '/crm/v3/objects/deals').length, 0);
  assert.strictEqual(callsTo('POST', '/crm/v3/objects/notes').length, 0);
});

test('adjunto: un lead empresa asocia la nota a la company', async () => {
  setup({
    ...ATTACHMENT_HANDLERS,
    'POST /crm/v3/objects/companies/search': { results: [] },
    'POST /crm/v3/objects/companies': { id: '600' },
    'PUT /crm/v4/objects/deals/940/associations/default/companies/600': {},
    'PUT /crm/v4/objects/notes/8001/associations/default/companies/600': {},
  });

  const result = await hubspotService.createLeadWithAttachment({
    agency: 'Seguros Movilidad Sancor',
    leadSource: 'AlianzasExternas',
    contact: { ...COMPANY_CONTACT, companyName: 'Movilidad SRL' },
    tipoRiesgo: 'MOVILIDAD',
    attachment: FACTURA,
  });

  assert.strictEqual(
    callsTo('PUT', '/crm/v4/objects/notes/8001/associations/default/companies/600').length,
    1
  );
  // No hay contacto: no debe intentar asociar la nota a uno.
  assert.strictEqual(
    calls.filter((c) => c.url.includes('/notes/8001/associations/default/contacts/')).length,
    0
  );
  assert.strictEqual(result.company.id, '600');
  assert.strictEqual(result.attachment.fileId, '7001');
});

// --- Ejecución ------------------------------------------------------------

(async () => {
  let failed = 0;

  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ok  - ${name}`);
    } catch (err) {
      failed++;
      console.error(`  FAIL - ${name}`);
      console.error(`        ${err.message}`);
    }
  }

  console.log(`\n${tests.length - failed}/${tests.length} tests OK`);
  if (failed > 0) process.exitCode = 1;
})();

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

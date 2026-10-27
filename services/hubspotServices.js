const hubspotClient = require('../config/hubspot');
const { getDealSchema, normalizeDealDetails } = require('./leadSchemas');

const DEAL_PROPERTIES = 'dealname,dealstage,amount,pipeline,closedate,createdate';
const CONTACT_PROPERTIES = 'email,firstname,lastname,phone';

const PRODUCER_AGENCY_PROPERTY_LABEL = 'Productor/Agencia';
const TARGET_STAGE_LABELS = ['En proceso', 'Emitida', 'No interesado'];
const NO_INTERESADO_LABEL = 'No interesado';
const INITIAL_STAGE_LABEL = 'Nuevo';

// Variante "ya emitida": el lead no entra como oportunidad nueva sino directo al
// pipeline de clientes, en una etapa concreta. Acá sí se usan IDs y no labels,
// al revés que en el resto del archivo: la etapa "Cliente" existe con ese mismo
// nombre en los dos pipelines, así que el label es ambiguo y el ID no.
const EMITIDA_PIPELINE_ID = '907998512'; // CE BROKERS - CLIENTES
const EMITIDA_STAGE_ID = '1377519216'; // "Cliente"

// Carpeta de la biblioteca de Files donde van los adjuntos de las alianzas.
// HubSpot la crea sola la primera vez que se sube algo.
const ATTACHMENT_FOLDER_PATH = '/alianzas-adjuntos';
const COMMENTS_PROPERTY = 'comentarios';
const SUB_AGENCY_PROPERTY = 'agencia';
const META_CACHE_TTL_MS = 60 * 60 * 1000; // 1h

const CONTACT_LIST_PROPERTIES = ['email', 'firstname', 'lastname', 'phone'];
// "email" es una propiedad custom del objeto Companies (internal name "email"),
// creada a mano en HubSpot: el objeto Company no trae email por defecto.
const COMPANY_LIST_PROPERTIES = ['name', 'email', 'phone'];
const DEAL_LIST_PROPERTIES = ['dealstage', 'pipeline', 'createdate', 'closedate', COMMENTS_PROPERTY, SUB_AGENCY_PROPERTY];

const producerAgencyPropertyCache = new Map(); // objectType -> { name, expiresAt }
let pipelineStageCache = null; // { pipelineId, stageIdToLabel, labelToStageId, allStageIdToLabel, missingLabels, expiresAt }

async function getDealById(dealId) {
  const { data } = await hubspotClient.get(`/crm/v3/objects/deals/${dealId}`, {
    params: {
      properties: DEAL_PROPERTIES,
      associations: 'contacts',
    },
  });
  return data;
}

async function getContactById(contactId) {
  const { data } = await hubspotClient.get(`/crm/v3/objects/contacts/${contactId}`, {
    params: { properties: CONTACT_PROPERTIES },
  });
  return data;
}

async function getDealsByContactId(contactId) {
  const { data } = await hubspotClient.get(
    `/crm/v3/objects/contacts/${contactId}/associations/deals`
  );
  return data.results; // array de { id, type }
}

async function searchContactByEmail(email) {
  const { data } = await hubspotClient.post('/crm/v3/objects/contacts/search', {
    filterGroups: [
      { filters: [{ propertyName: 'email', operator: 'EQ', value: email }] },
    ],
    properties: CONTACT_PROPERTIES.split(','),
  });
  return data.results[0] || null;
}

// Resuelve el internal name de la propiedad "Productor/Agencia" a partir de su label,
// ya que HubSpot no garantiza que labels y nombres internos coincidan.
// Sirve tanto para "contacts" (clientes persona) como para "companies" (clientes empresa):
// son propiedades distintas, con el mismo label, y se cachean por separado.
async function resolveProducerAgencyPropertyName(objectType = 'contacts') {
  const cached = producerAgencyPropertyCache.get(objectType);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.name;
  }

  const { data } = await hubspotClient.get(`/crm/v3/properties/${objectType}`);
  const match = data.results.find(
    (p) => p.label?.trim().toLowerCase() === PRODUCER_AGENCY_PROPERTY_LABEL.toLowerCase()
  );

  if (!match) {
    throw new Error(
      `No se encontró la propiedad de ${objectType} con label "${PRODUCER_AGENCY_PROPERTY_LABEL}"`
    );
  }

  producerAgencyPropertyCache.set(objectType, {
    name: match.name,
    expiresAt: Date.now() + META_CACHE_TTL_MS,
  });
  return match.name;
}

// Ubica, dentro de los pipelines de deals, el que mejor matchea las 3 etapas buscadas
// y arma el mapeo stageId <-> label. También arma un mapa global (todos los pipelines)
// para poder etiquetar cualquier deal, esté o no en ese pipeline.
async function resolveTargetStageMap({ force = false } = {}) {
  if (!force && pipelineStageCache && pipelineStageCache.expiresAt > Date.now()) {
    return pipelineStageCache;
  }

  const { data } = await hubspotClient.get('/crm/v3/pipelines/deals');
  const wantedLabels = new Set(TARGET_STAGE_LABELS.map((l) => l.toLowerCase()));

  let bestPipeline = null;
  let bestMatchCount = 0;
  const allStageIdToLabel = new Map();
  const allStageIdToPipelineId = new Map();

  for (const pipeline of data.results) {
    for (const stage of pipeline.stages) {
      allStageIdToLabel.set(stage.id, stage.label);
      allStageIdToPipelineId.set(stage.id, pipeline.id);
    }
    const matchCount = pipeline.stages.filter((s) =>
      wantedLabels.has(s.label.trim().toLowerCase())
    ).length;
    if (matchCount > bestMatchCount) {
      bestMatchCount = matchCount;
      bestPipeline = pipeline;
    }
  }

  if (!bestPipeline) {
    throw new Error(`No se encontró ningún pipeline con etapas: ${TARGET_STAGE_LABELS.join(', ')}`);
  }

  const stageIdToLabel = new Map();
  const labelToStageId = new Map();
  for (const label of TARGET_STAGE_LABELS) {
    const stage = bestPipeline.stages.find((s) => s.label.trim().toLowerCase() === label.toLowerCase());
    if (stage) {
      stageIdToLabel.set(stage.id, label);
      labelToStageId.set(label, stage.id);
    }
  }

  // Mapeo label -> id de TODAS las etapas del pipeline elegido (no solo las 3 de reporting).
  // Sirve para resolver, por ejemplo, la etapa "Nuevo" al crear un lead, sin hardcodear su ID.
  const pipelineLabelToStageId = new Map(
    bestPipeline.stages.map((s) => [s.label.trim().toLowerCase(), s.id])
  );

  pipelineStageCache = {
    pipelineId: bestPipeline.id,
    stageIdToLabel,
    labelToStageId,
    allStageIdToLabel,
    allStageIdToPipelineId,
    pipelineLabelToStageId,
    missingLabels: TARGET_STAGE_LABELS.filter((l) => !labelToStageId.has(l)),
    expiresAt: Date.now() + META_CACHE_TTL_MS,
  };
  return pipelineStageCache;
}

// Error por datos del request, no por HubSpot. La ruta lo traduce a 400 en vez
// de 500: el que manda el lead puede corregirlo, no es una falla del server.
class LeadRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LeadRequestError';
    this.isRequestError = true;
  }
}

// Resuelve el pipeline y la etapa inicial ("Nuevo") para crear leads nuevos.
// Es la misma para todas las alianzas: se resuelve por label, no por ID hardcodeado.
async function resolveInitialStage() {
  const stageMap = await resolveTargetStageMap();
  const stageId = stageMap.pipelineLabelToStageId.get(INITIAL_STAGE_LABEL.toLowerCase());

  if (!stageId) {
    throw new Error(`No se encontró la etapa inicial "${INITIAL_STAGE_LABEL}" en el pipeline`);
  }

  return { pipelineId: stageMap.pipelineId, stageId, stageLabel: INITIAL_STAGE_LABEL };
}

// Etapa de la variante "ya emitida". Se valida contra los pipelines reales para
// fallar con un mensaje claro si alguien borra o mueve la etapa en HubSpot,
// en vez de mandar un dealstage inválido y comerse un 400 opaco.
async function resolveEmitidaStage() {
  const stageMap = await resolveTargetStageMap();
  const stageLabel = stageMap.allStageIdToLabel.get(EMITIDA_STAGE_ID);

  if (!stageLabel) {
    throw new Error(`No existe la etapa ${EMITIDA_STAGE_ID} en ningún pipeline de deals`);
  }

  const ownerPipelineId = stageMap.allStageIdToPipelineId.get(EMITIDA_STAGE_ID);
  if (ownerPipelineId !== EMITIDA_PIPELINE_ID) {
    throw new Error(
      `La etapa ${EMITIDA_STAGE_ID} pertenece al pipeline ${ownerPipelineId}, no a ${EMITIDA_PIPELINE_ID}`
    );
  }

  return { pipelineId: EMITIDA_PIPELINE_ID, stageId: EMITIDA_STAGE_ID, stageLabel };
}

// Resuelve una etapa mandada explícitamente en el request. El pipeline NO se pide:
// se deriva del ID, porque HubSpot exige que el dealstage pertenezca al pipeline
// que se manda y un mismo label puede existir en varios pipelines.
async function resolveStageById(stageId) {
  let stageMap = await resolveTargetStageMap();

  // Si no aparece puede ser una etapa recién creada en HubSpot: se refresca la
  // caché una vez antes de rechazar, para no obligar a esperar el TTL de 1h.
  if (!stageMap.allStageIdToLabel.has(stageId)) {
    stageMap = await resolveTargetStageMap({ force: true });
  }

  const stageLabel = stageMap.allStageIdToLabel.get(stageId);
  if (!stageLabel) {
    throw new LeadRequestError(
      `deal.dealstage "${stageId}" no existe en ningún pipeline de deals de HubSpot`
    );
  }

  return {
    pipelineId: stageMap.allStageIdToPipelineId.get(stageId),
    stageId,
    stageLabel,
  };
}

// Trae, paginando, todos los objetos de un tipo que tengan propertyName == value.
async function searchObjectsByProperty(objectType, propertyName, value, properties) {
  const results = [];
  let after;
  const MAX_PAGES = 200; // tope de seguridad: 20.000 registros

  for (let page = 0; page < MAX_PAGES; page++) {
    const { data } = await hubspotClient.post(`/crm/v3/objects/${objectType}/search`, {
      filterGroups: [{ filters: [{ propertyName, operator: 'EQ', value }] }],
      properties,
      limit: 100,
      after,
    });
    results.push(...data.results);
    after = data.paging?.next?.after;
    if (!after) break;
  }

  return results; // array de { id, properties }
}

function searchContactsByProperty(propertyName, value) {
  return searchObjectsByProperty('contacts', propertyName, value, CONTACT_LIST_PROPERTIES);
}

function searchCompaniesByProperty(propertyName, value) {
  return searchObjectsByProperty('companies', propertyName, value, COMPANY_LIST_PROPERTIES);
}

// Mapea cada dealId al primer objeto asociado encontrado (contacto o empresa).
async function getAssociatedDealsMap(objectType, objectIds) {
  const dealToObjectId = new Map();
  const BATCH_SIZE = 100;

  for (let i = 0; i < objectIds.length; i += BATCH_SIZE) {
    const batch = objectIds.slice(i, i + BATCH_SIZE);
    const { data } = await hubspotClient.post(
      `/crm/v4/associations/${objectType}/deals/batch/read`,
      { inputs: batch.map((id) => ({ id })) }
    );
    for (const result of data.results) {
      const objectId = result.from.id;
      for (const to of result.to || []) {
        // toObjectId viene como number; los deals de /batch/read usan id como string.
        const dealId = String(to.toObjectId);
        if (!dealToObjectId.has(dealId)) {
          dealToObjectId.set(dealId, objectId);
        }
      }
    }
  }

  return dealToObjectId;
}

async function getDealsByIdsBatch(dealIds, properties) {
  const deals = [];
  const BATCH_SIZE = 100;

  for (let i = 0; i < dealIds.length; i += BATCH_SIZE) {
    const batch = dealIds.slice(i, i + BATCH_SIZE);
    const { data } = await hubspotClient.post('/crm/v3/objects/deals/batch/read', {
      properties,
      inputs: batch.map((id) => ({ id })),
    });
    deals.push(...data.results);
  }

  return deals;
}

function parseDateRange(from, to) {
  const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
  const fromTime = from ? new Date(from).getTime() : null;
  const toTime = to ? new Date(DATE_ONLY.test(to) ? `${to}T23:59:59.999Z` : to).getTime() : null;
  return { fromTime, toTime };
}

// Obtiene, para una agencia, los clientes que la tienen como "Productor/Agencia"
// —tanto contactos (clientes persona) como empresas (clientes empresa)— y los deals
// asociados a ellos, ya filtrados por rango de fecha.
// Devuelve { deal, type: 'person' | 'company', props } por deal.
async function getAgencyDeals(agencyName, { from, to, dateField }) {
  const [contactProperty, companyProperty] = await Promise.all([
    resolveProducerAgencyPropertyName('contacts'),
    resolveProducerAgencyPropertyName('companies'),
  ]);

  const [contacts, companies] = await Promise.all([
    searchContactsByProperty(contactProperty, agencyName),
    searchCompaniesByProperty(companyProperty, agencyName),
  ]);

  const contactsById = new Map(contacts.map((c) => [c.id, c.properties]));
  const companiesById = new Map(companies.map((c) => [c.id, c.properties]));

  const [dealToContactId, dealToCompanyId] = await Promise.all([
    contactsById.size ? getAssociatedDealsMap('contacts', [...contactsById.keys()]) : new Map(),
    companiesById.size ? getAssociatedDealsMap('companies', [...companiesById.keys()]) : new Map(),
  ]);

  // Un mismo deal puede estar asociado a un contacto y a una empresa de la agencia.
  // El contacto tiene prioridad: así los deals de clientes persona siguen devolviendo
  // exactamente lo mismo que antes de soportar empresas.
  const dealOwners = new Map();
  for (const [dealId, companyId] of dealToCompanyId) {
    dealOwners.set(dealId, { type: 'company', props: companiesById.get(companyId) || {} });
  }
  for (const [dealId, contactId] of dealToContactId) {
    dealOwners.set(dealId, { type: 'person', props: contactsById.get(contactId) || {} });
  }

  const dealIds = [...dealOwners.keys()];
  const deals = dealIds.length ? await getDealsByIdsBatch(dealIds, DEAL_LIST_PROPERTIES) : [];

  const { fromTime, toTime } = parseDateRange(from, to);

  return deals
    .filter((deal) => {
      const dateValue = deal.properties[dateField];
      if (!dateValue) return false;
      const t = new Date(dateValue).getTime();
      if (fromTime !== null && t < fromTime) return false;
      if (toTime !== null && t > toTime) return false;
      return true;
    })
    .map((deal) => ({ deal, ...dealOwners.get(deal.id) }));
}

function emptyStageBucket() {
  const byStage = {};
  for (const label of TARGET_STAGE_LABELS) byStage[label] = 0;
  return { byStage, otrasEtapas: 0, totalDeals: 0 };
}

// Cantidad de deals asociados a contactos cuya propiedad "Productor/Agencia" == agencyName,
// agrupados por etapa ("En proceso" / "Emitida" / "No interesado") y filtrados por rango de fecha.
// Si algún deal tiene cargada la propiedad "agencia" (sub-agencia, para alianzas multi-agencia
// como Lucy), además se agrega "byAgencia" con el mismo desglose por cada sub-agencia,
// como si cada una fuera una agencia independiente.
async function getDealStatsByProducerAgency(agencyName, { from, to, dateField = 'createdate' } = {}) {
  const stageMap = await resolveTargetStageMap();
  const agencyDeals = await getAgencyDeals(agencyName, { from, to, dateField });

  const byStage = {};
  for (const label of TARGET_STAGE_LABELS) byStage[label] = 0;
  let otrasEtapas = 0;
  const byAgencia = {};

  for (const { deal } of agencyDeals) {
    const stageLabel = stageMap.stageIdToLabel.get(deal.properties.dealstage);
    if (stageLabel) {
      byStage[stageLabel]++;
    } else {
      otrasEtapas++;
    }

    const subAgencia = deal.properties[SUB_AGENCY_PROPERTY];
    if (subAgencia) {
      const bucket = (byAgencia[subAgencia] ??= emptyStageBucket());
      bucket.totalDeals++;
      if (stageLabel) {
        bucket.byStage[stageLabel]++;
      } else {
        bucket.otrasEtapas++;
      }
    }
  }

  return {
    agency: agencyName,
    dateField,
    range: { from: from || null, to: to || null },
    totalDeals: agencyDeals.length,
    byStage,
    otrasEtapas,
    ...(Object.keys(byAgencia).length > 0 ? { byAgencia } : {}),
    ...(stageMap.missingLabels.length > 0 ? { etapasNoEncontradas: stageMap.missingLabels } : {}),
  };
}

// Listado de deals de una agencia con los datos del cliente asociado.
// "type" distingue clientes persona ("person": firstName/lastName) de clientes
// empresa ("company": companyName). Si la etapa es "No interesado", incluye el
// comentario cargado en el deal.
async function getDealsListByProducerAgency(agencyName, { from, to, dateField = 'createdate' } = {}) {
  const stageMap = await resolveTargetStageMap();
  const agencyDeals = await getAgencyDeals(agencyName, { from, to, dateField });

  const noInteresadoStageId = stageMap.labelToStageId.get(NO_INTERESADO_LABEL);

  const deals = agencyDeals.map(({ deal, type, props }) => {
    const stageLabel = stageMap.allStageIdToLabel.get(deal.properties.dealstage) || deal.properties.dealstage;

    const record = {
      dealId: deal.id,
      type,
      ...(type === 'company'
        ? { companyName: props.name || null }
        : { firstName: props.firstname || null, lastName: props.lastname || null }),
      phone: props.phone || null,
      email: props.email || null,
      stage: stageLabel,
    };

    if (deal.properties[SUB_AGENCY_PROPERTY]) {
      record.agencia = deal.properties[SUB_AGENCY_PROPERTY];
    }

    if (deal.properties.dealstage === noInteresadoStageId) {
      record.comments = deal.properties[COMMENTS_PROPERTY] || null;
    }

    return record;
  });

  return {
    agency: agencyName,
    dateField,
    range: { from: from || null, to: to || null },
    total: deals.length,
    deals,
  };
}

async function upsertContactByEmail(properties) {
  const { data } = await hubspotClient.post('/crm/v3/objects/contacts/batch/upsert', {
    inputs: [{ id: properties.email, idProperty: 'email', properties }],
  });
  return data.results[0]; // { id, properties, ... }
}

async function createDealForContact(properties, contactId) {
  const { data } = await hubspotClient.post('/crm/v3/objects/deals', {
    properties,
    associations: [
      {
        to: { id: contactId },
        types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }], // deal <-> contact
      },
    ],
  });
  return data;
}

// Busca una empresa por nombre exacto DENTRO de la agencia: dos alianzas distintas
// pueden tener un cliente con el mismo nombre y no deben pisarse entre sí.
async function searchCompanyByNameAndAgency(companyName, agencyPropertyName, agencyName) {
  const { data } = await hubspotClient.post('/crm/v3/objects/companies/search', {
    filterGroups: [
      {
        filters: [
          { propertyName: 'name', operator: 'EQ', value: companyName },
          { propertyName: agencyPropertyName, operator: 'EQ', value: agencyName },
        ],
      },
    ],
    properties: COMPANY_LIST_PROPERTIES,
    limit: 1,
  });
  return data.results[0] || null;
}

// Crea o actualiza la empresa. No se usa /companies/batch/upsert con idProperty
// name/domain: HubSpot lo rechaza porque esas propiedades no son únicas.
async function upsertCompany(properties, agencyPropertyName, agencyName) {
  const existing = await searchCompanyByNameAndAgency(
    properties.name,
    agencyPropertyName,
    agencyName
  );

  if (existing) {
    const { data } = await hubspotClient.patch(`/crm/v3/objects/companies/${existing.id}`, {
      properties,
    });
    return data;
  }

  const { data } = await hubspotClient.post('/crm/v3/objects/companies', { properties });
  return data;
}

// Asocia el deal a la empresa con la asociación default (sin etiqueta), para no
// depender de un associationTypeId numérico hardcodeado.
async function createDealForCompany(properties, companyId) {
  const { data } = await hubspotClient.post('/crm/v3/objects/deals', { properties });
  await hubspotClient.put(
    `/crm/v4/objects/deals/${data.id}/associations/default/companies/${companyId}`
  );
  return data;
}

// Sube un archivo a la biblioteca de Files de HubSpot.
// Se llama ANTES de tocar el CRM: si el archivo falla (tamaño, tipo, permisos),
// no queda un lead a medias sin su adjunto.
// access PRIVATE: la factura no queda accesible por URL pública.
async function uploadFile({ buffer, originalname, mimetype }) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimetype }), originalname);
  form.append('folderPath', ATTACHMENT_FOLDER_PATH);
  form.append(
    'options',
    JSON.stringify({
      access: 'PRIVATE',
      overwrite: false,
      // Dos clientes pueden subir "factura.pdf": se guardan como archivos
      // distintos en vez de pisarse entre sí.
      duplicateValidationStrategy: 'NONE',
      duplicateValidationScope: 'EXACT_FOLDER',
    })
  );

  // El cliente tiene Content-Type: application/json por default; hay que sacarlo
  // para que axios ponga el multipart/form-data con su boundary.
  const { data } = await hubspotClient.post('/files/v3/files', form, {
    headers: { 'Content-Type': undefined },
  });

  return data; // { id, name, url, size, ... }
}

// Crea una nota con el archivo adjunto y la asocia al deal (y al contacto o la
// empresa). Es la vía para que el archivo aparezca en la tarjeta "Archivos
// adjuntos" del registro: HubSpot muestra ahí los adjuntos de las actividades.
async function createNoteWithAttachment({ fileId, body, dealId, contactId, companyId }) {
  const { data: note } = await hubspotClient.post('/crm/v3/objects/notes', {
    properties: {
      hs_timestamp: new Date().toISOString(),
      hs_note_body: body,
      hs_attachment_ids: String(fileId),
    },
  });

  const targets = [
    ['deals', dealId],
    ['contacts', contactId],
    ['companies', companyId],
  ].filter(([, id]) => id);

  for (const [objectType, id] of targets) {
    await hubspotClient.put(
      `/crm/v4/objects/notes/${note.id}/associations/default/${objectType}/${id}`
    );
  }

  return note;
}

// Campos de ubicación/contacto que se mapean igual en Contact y en Company.
// No incluye hs_whatsapp_phone_number: esa propiedad sólo existe en Contacts.
function mapSharedProperties(contact) {
  return {
    phone: contact.phone,
    ...(contact.country ? { country: contact.country } : {}),
    ...(contact.state ? { state: contact.state } : {}),
    ...(contact.city ? { city: contact.city } : {}),
    ...(contact.zip ? { zip: contact.zip } : {}),
  };
}

// Crea (o actualiza) el cliente y el deal asociado para una alianza.
// Si viene contact.companyName el cliente se modela como Company (empresa, buscada
// por nombre + agencia); si no, como Contact (persona, upsert por email).
// "agency" y "leadSource" siempre vienen del server (de la alianza autenticada),
// nunca del body que manda el cliente: así ninguna alianza puede crear un lead
// a nombre de otra agencia ni falsear su origen.
async function createLead({
  agency,
  leadSource,
  contact,
  tipoRiesgo,
  details,
  agencia,
  emitida = false,
  dealstage,
}) {
  const schema = getDealSchema(tipoRiesgo);
  if (!schema) {
    throw new Error(`tipoRiesgo "${tipoRiesgo}" no soportado`);
  }

  const normalizedDetails = normalizeDealDetails(schema, details);
  const companyName = typeof contact.companyName === 'string' ? contact.companyName.trim() : '';
  const isCompany = companyName !== '';

  // IDs de etapa de HubSpot son numéricos: se acepta string o number.
  const requestedStageId =
    dealstage === undefined || dealstage === null || dealstage === ''
      ? null
      : String(dealstage).trim();

  // Prioridad: etapa explícita > variante emitida > etapa inicial ("Nuevo").
  const resolveStage = () => {
    if (requestedStageId) return resolveStageById(requestedStageId);
    if (emitida) return resolveEmitidaStage();
    return resolveInitialStage();
  };

  const buildDeal = async () => {
    const { pipelineId, stageId, stageLabel } = await resolveStage();

    // Nombre del deal: alianza - sub-agencia - tipo de riesgo - patente - email.
    // La sub-agencia y la patente son opcionales; la patente sólo aplica a AUTO.
    const patente = tipoRiesgo === 'AUTO' ? normalizedDetails.patente : null;
    const dealNameParts = [agency, agencia, tipoRiesgo, patente, contact.email].filter(Boolean);

    return {
      pipelineId,
      stageLabel,
      properties: {
        dealname: dealNameParts.join(' - '),
        pipeline: pipelineId,
        dealstage: stageId,
        ...(agencia ? { agencia } : {}),
        ...schema.toHubspotProperties(normalizedDetails),
      },
    };
  };

  if (isCompany) {
    const agencyPropertyName = await resolveProducerAgencyPropertyName('companies');

    // "email" es una propiedad custom del objeto Companies. No se mapean dateOfBirth
    // ni whatsappPhone: no existen como propiedades de Company en HubSpot.
    const companyProperties = {
      name: companyName,
      email: contact.email,
      ...mapSharedProperties(contact),
      [agencyPropertyName]: agency,
    };

    const company = await upsertCompany(companyProperties, agencyPropertyName, agency);
    const { pipelineId, stageLabel, properties: dealProperties } = await buildDeal();
    const createdDeal = await createDealForCompany(dealProperties, company.id);

    return {
      company: {
        id: company.id,
        name: companyName,
        email: contact.email,
      },
      deal: {
        id: createdDeal.id,
        name: dealProperties.dealname,
        stage: stageLabel,
        pipeline: pipelineId,
      },
    };
  }

  const contactProperties = {
    email: contact.email,
    firstname: contact.firstName,
    lastname: contact.lastName,
    ...mapSharedProperties(contact),
    hs_whatsapp_phone_number: contact.whatsappPhone || contact.phone,
    ...(contact.dni ? { dni: contact.dni } : {}),
    ...(contact.dateOfBirth
      ? { date_of_birth: String(new Date(contact.dateOfBirth).getTime()) }
      : {}),
    productor_agencia: agency,
    lead_source: leadSource,
    lifecyclestage: 'lead',
  };

  const upsertedContact = await upsertContactByEmail(contactProperties);
  const { pipelineId, stageLabel, properties: dealProperties } = await buildDeal();
  const createdDeal = await createDealForContact(dealProperties, upsertedContact.id);

  return {
    contact: {
      id: upsertedContact.id,
      email: contact.email,
      firstName: contact.firstName,
      lastName: contact.lastName,
    },
    deal: {
      id: createdDeal.id,
      name: dealProperties.dealname,
      stage: stageLabel,
      pipeline: pipelineId,
    },
  };
}

// Crea un lead y le adjunta un archivo (ej. la factura de compra en MOVILIDAD).
// Orden a propósito: primero se sube el archivo, después se crea el lead. Si el
// archivo falla, no queda un lead huérfano sin su adjunto; si falla la nota, el
// lead ya existe y se avisa en la respuesta en vez de perder todo.
async function createLeadWithAttachment({ attachment, noteBody, ...leadInput }) {
  const file = await uploadFile(attachment);

  const result = await createLead(leadInput);

  const note = await createNoteWithAttachment({
    fileId: file.id,
    body: noteBody || `Archivo adjuntado por la alianza ${leadInput.agency}.`,
    dealId: result.deal.id,
    contactId: result.contact?.id,
    companyId: result.company?.id,
  });

  return {
    ...result,
    attachment: {
      fileId: file.id,
      name: file.name,
      url: file.url || null,
      noteId: note.id,
    },
  };
}

module.exports = {
  getDealById,
  getContactById,
  getDealsByContactId,
  searchContactByEmail,
  getDealStatsByProducerAgency,
  getDealsListByProducerAgency,
  createLead,
  createLeadWithAttachment,
};

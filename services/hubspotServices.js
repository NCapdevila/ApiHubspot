const hubspotClient = require('../config/hubspot');
const { getDealSchema } = require('./leadSchemas');

const DEAL_PROPERTIES = 'dealname,dealstage,amount,pipeline,closedate,createdate';
const CONTACT_PROPERTIES = 'email,firstname,lastname,phone';

const PRODUCER_AGENCY_PROPERTY_LABEL = 'Productor/Agencia';
const TARGET_STAGE_LABELS = ['En proceso', 'Emitida', 'No interesado'];
const NO_INTERESADO_LABEL = 'No interesado';
const INITIAL_STAGE_LABEL = 'Nuevo';
const COMMENTS_PROPERTY = 'comentarios';
const META_CACHE_TTL_MS = 60 * 60 * 1000; // 1h

const CONTACT_LIST_PROPERTIES = ['email', 'firstname', 'lastname', 'phone'];
const DEAL_LIST_PROPERTIES = ['dealstage', 'pipeline', 'createdate', 'closedate', COMMENTS_PROPERTY];

let producerAgencyPropertyCache = null; // { name, expiresAt }
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

// Resuelve el internal name de la propiedad de contacto a partir de su label,
// ya que HubSpot no garantiza que labels y nombres internos coincidan.
async function resolveProducerAgencyPropertyName() {
  if (producerAgencyPropertyCache && producerAgencyPropertyCache.expiresAt > Date.now()) {
    return producerAgencyPropertyCache.name;
  }

  const { data } = await hubspotClient.get('/crm/v3/properties/contacts');
  const match = data.results.find(
    (p) => p.label?.trim().toLowerCase() === PRODUCER_AGENCY_PROPERTY_LABEL.toLowerCase()
  );

  if (!match) {
    throw new Error(
      `No se encontró la propiedad de contacto con label "${PRODUCER_AGENCY_PROPERTY_LABEL}"`
    );
  }

  producerAgencyPropertyCache = { name: match.name, expiresAt: Date.now() + META_CACHE_TTL_MS };
  return match.name;
}

// Ubica, dentro de los pipelines de deals, el que mejor matchea las 3 etapas buscadas
// y arma el mapeo stageId <-> label. También arma un mapa global (todos los pipelines)
// para poder etiquetar cualquier deal, esté o no en ese pipeline.
async function resolveTargetStageMap() {
  if (pipelineStageCache && pipelineStageCache.expiresAt > Date.now()) {
    return pipelineStageCache;
  }

  const { data } = await hubspotClient.get('/crm/v3/pipelines/deals');
  const wantedLabels = new Set(TARGET_STAGE_LABELS.map((l) => l.toLowerCase()));

  let bestPipeline = null;
  let bestMatchCount = 0;
  const allStageIdToLabel = new Map();

  for (const pipeline of data.results) {
    for (const stage of pipeline.stages) {
      allStageIdToLabel.set(stage.id, stage.label);
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
    pipelineLabelToStageId,
    missingLabels: TARGET_STAGE_LABELS.filter((l) => !labelToStageId.has(l)),
    expiresAt: Date.now() + META_CACHE_TTL_MS,
  };
  return pipelineStageCache;
}

// Resuelve el pipeline y la etapa inicial ("Nuevo") para crear leads nuevos.
// Es la misma para todas las alianzas: se resuelve por label, no por ID hardcodeado.
async function resolveInitialStage() {
  const stageMap = await resolveTargetStageMap();
  const stageId = stageMap.pipelineLabelToStageId.get(INITIAL_STAGE_LABEL.toLowerCase());

  if (!stageId) {
    throw new Error(`No se encontró la etapa inicial "${INITIAL_STAGE_LABEL}" en el pipeline`);
  }

  return { pipelineId: stageMap.pipelineId, stageId };
}

async function searchContactsByProperty(propertyName, value) {
  const contacts = [];
  let after;
  const MAX_PAGES = 200; // tope de seguridad: 20.000 contactos

  for (let page = 0; page < MAX_PAGES; page++) {
    const { data } = await hubspotClient.post('/crm/v3/objects/contacts/search', {
      filterGroups: [{ filters: [{ propertyName, operator: 'EQ', value }] }],
      properties: CONTACT_LIST_PROPERTIES,
      limit: 100,
      after,
    });
    contacts.push(...data.results);
    after = data.paging?.next?.after;
    if (!after) break;
  }

  return contacts; // array de { id, properties }
}

// Mapea cada dealId al primer contactId asociado encontrado.
async function getAssociatedDealsMap(contactIds) {
  const dealToContactId = new Map();
  const BATCH_SIZE = 100;

  for (let i = 0; i < contactIds.length; i += BATCH_SIZE) {
    const batch = contactIds.slice(i, i + BATCH_SIZE);
    const { data } = await hubspotClient.post('/crm/v4/associations/contacts/deals/batch/read', {
      inputs: batch.map((id) => ({ id })),
    });
    for (const result of data.results) {
      const contactId = result.from.id;
      for (const to of result.to || []) {
        // toObjectId viene como number; los deals de /batch/read usan id como string.
        const dealId = String(to.toObjectId);
        if (!dealToContactId.has(dealId)) {
          dealToContactId.set(dealId, contactId);
        }
      }
    }
  }

  return dealToContactId;
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

// Obtiene, para una agencia, los contactos que la tienen como "Productor/Agencia"
// y los deals asociados a ellos, ya filtrados por rango de fecha.
async function getAgencyDeals(agencyName, { from, to, dateField }) {
  const propertyName = await resolveProducerAgencyPropertyName();

  const contacts = await searchContactsByProperty(propertyName, agencyName);
  const contactsById = new Map(contacts.map((c) => [c.id, c.properties]));
  const contactIds = [...contactsById.keys()];

  const dealToContactId = contactIds.length ? await getAssociatedDealsMap(contactIds) : new Map();
  const dealIds = [...dealToContactId.keys()];
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
    .map((deal) => ({ deal, contactProps: contactsById.get(dealToContactId.get(deal.id)) || {} }));
}

// Cantidad de deals asociados a contactos cuya propiedad "Productor/Agencia" == agencyName,
// agrupados por etapa ("En proceso" / "Emitida" / "No interesado") y filtrados por rango de fecha.
async function getDealStatsByProducerAgency(agencyName, { from, to, dateField = 'createdate' } = {}) {
  const stageMap = await resolveTargetStageMap();
  const agencyDeals = await getAgencyDeals(agencyName, { from, to, dateField });

  const byStage = {};
  for (const label of TARGET_STAGE_LABELS) byStage[label] = 0;
  let otrasEtapas = 0;

  for (const { deal } of agencyDeals) {
    const stageLabel = stageMap.stageIdToLabel.get(deal.properties.dealstage);
    if (stageLabel) {
      byStage[stageLabel]++;
    } else {
      otrasEtapas++;
    }
  }

  return {
    agency: agencyName,
    dateField,
    range: { from: from || null, to: to || null },
    totalDeals: agencyDeals.length,
    byStage,
    otrasEtapas,
    ...(stageMap.missingLabels.length > 0 ? { etapasNoEncontradas: stageMap.missingLabels } : {}),
  };
}

// Listado de deals de una agencia con los datos de contacto asociados.
// Si la etapa es "No interesado", incluye el comentario cargado en el deal.
async function getDealsListByProducerAgency(agencyName, { from, to, dateField = 'createdate' } = {}) {
  const stageMap = await resolveTargetStageMap();
  const agencyDeals = await getAgencyDeals(agencyName, { from, to, dateField });

  const noInteresadoStageId = stageMap.labelToStageId.get(NO_INTERESADO_LABEL);

  const deals = agencyDeals.map(({ deal, contactProps }) => {
    const stageLabel = stageMap.allStageIdToLabel.get(deal.properties.dealstage) || deal.properties.dealstage;

    const record = {
      dealId: deal.id,
      firstName: contactProps.firstname || null,
      lastName: contactProps.lastname || null,
      phone: contactProps.phone || null,
      email: contactProps.email || null,
      stage: stageLabel,
    };

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

// Crea (o actualiza, por email) el contacto y el deal asociado para una alianza.
// "agency" y "leadSource" siempre vienen del server (de la alianza autenticada),
// nunca del body que manda el cliente: así ninguna alianza puede crear un lead
// a nombre de otra agencia ni falsear su origen.
async function createLead({ agency, leadSource, contact, tipoRiesgo, details, agencia }) {
  const schema = getDealSchema(tipoRiesgo);
  if (!schema) {
    throw new Error(`tipoRiesgo "${tipoRiesgo}" no soportado`);
  }

  const contactProperties = {
    email: contact.email,
    firstname: contact.firstName,
    lastname: contact.lastName,
    phone: contact.phone,
    hs_whatsapp_phone_number: contact.whatsappPhone || contact.phone,
    ...(contact.country ? { country: contact.country } : {}),
    ...(contact.state ? { state: contact.state } : {}),
    ...(contact.city ? { city: contact.city } : {}),
    ...(contact.zip ? { zip: contact.zip } : {}),
    ...(contact.dateOfBirth
      ? { date_of_birth: String(new Date(contact.dateOfBirth).getTime()) }
      : {}),
    productor_agencia: agency,
    lead_source: leadSource,
    lifecyclestage: 'lead',
  };

  const upsertedContact = await upsertContactByEmail(contactProperties);
  const { pipelineId, stageId } = await resolveInitialStage();

  const dealNameParts = [agency, agencia, tipoRiesgo, contact.email].filter(Boolean);

  const dealProperties = {
    dealname: dealNameParts.join(' - '),
    pipeline: pipelineId,
    dealstage: stageId,
    ...(agencia ? { agencia } : {}),
    ...schema.toHubspotProperties(details || {}),
  };

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
      stage: INITIAL_STAGE_LABEL,
      pipeline: pipelineId,
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
};

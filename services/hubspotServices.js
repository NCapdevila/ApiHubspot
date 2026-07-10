const hubspotClient = require('../config/hubspot');

const DEAL_PROPERTIES = 'dealname,dealstage,amount,pipeline,closedate,createdate';
const CONTACT_PROPERTIES = 'email,firstname,lastname,phone';

const PRODUCER_AGENCY_PROPERTY_LABEL = 'Productor/Agencia';
const TARGET_STAGE_LABELS = ['En proceso', 'Emitida', 'No interesado'];
const META_CACHE_TTL_MS = 60 * 60 * 1000; // 1h

let producerAgencyPropertyCache = null; // { name, expiresAt }
let pipelineStageCache = null; // { pipelineId, stageIdToLabel, labelToStageId, missingLabels, expiresAt }

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

// Ubica, dentro del pipeline de deals, el pipeline que mejor matchea las 3 etapas
// buscadas y arma el mapeo stageId <-> label.
async function resolveTargetStageMap() {
  if (pipelineStageCache && pipelineStageCache.expiresAt > Date.now()) {
    return pipelineStageCache;
  }

  const { data } = await hubspotClient.get('/crm/v3/pipelines/deals');
  const wantedLabels = new Set(TARGET_STAGE_LABELS.map((l) => l.toLowerCase()));

  let bestPipeline = null;
  let bestMatchCount = 0;
  for (const pipeline of data.results) {
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

  pipelineStageCache = {
    pipelineId: bestPipeline.id,
    stageIdToLabel,
    labelToStageId,
    missingLabels: TARGET_STAGE_LABELS.filter((l) => !labelToStageId.has(l)),
    expiresAt: Date.now() + META_CACHE_TTL_MS,
  };
  return pipelineStageCache;
}

async function searchContactIdsByProperty(propertyName, value) {
  const ids = [];
  let after;
  const MAX_PAGES = 200; // tope de seguridad: 20.000 contactos

  for (let page = 0; page < MAX_PAGES; page++) {
    const { data } = await hubspotClient.post('/crm/v3/objects/contacts/search', {
      filterGroups: [{ filters: [{ propertyName, operator: 'EQ', value }] }],
      properties: ['email'],
      limit: 100,
      after,
    });
    ids.push(...data.results.map((r) => r.id));
    after = data.paging?.next?.after;
    if (!after) break;
  }

  return ids;
}

async function getAssociatedDealIds(contactIds) {
  const dealIds = new Set();
  const BATCH_SIZE = 100;

  for (let i = 0; i < contactIds.length; i += BATCH_SIZE) {
    const batch = contactIds.slice(i, i + BATCH_SIZE);
    const { data } = await hubspotClient.post('/crm/v4/associations/contacts/deals/batch/read', {
      inputs: batch.map((id) => ({ id })),
    });
    for (const result of data.results) {
      for (const to of result.to || []) {
        dealIds.add(to.toObjectId);
      }
    }
  }

  return [...dealIds];
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

// Cantidad de deals asociados a contactos cuya propiedad "Productor/Agencia" == agencyName,
// agrupados por etapa ("En proceso" / "Emitida" / "No interesado") y filtrados por rango de fecha.
async function getDealStatsByProducerAgency(agencyName, { from, to, dateField = 'createdate' } = {}) {
  const propertyName = await resolveProducerAgencyPropertyName();
  const stageMap = await resolveTargetStageMap();

  const contactIds = await searchContactIdsByProperty(propertyName, agencyName);
  const dealIds = contactIds.length ? await getAssociatedDealIds(contactIds) : [];
  const deals = dealIds.length
    ? await getDealsByIdsBatch(dealIds, ['dealname', 'dealstage', 'pipeline', 'amount', 'createdate', 'closedate'])
    : [];

  const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
  const fromTime = from ? new Date(from).getTime() : null;
  const toTime = to ? new Date(DATE_ONLY.test(to) ? `${to}T23:59:59.999Z` : to).getTime() : null;

  const byStage = {};
  for (const label of TARGET_STAGE_LABELS) byStage[label] = 0;
  let otrasEtapas = 0;
  let totalDeals = 0;

  for (const deal of deals) {
    const dateValue = deal.properties[dateField];
    if (!dateValue) continue;
    const t = new Date(dateValue).getTime();
    if (fromTime !== null && t < fromTime) continue;
    if (toTime !== null && t > toTime) continue;

    totalDeals++;
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
    totalDeals,
    byStage,
    otrasEtapas,
    ...(stageMap.missingLabels.length > 0 ? { etapasNoEncontradas: stageMap.missingLabels } : {}),
  };
}

module.exports = {
  getDealById,
  getContactById,
  getDealsByContactId,
  searchContactByEmail,
  getDealStatsByProducerAgency,
};
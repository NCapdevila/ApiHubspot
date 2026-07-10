// Acá definís exactamente qué campos ve el agente externo.
// Nunca devolvemos el objeto crudo de HubSpot.

function toPublicDeal(hubspotDeal) {
  const p = hubspotDeal.properties;
  return {
    id: hubspotDeal.id,
    name: p.dealname || null,
    stage: p.dealstage || null,
    amount: p.amount || null,
    pipeline: p.pipeline || null,
    closeDate: p.closedate || null,
    createdDate: p.createdate || null,
  };
}

function toPublicContact(hubspotContact) {
  const p = hubspotContact.properties;
  return {
    id: hubspotContact.id,
    email: p.email || null,
    firstName: p.firstname || null,
    lastName: p.lastname || null,
    phone: p.phone || null,
  };
}

module.exports = { toPublicDeal, toPublicContact };
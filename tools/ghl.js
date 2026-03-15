// Go High Level CRM Integration
// Direct REST calls to GHL API v2
// Auth: Private Integration Token (Bearer token)

const BASE_URL = "https://services.leadconnectorhq.com";
const API_VERSION = "2021-07-28";

function getHeaders() {
  const token = process.env.GHL_API_KEY;
  if (!token) return null;
  return {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
    "Version": API_VERSION,
  };
}

function isConfigured() {
  return !!(process.env.GHL_API_KEY && process.env.GHL_LOCATION_ID);
}

async function ghlFetch(endpoint, options = {}) {
  const headers = getHeaders();
  if (!headers) throw new Error("GHL not configured. Set GHL_API_KEY in .env.");

  const url = `${BASE_URL}${endpoint}`;
  const res = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GHL API ${res.status}: ${text.substring(0, 200)}`);
  }

  return await res.json();
}

// --- Contacts ---

async function searchContacts(query, limit = 10) {
  const locationId = process.env.GHL_LOCATION_ID;
  const data = await ghlFetch(
    `/contacts/?locationId=${locationId}&query=${encodeURIComponent(query)}&limit=${limit}`
  );
  return (data.contacts || []).map(formatContact);
}

async function getContact(contactId) {
  const data = await ghlFetch(`/contacts/${contactId}`);
  return formatContact(data.contact || data);
}

function formatContact(c) {
  if (!c) return null;
  return {
    id: c.id,
    name: [c.firstName, c.lastName].filter(Boolean).join(" "),
    firstName: c.firstName || "",
    lastName: c.lastName || "",
    email: c.email || "",
    phone: c.phone || "",
    address: c.address1 || "",
    city: c.city || "",
    state: c.state || "",
    zip: c.postalCode || "",
    tags: c.tags || [],
    customFields: c.customFields || c.customField || [],
    source: c.source || "",
    dateAdded: c.dateAdded || "",
  };
}

// --- Opportunities (Deals) ---

async function searchOpportunities(query, pipelineId) {
  const locationId = process.env.GHL_LOCATION_ID;
  let endpoint = `/opportunities/search?location_id=${locationId}&q=${encodeURIComponent(query)}`;
  if (pipelineId) endpoint += `&pipeline_id=${pipelineId}`;
  const data = await ghlFetch(endpoint);
  return (data.opportunities || []).map(formatOpportunity);
}

async function getOpportunity(oppId) {
  const data = await ghlFetch(`/opportunities/${oppId}`);
  return formatOpportunity(data.opportunity || data);
}

function formatOpportunity(o) {
  if (!o) return null;
  return {
    id: o.id,
    name: o.name || "",
    value: o.monetaryValue || 0,
    status: o.status || "",
    stage: o.pipelineStageId || "",
    contactId: o.contactId || "",
    assignedTo: o.assignedTo || "",
    source: o.source || "",
    dateAdded: o.dateAdded || "",
    lastActivity: o.lastActivity || "",
    customFields: o.customFields || [],
  };
}

// --- Notes ---

async function getContactNotes(contactId) {
  const data = await ghlFetch(`/contacts/${contactId}/notes`);
  return (data.notes || []).map((n) => ({
    id: n.id,
    body: n.body || "",
    dateAdded: n.dateAdded || "",
    userId: n.userId || "",
  }));
}

// --- Combined Lookup ---
// Searches contacts + opportunities for a deal name, returns everything

async function searchByDeal(dealName) {
  const results = { contacts: [], opportunities: [], notes: [] };

  // Search contacts
  try {
    results.contacts = await searchContacts(dealName, 5);
  } catch (err) {
    console.error(`[GHL] Contact search failed: ${err.message}`);
  }

  // Search opportunities
  try {
    results.opportunities = await searchOpportunities(dealName);
  } catch (err) {
    console.error(`[GHL] Opportunity search failed: ${err.message}`);
  }

  // Get notes for first matching contact
  if (results.contacts.length > 0) {
    try {
      results.notes = await getContactNotes(results.contacts[0].id);
    } catch (err) {
      console.error(`[GHL] Notes fetch failed: ${err.message}`);
    }
  }

  return results;
}

// --- Extract Contract Fields from GHL Contact ---
// Maps GHL contact data to template merge fields

function extractContractFields(contact) {
  if (!contact) return {};
  const fields = {};

  fields.seller_first_name = contact.firstName || "";
  fields.seller_last_name = contact.lastName || "";
  fields.seller_name = contact.name || "";
  fields.seller_mailing_address = contact.address || "";
  fields.seller_mailing_city = contact.city || "";
  fields.seller_mailing_state = contact.state || "";
  fields.seller_mailing_zip = contact.zip || "";

  // Extract custom fields (GHL stores these as array of {id, value} or {key, value})
  const cf = contact.customFields || [];
  for (const f of cf) {
    const key = (f.fieldKey || f.key || f.id || "").toLowerCase();
    const val = f.value || f.fieldValue || "";
    if (!val) continue;

    if (key.includes("property_county") || key.includes("county")) fields.property_county = val;
    if (key.includes("property_state") || key === "state") fields.property_state = val;
    if (key.includes("offer_amount") || key.includes("offer")) fields.purchase_price = val;
    if (key.includes("parcel") || key.includes("apn")) fields.parcel_number = val;
    if (key.includes("acreage") || key.includes("acres")) fields.acreage = val;
    if (key.includes("short_legal") || key.includes("legal")) fields.short_legal = val;
    if (key.includes("earnest_money") || key.includes("earnest")) fields.earnest_money = val;
    if (key.includes("contract_closed") || key.includes("closing_days")) fields.closing_days = val;
    if (key.includes("feasibility") || key.includes("due_diligence")) fields.feasibility_days = val;
  }

  return fields;
}

// --- CRM Deal Brief ---
// One-call compound lookup for quick deal overview

async function crmDealBrief(dealName) {
  const data = await searchByDeal(dealName);

  let summary = `**GHL Lookup: "${dealName}"**\n`;

  if (data.contacts.length > 0) {
    summary += `\n**Contacts (${data.contacts.length}):**\n`;
    for (const c of data.contacts) {
      summary += `- ${c.name} | ${c.email || "no email"} | ${c.phone || "no phone"} | ${c.city}, ${c.state}\n`;
      if (c.tags.length > 0) summary += `  Tags: ${c.tags.join(", ")}\n`;
    }
  } else {
    summary += "\nNo contacts found.\n";
  }

  if (data.opportunities.length > 0) {
    summary += `\n**Opportunities (${data.opportunities.length}):**\n`;
    for (const o of data.opportunities) {
      summary += `- ${o.name} | $${o.value} | Status: ${o.status}\n`;
    }
  }

  if (data.notes.length > 0) {
    summary += `\n**Notes (${data.notes.length}):**\n`;
    for (const n of data.notes.slice(0, 5)) {
      const preview = n.body.length > 150 ? n.body.substring(0, 150) + "..." : n.body;
      summary += `- [${n.dateAdded}] ${preview}\n`;
    }
    if (data.notes.length > 5) summary += `  ...and ${data.notes.length - 5} more notes\n`;
  }

  return { summary, ...data };
}

module.exports = {
  isConfigured,
  searchContacts,
  getContact,
  searchOpportunities,
  getOpportunity,
  getContactNotes,
  searchByDeal,
  extractContractFields,
  crmDealBrief,
};

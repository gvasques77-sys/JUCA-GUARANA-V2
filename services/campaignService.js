// ============================================================
// services/campaignService.js — F9D: Campanhas WhatsApp
// CLINICORE — GV AUTOMACOES
// ============================================================
// VERSAO MULTI-TENANT: credenciais WhatsApp por clinica.
// Usa whatsappConfigHelper.js para resolver credentials.
// ============================================================

import { createClient } from '@supabase/supabase-js';
import { getClinicWhatsAppConfig, getThrottleConfig } from './whatsappConfigHelper.js';
import { trackTemplateUsage } from './usageTracker.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sb = createClient(supabaseUrl, supabaseKey);

const META_API_VERSION = 'v21.0';
const META_BASE_URL = 'https://graph.facebook.com/' + META_API_VERSION;

// ============================================================
// 1. BUSCAR TEMPLATES DA META API (por clinica)
// ============================================================
export async function fetchMetaTemplates(clinicId) {
  const config = await getClinicWhatsAppConfig(clinicId);
  if (!config) return { success: false, error: 'WhatsApp nao configurado para esta clinica', templates: [] };
  if (!config.business_account_id) return { success: false, error: 'Business Account ID nao configurado', templates: [] };

  try {
    const url = META_BASE_URL + '/' + config.business_account_id + '/message_templates?status=APPROVED&limit=100&fields=name,language,category,components,status';
    const response = await fetch(url, { headers: { 'Authorization': 'Bearer ' + config.access_token } });

    if (!response.ok) {
      await response.json().catch(function() { return {}; });
      if (response.status === 401) return { success: false, error: 'Token WhatsApp expirado ou invalido', templates: [] };
      return { success: false, error: 'Erro ao buscar templates: HTTP ' + response.status, templates: [] };
    }

    const data = await response.json();
    const templates = (data.data || []).map(function(t) {
      return { name: t.name, language: t.language, category: t.category, status: t.status, components: t.components || [], parameters: extractTemplateParameters(t.components || []) };
    });

    const grouped = {};
    templates.forEach(function(t) {
      if (!grouped[t.name]) { grouped[t.name] = { name: t.name, category: t.category, languages: [], components: t.components, parameters: t.parameters }; }
      grouped[t.name].languages.push(t.language);
    });

    return { success: true, templates: Object.values(grouped), raw_count: templates.length };
  } catch (err) {
    return { success: false, error: err.message, templates: [] };
  }
}

function extractTemplateParameters(components) {
  const params = [];
  components.forEach(function(comp) {
    if (comp.type === 'BODY' && comp.text) {
      const matches = comp.text.match(/\{\{\d+\}\}/g);
      if (matches) {
        matches.forEach(function(m, idx) {
          let example = '';
          if (comp.example && comp.example.body_text && comp.example.body_text[0]) example = comp.example.body_text[0][idx] || '';
          params.push({ index: idx + 1, placeholder: m, example });
        });
      }
    }
  });
  return params;
}

// ============================================================
// 2. CRIAR CAMPANHA
// ============================================================
export async function createCampaign(data) {
  try {
    if (!data.clinic_id || !data.name || !data.template_name || !data.created_by) return { success: false, error: 'Campos obrigatorios: clinic_id, name, template_name, created_by' };

    const config = await getClinicWhatsAppConfig(data.clinic_id);
    if (!config) return { success: false, error: 'WhatsApp nao configurado para esta clinica. Configure as credenciais antes de criar campanhas.' };

    const audience = await resolveAudience(data.clinic_id, {
      segmentId:    data.segment_id || null,
      audienceType: data.audience_type || null,
      minLeadScore: data.min_lead_score != null ? data.min_lead_score : 0,
      tagIds:       data.tag_ids || [],
    });
    if (!audience.success) return { success: false, error: 'Erro ao resolver audiencia: ' + audience.error };
    if (audience.patients.length === 0) return { success: false, error: 'Nenhum paciente encontrado no segmento selecionado' };

    if (audience.patients.length > config.daily_limit) {
      return { success: false, error: 'Audiencia (' + audience.patients.length + ') excede limite diario do tier (' + config.daily_limit + ')' };
    }

    const initialStatus = data.scheduled_at ? 'scheduled' : 'draft';
    const campaignInsert = {
      clinic_id: data.clinic_id, name: data.name, description: data.description || null,
      template_name: data.template_name, template_language: data.template_language || 'pt_BR',
      template_category: data.template_category || null, template_components: data.template_components || [],
      segment_id: data.segment_id || null, audience_snapshot: audience.filter_snapshot,
      total_recipients: audience.patients.length, status: initialStatus,
      scheduled_at: data.scheduled_at || null, created_by: data.created_by,
      min_lead_score: data.min_lead_score != null ? data.min_lead_score : 0,
      min_score_label: data.min_score_label || null,
    };

    const { data: campaign, error: campErr } = await sb.from('crm_campaigns').insert(campaignInsert).select().single();
    if (campErr) return { success: false, error: 'Erro ao salvar campanha: ' + campErr.message };

    const messages = audience.patients.map(function(p) {
      return { campaign_id: campaign.id, clinic_id: data.clinic_id, patient_id: p.id, phone: p.phone, status: 'pending' };
    });

    for (let i = 0; i < messages.length; i += 500) {
      const batch = messages.slice(i, i + 500);
      const { error: msgErr } = await sb.from('crm_campaign_messages').insert(batch);
      if (msgErr) {
        await sb.from('crm_campaigns').delete().eq('id', campaign.id);
        return { success: false, error: 'Erro ao gerar mensagens: ' + msgErr.message };
      }
    }

    console.log('[CampaignService] Campanha criada: ' + campaign.id + ' | ' + audience.patients.length + ' dest | ' + config.source);
    return { success: true, campaign, recipient_count: audience.patients.length };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ============================================================
// Resolucao de Audiencia
// ============================================================

/**
 * Resolve a lista de pacientes para uma campanha.
 * @param {string} clinicId
 * @param {object} opts
 * @param {string|null}   opts.segmentId    - ID de segmento salvo (crm_segments)
 * @param {string|null}   opts.audienceType - 'by_score' | 'by_score_and_tags' | null (todos)
 * @param {number}        opts.minLeadScore - Score mínimo (padrão 0)
 * @param {string[]}      opts.tagIds       - Array de tag_ids para 'by_score_and_tags'
 */
async function resolveAudience(clinicId, opts) {
  // Suporte a chamadas legadas com segmentId como segundo argumento
  if (typeof opts === 'string' || opts == null) {
    opts = { segmentId: opts || null, audienceType: null, minLeadScore: 0, tagIds: [] };
  }
  const { segmentId, audienceType, minLeadScore = 0, tagIds = [] } = opts;

  try {
    // — Audiência por score mínimo —
    if (audienceType === 'by_score') {
      return resolveByScore(clinicId, minLeadScore);
    }

    // — Audiência por score + tags —
    if (audienceType === 'by_score_and_tags') {
      return resolveByScoreAndTags(clinicId, minLeadScore, tagIds);
    }

    // — Audiência por segmento salvo (comportamento original) —
    if (segmentId) {
      try {
        const { data: segment, error: segErr } = await sb.from('crm_segments').select('id, name, filters').eq('id', segmentId).eq('clinic_id', clinicId).single();
        if (segErr || !segment) return { success: false, error: 'Segmento nao encontrado', patients: [] };
        const filterSnapshot = { segment_id: segment.id, segment_name: segment.name, filters: segment.filters };
        const patients = await resolveSegmentPatients(clinicId, segment.filters);
        return { success: true, patients, filter_snapshot: filterSnapshot };
      } catch (e) {
        return { success: false, error: 'Segmentos nao disponiveis: ' + e.message, patients: [] };
      }
    }

    // — Todos os pacientes (fallback) —
    const { data: patients, error: patErr } = await sb.from('patients').select('id, name, phone').eq('clinic_id', clinicId).not('phone', 'is', null).neq('phone', '');
    if (patErr) return { success: false, error: patErr.message, patients: [] };
    return { success: true, patients: patients || [], filter_snapshot: { segment_id: null, segment_name: 'Todos os pacientes', filters: {} } };
  } catch (err) { return { success: false, error: err.message, patients: [] }; }
}

/** Pacientes com lead_score >= minLeadScore */
async function resolveByScore(clinicId, minLeadScore) {
  try {
    const { data: projections, error } = await sb
      .from('patient_crm_projection')
      .select('patient_id')
      .eq('clinic_id', clinicId)
      .gte('lead_score', minLeadScore);

    if (error) return { success: false, error: error.message, patients: [] };
    if (!projections || projections.length === 0) return { success: true, patients: [], filter_snapshot: { audience_type: 'by_score', min_lead_score: minLeadScore } };

    const patientIds = projections.map(function(p) { return p.patient_id; });
    const { data: patients, error: patErr } = await sb.from('patients').select('id, name, phone').eq('clinic_id', clinicId).in('id', patientIds).not('phone', 'is', null).neq('phone', '');
    if (patErr) return { success: false, error: patErr.message, patients: [] };
    return { success: true, patients: patients || [], filter_snapshot: { audience_type: 'by_score', min_lead_score: minLeadScore } };
  } catch (err) { return { success: false, error: err.message, patients: [] }; }
}

/** Pacientes com lead_score >= minLeadScore E que possuem todas as tags informadas */
async function resolveByScoreAndTags(clinicId, minLeadScore, tagIds) {
  try {
    if (!tagIds || tagIds.length === 0) return resolveByScore(clinicId, minLeadScore);

    // Pacientes com o score mínimo
    const { data: projections, error: projErr } = await sb
      .from('patient_crm_projection')
      .select('patient_id')
      .eq('clinic_id', clinicId)
      .gte('lead_score', minLeadScore);
    if (projErr) return { success: false, error: projErr.message, patients: [] };
    if (!projections || projections.length === 0) return { success: true, patients: [], filter_snapshot: { audience_type: 'by_score_and_tags', min_lead_score: minLeadScore, tag_ids: tagIds } };

    const scorePatientIds = new Set(projections.map(function(p) { return p.patient_id; }));

    // Pacientes com as tags solicitadas (patient_tags usa tag_id como FK)
    const { data: taggedPatients, error: tagErr } = await sb.from('patient_tags').select('patient_id').eq('clinic_id', clinicId).in('tag_id', tagIds);
    if (tagErr) return { success: false, error: tagErr.message, patients: [] };
    const tagPatientIds = new Set((taggedPatients || []).map(function(t) { return t.patient_id; }));

    // Interseção: paciente precisa ter score E tag(s)
    const eligibleIds = Array.from(scorePatientIds).filter(function(id) { return tagPatientIds.has(id); });
    if (eligibleIds.length === 0) return { success: true, patients: [], filter_snapshot: { audience_type: 'by_score_and_tags', min_lead_score: minLeadScore, tag_ids: tagIds } };

    const { data: patients, error: patErr } = await sb.from('patients').select('id, name, phone').eq('clinic_id', clinicId).in('id', eligibleIds).not('phone', 'is', null).neq('phone', '');
    if (patErr) return { success: false, error: patErr.message, patients: [] };
    return { success: true, patients: patients || [], filter_snapshot: { audience_type: 'by_score_and_tags', min_lead_score: minLeadScore, tag_ids: tagIds } };
  } catch (err) { return { success: false, error: err.message, patients: [] }; }
}

async function resolveSegmentPatients(clinicId, filters) {
  let query = sb.from('patients').select('id, name, phone').eq('clinic_id', clinicId).not('phone', 'is', null).neq('phone', '');
  if (filters && filters.tags && filters.tags.length > 0) {
    // Resolver nomes de tags -> IDs via clinic_tags (patient_tags usa tag_id como FK)
    const { data: tagRows } = await sb.from('clinic_tags').select('id').eq('clinic_id', clinicId).in('name', filters.tags);
    const tagIds = (tagRows || []).map(function(t) { return t.id; });
    if (tagIds.length === 0) { return []; }
    const { data: taggedPatients } = await sb.from('patient_tags').select('patient_id').eq('clinic_id', clinicId).in('tag_id', tagIds);
    if (taggedPatients && taggedPatients.length > 0) {
      const patientIds = Array.from(new Set(taggedPatients.map(function(t) { return t.patient_id; })));
      query = query.in('id', patientIds);
    } else { return []; }
  }
  if (filters && filters.journey_stage) {
    const { data: projections } = await sb.from('patient_crm_projection').select('patient_id').eq('clinic_id', clinicId).eq('journey_stage', filters.journey_stage);
    if (projections && projections.length > 0) { query = query.in('id', projections.map(function(p) { return p.patient_id; })); }
    else { return []; }
  }
  const { data: patients } = await query;
  return patients || [];
}

// ============================================================
// 3. EXECUTAR CAMPANHA (multi-tenant + throttle por tier)
// ============================================================
export async function executeCampaign(campaignId) {
  try {
    const { data: campaign, error: campErr } = await sb.from('crm_campaigns').select('*').eq('id', campaignId).single();
    if (campErr || !campaign) return { success: false, error: 'Campanha nao encontrada' };
    if (['draft', 'scheduled', 'paused'].indexOf(campaign.status) === -1) return { success: false, error: 'Status "' + campaign.status + '" nao executavel' };

    const config = await getClinicWhatsAppConfig(campaign.clinic_id);
    if (!config) {
      await sb.from('crm_campaigns').update({ status: 'failed' }).eq('id', campaignId);
      return { success: false, error: 'WhatsApp nao configurado para a clinica' };
    }

    const throttle = getThrottleConfig(config.messaging_tier);

    const { error: lockErr } = await sb.from('crm_campaigns').update({ status: 'sending', started_at: new Date().toISOString() }).eq('id', campaignId).eq('status', campaign.status);
    if (lockErr) return { success: false, error: 'Falha no lock: ' + lockErr.message };

    const { data: messages } = await sb.from('crm_campaign_messages').select('id, patient_id, phone').eq('campaign_id', campaignId).eq('status', 'pending').order('created_at', { ascending: true });
    if (!messages || messages.length === 0) {
      await sb.from('crm_campaigns').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', campaignId);
      return { success: true, sent: 0, failed: 0 };
    }

    console.log('[CampaignService] Exec ' + campaignId + ' | ' + messages.length + ' msgs | tier:' + config.messaging_tier + ' batch:' + throttle.batchSize);

    let sentCount = 0, failedCount = 0;
    for (let i = 0; i < messages.length; i += throttle.batchSize) {
      const batch = messages.slice(i, i + throttle.batchSize);
      const batchWithPhone = batch;
      const results = await Promise.allSettled(batchWithPhone.map(function(msg) {
        return sendTemplateMessage(config, msg.phone, campaign.template_name, campaign.template_language, campaign.template_components, msg.id);
      }));
      results.forEach(function(r, idx) {
        if (r.status === 'fulfilled' && r.value.success) {
          sentCount++;
          // F8B: Registrar template enviado (fire and forget)
          trackTemplateUsage(campaign.clinic_id, {
            templateName:     campaign.template_name,
            templateCategory: campaign.template_category || 'utility',
            phone:            batchWithPhone[idx].phone,
            messageSid:       r.value.wamid || null,
            campaignId:       campaign.id
          }).catch(function(err) { console.error('[tracking] template:', err.message); });
        } else {
          failedCount++;
        }
      });
      if (i + throttle.batchSize < messages.length) await sleep(throttle.batchDelayMs);
    }

    await sb.rpc('fn_update_campaign_metrics', { p_campaign_id: campaignId });
    return { success: true, sent: sentCount, failed: failedCount };
  } catch (err) {
    await sb.from('crm_campaigns').update({ status: 'failed' }).eq('id', campaignId).catch(function() {});
    return { success: false, error: err.message };
  }
}

async function sendTemplateMessage(config, phone, templateName, templateLanguage, templateComponents, messageId) {
  try {
    let cleanPhone = phone.replace(/[\s\-\+\(\)]/g, '');
    if (cleanPhone.length === 11) cleanPhone = '55' + cleanPhone;
    if (cleanPhone.length === 10) cleanPhone = '55' + cleanPhone;

    const payload = { messaging_product: 'whatsapp', to: cleanPhone, type: 'template', template: { name: templateName, language: { code: templateLanguage || 'pt_BR' } } };
    if (templateComponents && templateComponents.length > 0) payload.template.components = templateComponents;

    const response = await fetch(META_BASE_URL + '/' + config.phone_number_id + '/messages', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + config.access_token, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const result = await response.json();
    if (response.ok && result.messages && result.messages[0]) {
      await sb.from('crm_campaign_messages').update({ status: 'sent', wamid: result.messages[0].id, sent_at: new Date().toISOString() }).eq('id', messageId);
      return { success: true, wamid: result.messages[0].id };
    } else {
      const errCode = (result.error && result.error.code) ? String(result.error.code) : 'unknown';
      const errMsg = (result.error && result.error.message) ? result.error.message : JSON.stringify(result);
      await sb.from('crm_campaign_messages').update({ status: 'failed', error_code: errCode, error_message: errMsg.substring(0, 500), failed_at: new Date().toISOString() }).eq('id', messageId);
      return { success: false, error: errMsg };
    }
  } catch (err) {
    await sb.from('crm_campaign_messages').update({ status: 'failed', error_code: 'NETWORK_ERROR', error_message: err.message.substring(0, 500), failed_at: new Date().toISOString() }).eq('id', messageId);
    return { success: false, error: err.message };
  }
}

// ============================================================
// 4. WEBHOOKS DE STATUS
// ============================================================
export async function processStatusWebhook(wamid, newStatus, timestamp, errorInfo) {
  if (!wamid) return { success: false, error: 'wamid obrigatorio' };
  try {
    const { data: msg } = await sb.from('crm_campaign_messages').select('id, campaign_id, status').eq('wamid', wamid).maybeSingle();
    if (!msg) return { success: false, error: 'not_campaign_message' };

    const statusMap = { sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed' };
    const mappedStatus = statusMap[newStatus];
    if (!mappedStatus) return { success: false, error: 'Status desconhecido' };

    const statusOrder = { pending: 0, sent: 1, delivered: 2, read: 3, failed: -1 };
    if (mappedStatus !== 'failed' && (statusOrder[mappedStatus] || 0) <= (statusOrder[msg.status] || 0)) return { success: true, skipped: true };

    const updateData = { status: mappedStatus };
    const ts = timestamp ? new Date(parseInt(timestamp) * 1000).toISOString() : new Date().toISOString();
    if (mappedStatus === 'sent') updateData.sent_at = ts;
    if (mappedStatus === 'delivered') updateData.delivered_at = ts;
    if (mappedStatus === 'read') updateData.read_at = ts;
    if (mappedStatus === 'failed') { updateData.failed_at = ts; if (errorInfo) { updateData.error_code = errorInfo.code ? String(errorInfo.code) : null; updateData.error_message = errorInfo.title ? errorInfo.title.substring(0, 500) : null; } }

    await sb.from('crm_campaign_messages').update(updateData).eq('id', msg.id);
    await sb.rpc('fn_update_campaign_metrics', { p_campaign_id: msg.campaign_id });
    return { success: true, message_id: msg.id, campaign_id: msg.campaign_id, new_status: mappedStatus };
  } catch (err) { return { success: false, error: err.message }; }
}

// ============================================================
// 5. METRICAS E CONSULTAS
// ============================================================
export async function listCampaigns(clinicId, options) {
  const opts = options || {};
  let query = sb.from('crm_campaigns').select('id, name, description, template_name, template_category, status, total_recipients, sent_count, delivered_count, read_count, failed_count, scheduled_at, started_at, completed_at, created_at, segment_id, min_lead_score, min_score_label').eq('clinic_id', clinicId).order('created_at', { ascending: false }).range(opts.offset || 0, (opts.offset || 0) + (opts.limit || 20) - 1);
  if (opts.status) query = query.eq('status', opts.status);
  const { data, error } = await query;
  return error ? { success: false, error: error.message } : { success: true, campaigns: data || [] };
}

export async function getCampaignDetail(campaignId, clinicId) {
  try {
    const { data: campaign, error: campErr } = await sb.from('crm_campaigns').select('*').eq('id', campaignId).eq('clinic_id', clinicId).single();
    if (campErr || !campaign) return { success: false, error: 'Campanha nao encontrada' };

    const { data: messages } = await sb.from('crm_campaign_messages').select('id, patient_id, phone, status, error_code, error_message, sent_at, delivered_at, read_at, failed_at').eq('campaign_id', campaignId).order('created_at', { ascending: true });
    const conversion = await calculateConversionRate(campaignId);

    const metrics = {
      total: campaign.total_recipients, sent: campaign.sent_count, delivered: campaign.delivered_count,
      read: campaign.read_count, failed: campaign.failed_count,
      pending: campaign.total_recipients - campaign.sent_count - campaign.failed_count,
      delivery_rate: campaign.sent_count > 0 ? Math.round((campaign.delivered_count / campaign.sent_count) * 100) : 0,
      read_rate: campaign.delivered_count > 0 ? Math.round((campaign.read_count / campaign.delivered_count) * 100) : 0,
      conversion_rate: conversion.rate, conversion_count: conversion.count
    };
    return { success: true, campaign, messages: messages || [], metrics };
  } catch (err) { return { success: false, error: err.message }; }
}

async function calculateConversionRate(campaignId) {
  try {
    const { data } = await sb.from('vw_campaign_conversions').select('message_id, patient_id, conversion_event_id').eq('campaign_id', campaignId).not('conversion_event_id', 'is', null);
    const uniquePatients = new Set();
    (data || []).forEach(function(row) { uniquePatients.add(row.patient_id); });
    const { data: sentMsgs } = await sb.from('crm_campaign_messages').select('id', { count: 'exact' }).eq('campaign_id', campaignId).in('status', ['sent', 'delivered', 'read']);
    const totalSent = (sentMsgs && sentMsgs.length) || 1;
    return { rate: Math.round((uniquePatients.size / totalSent) * 100), count: uniquePatients.size };
  } catch (err) { return { rate: 0, count: 0 }; }
}

export async function previewAudience(clinicId, opts) {
  // Suporte a chamada legada: previewAudience(clinicId, segmentId)
  if (typeof opts === 'string' || opts == null) {
    opts = { segmentId: opts || null, audienceType: null, minLeadScore: 0, tagIds: [] };
  }
  const audience = await resolveAudience(clinicId, opts);
  return {
    success: audience.success,
    count: audience.patients ? audience.patients.length : 0,
    sample: audience.patients ? audience.patients.slice(0, 5).map(function(p) { return { id: p.id, name: p.name, phone: maskPhone(p.phone) }; }) : [],
    error: audience.error,
  };
}

export async function cancelCampaign(campaignId, clinicId) {
  const { data, error } = await sb.from('crm_campaigns').update({ status: 'cancelled' }).eq('id', campaignId).eq('clinic_id', clinicId).in('status', ['draft', 'scheduled', 'paused']).select().single();
  return (error || !data) ? { success: false, error: 'Nao foi possivel cancelar' } : { success: true, campaign: data };
}

// ============================================================
// 6. SCHEDULER
// ============================================================
let schedulerInterval = null;
export function startCampaignScheduler() {
  console.log('[CampaignScheduler] Iniciando verificacao a cada 30s');
  schedulerInterval = setInterval(async function() {
    try {
      const { data: due } = await sb.from('crm_campaigns').select('id, name, clinic_id').eq('status', 'scheduled').lte('scheduled_at', new Date().toISOString()).order('scheduled_at', { ascending: true }).limit(5);
      if (!due || due.length === 0) return;
      for (let i = 0; i < due.length; i++) {
        console.log('[CampaignScheduler] Disparando: ' + due[i].name);
        executeCampaign(due[i].id).catch(function(err) { console.error('[CampaignScheduler] Erro:', err); });
      }
    } catch (err) { console.error('[CampaignScheduler] Erro ciclo:', err.message); }
  }, 30000);
}
export function stopCampaignScheduler() { if (schedulerInterval) { clearInterval(schedulerInterval); schedulerInterval = null; } }

// HELPERS
function sleep(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); }
function maskPhone(phone) { if (!phone || phone.length < 8) return phone; return phone.substring(0, 4) + '****' + phone.substring(phone.length - 2); }

/**
 * Converte um lead_score numérico em label semântico.
 * Espelhado de crmService.getScoreLabel para uso local sem import circular.
 */
export function scoreToLabel(score) {
  if (score >= 70) return 'QUENTE';
  if (score >= 40) return 'MORNO';
  if (score >= 15) return 'FRIO';
  return 'INATIVO';
}

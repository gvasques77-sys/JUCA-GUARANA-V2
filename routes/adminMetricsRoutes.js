// routes/adminMetricsRoutes.js
// Sprint 0 — Endpoints admin para o dashboard de métricas (custo OpenAI,
// latência Lara, volume de mensagens). Protegido pelo superadminMiddleware
// (JWT do gv_admins). Usa service_role do Supabase para bypassar RLS.
//
// Endpoints:
//   GET  /api/admin/metrics/openai-cost?period=7d&clinic_id=optional
//   GET  /api/admin/metrics/lara-latency?period=7d&clinic_id=optional
//   GET  /api/admin/metrics/messages-volume?period=7d&clinic_id=optional
//   POST /api/admin/metrics/test-sentry          (TEMPORÁRIO — remover após validação)

import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { superadminMiddleware } from '../middleware/superadminMiddleware.js';
import { isSentryActive } from '../lib/sentry.js';

const router = express.Router();
router.use(superadminMiddleware);

const supabase = createClient(
  process.env.SUPABASE_URL || 'missing',
  process.env.SUPABASE_SERVICE_ROLE_KEY || 'missing',
  { auth: { persistSession: false } }
);

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------
function parsePeriodToDate(period) {
  const now = new Date();
  const m = String(period || '7d').match(/^(\d+)([dh])$/);
  if (!m) {
    // padrão 7 dias
    return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  }
  const n = parseInt(m[1], 10);
  const unit = m[2];
  const ms = unit === 'h' ? n * 60 * 60 * 1000 : n * 24 * 60 * 60 * 1000;
  return new Date(now.getTime() - ms);
}

function dayBucket(isoDate) {
  return String(isoDate).slice(0, 10); // YYYY-MM-DD
}

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length));
  return sortedAsc[idx];
}

async function loadClinicNames() {
  const { data, error } = await supabase
    .from('clinics')
    .select('id, name');
  if (error) {
    console.warn('[adminMetrics] Falha ao carregar clinics:', error.message);
    return {};
  }
  const map = {};
  for (const c of data || []) map[c.id] = c.name;
  return map;
}

// -------------------------------------------------------
// GET /api/admin/metrics/openai-cost
// -------------------------------------------------------
router.get('/openai-cost', async (req, res) => {
  try {
    const since = parsePeriodToDate(req.query.period);
    const clinicFilter = req.query.clinic_id || null;

    let query = supabase
      .from('openai_usage_log')
      .select('clinic_id, model, purpose, prompt_tokens, completion_tokens, cached_tokens, estimated_cost_usd, latency_ms, success, created_at')
      .gte('created_at', since.toISOString())
      .order('created_at', { ascending: false })
      .limit(50000);

    if (clinicFilter) query = query.eq('clinic_id', clinicFilter);

    const { data: rows, error } = await query;
    if (error) throw error;

    const clinicNames = await loadClinicNames();
    const list = rows || [];

    // Agregações
    let totalUsd = 0;
    const byClinic = new Map();
    const byPurpose = new Map();
    const byDay = new Map();

    for (const r of list) {
      const cost = parseFloat(r.estimated_cost_usd || 0);
      totalUsd += cost;

      // by clinic
      const cKey = r.clinic_id || 'unknown';
      if (!byClinic.has(cKey)) {
        byClinic.set(cKey, {
          clinic_id: cKey,
          clinic_name: clinicNames[cKey] || cKey,
          total_usd: 0,
          calls: 0,
          tokens: 0,
        });
      }
      const cAgg = byClinic.get(cKey);
      cAgg.total_usd += cost;
      cAgg.calls += 1;
      cAgg.tokens += (r.prompt_tokens || 0) + (r.completion_tokens || 0);

      // by purpose
      const pKey = r.purpose || 'unknown';
      if (!byPurpose.has(pKey)) {
        byPurpose.set(pKey, { purpose: pKey, total_usd: 0, calls: 0 });
      }
      const pAgg = byPurpose.get(pKey);
      pAgg.total_usd += cost;
      pAgg.calls += 1;

      // by day
      const dKey = dayBucket(r.created_at);
      if (!byDay.has(dKey)) {
        byDay.set(dKey, { day: dKey, total_usd: 0, calls: 0 });
      }
      const dAgg = byDay.get(dKey);
      dAgg.total_usd += cost;
      dAgg.calls += 1;
    }

    return res.json({
      period: req.query.period || '7d',
      since: since.toISOString(),
      total_calls: list.length,
      total_usd: parseFloat(totalUsd.toFixed(6)),
      by_clinic: Array.from(byClinic.values())
        .map(c => ({ ...c, total_usd: parseFloat(c.total_usd.toFixed(6)) }))
        .sort((a, b) => b.total_usd - a.total_usd),
      by_purpose: Array.from(byPurpose.values())
        .map(p => ({ ...p, total_usd: parseFloat(p.total_usd.toFixed(6)) }))
        .sort((a, b) => b.total_usd - a.total_usd),
      by_day: Array.from(byDay.values())
        .map(d => ({ ...d, total_usd: parseFloat(d.total_usd.toFixed(6)) }))
        .sort((a, b) => a.day.localeCompare(b.day)),
    });
  } catch (err) {
    console.error('[adminMetrics] openai-cost error:', err.message);
    return res.status(500).json({ error: 'metrics_query_failed', message: err.message });
  }
});

// -------------------------------------------------------
// GET /api/admin/metrics/lara-latency
// -------------------------------------------------------
router.get('/lara-latency', async (req, res) => {
  try {
    const since = parsePeriodToDate(req.query.period);
    const clinicFilter = req.query.clinic_id || null;

    let query = supabase
      .from('lara_latency_log')
      .select('clinic_id, total_latency_ms, openai_total_ms, context_load_ms, success, created_at')
      .gte('created_at', since.toISOString())
      .order('created_at', { ascending: false })
      .limit(50000);

    if (clinicFilter) query = query.eq('clinic_id', clinicFilter);

    const { data: rows, error } = await query;
    if (error) throw error;

    const list = rows || [];
    const all = list.map(r => r.total_latency_ms || 0).sort((a, b) => a - b);

    // Por dia
    const byDay = new Map();
    for (const r of list) {
      const dKey = dayBucket(r.created_at);
      if (!byDay.has(dKey)) {
        byDay.set(dKey, { day: dKey, samples: [], success: 0, errors: 0 });
      }
      const agg = byDay.get(dKey);
      agg.samples.push(r.total_latency_ms || 0);
      if (r.success) agg.success += 1; else agg.errors += 1;
    }

    const byDayResult = Array.from(byDay.values())
      .map(d => {
        const sorted = d.samples.slice().sort((a, b) => a - b);
        return {
          day: d.day,
          count: sorted.length,
          avg_ms: sorted.length ? Math.round(sorted.reduce((s, v) => s + v, 0) / sorted.length) : 0,
          p50_ms: percentile(sorted, 50),
          p95_ms: percentile(sorted, 95),
          p99_ms: percentile(sorted, 99),
          success: d.success,
          errors: d.errors,
        };
      })
      .sort((a, b) => a.day.localeCompare(b.day));

    return res.json({
      period: req.query.period || '7d',
      since: since.toISOString(),
      total_count: all.length,
      avg_ms: all.length ? Math.round(all.reduce((s, v) => s + v, 0) / all.length) : 0,
      p50_ms: percentile(all, 50),
      p95_ms: percentile(all, 95),
      p99_ms: percentile(all, 99),
      success_count: list.filter(r => r.success).length,
      error_count: list.filter(r => !r.success).length,
      by_day: byDayResult,
    });
  } catch (err) {
    console.error('[adminMetrics] lara-latency error:', err.message);
    return res.status(500).json({ error: 'metrics_query_failed', message: err.message });
  }
});

// -------------------------------------------------------
// GET /api/admin/metrics/messages-volume
// -------------------------------------------------------
router.get('/messages-volume', async (req, res) => {
  try {
    const since = parsePeriodToDate(req.query.period);
    const clinicFilter = req.query.clinic_id || null;

    // Usamos lara_latency_log como proxy de "volume de mensagens da Lara"
    // (uma linha = uma interação processada). Se não houver dados, fallback
    // para conversation_history se a tabela existir.
    let query = supabase
      .from('lara_latency_log')
      .select('clinic_id, created_at')
      .gte('created_at', since.toISOString())
      .limit(100000);

    if (clinicFilter) query = query.eq('clinic_id', clinicFilter);

    const { data: rows, error } = await query;
    if (error) throw error;

    const clinicNames = await loadClinicNames();
    const list = rows || [];

    const byClinic = new Map();
    const byDay = new Map();

    for (const r of list) {
      const cKey = r.clinic_id || 'unknown';
      if (!byClinic.has(cKey)) {
        byClinic.set(cKey, {
          clinic_id: cKey,
          clinic_name: clinicNames[cKey] || cKey,
          total: 0,
        });
      }
      byClinic.get(cKey).total += 1;

      const dKey = dayBucket(r.created_at);
      if (!byDay.has(dKey)) byDay.set(dKey, { day: dKey, total: 0 });
      byDay.get(dKey).total += 1;
    }

    return res.json({
      period: req.query.period || '7d',
      since: since.toISOString(),
      total: list.length,
      by_clinic: Array.from(byClinic.values()).sort((a, b) => b.total - a.total),
      by_day: Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day)),
    });
  } catch (err) {
    console.error('[adminMetrics] messages-volume error:', err.message);
    return res.status(500).json({ error: 'metrics_query_failed', message: err.message });
  }
});

// -------------------------------------------------------
// GET /api/admin/metrics/clinics
// Helper: lista de clínicas para o dropdown do dashboard
// -------------------------------------------------------
router.get('/clinics', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('clinics')
      .select('id, name')
      .order('name', { ascending: true });
    if (error) throw error;
    return res.json({ clinics: data || [] });
  } catch (err) {
    console.error('[adminMetrics] clinics error:', err.message);
    return res.status(500).json({ error: 'clinics_query_failed', message: err.message });
  }
});

// -------------------------------------------------------
// POST /api/admin/metrics/test-sentry
// TEMPORÁRIO — força uma exceção para validar a integração Sentry.
// REMOVER após confirmar que o evento aparece no dashboard Sentry.
// -------------------------------------------------------
router.post('/test-sentry', (req, res) => {
  console.log('[TEST-SENTRY] Endpoint chamado, sentry_active=', isSentryActive());
  // Erro proposital — Sentry deve capturar via setupExpressErrorHandler
  throw new Error('sentry test — Sprint 0 instrumentation validation');
});

export default router;

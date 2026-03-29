// routes/adminUsageRoutes.js
// Rotas admin para visualização de uso (tokens OpenAI + templates Meta)
//
// GET /api/admin/usage/summary              → resumo geral de todas as clínicas
// GET /api/admin/usage/clinic/:id           → uso detalhado de uma clínica
// GET /api/admin/usage/clinic/:id/ai        → tokens OpenAI por clínica
// GET /api/admin/usage/clinic/:id/templates → templates Meta por clínica

import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { superadminMiddleware } from '../middleware/superadminMiddleware.js';

const router = express.Router();
router.use(superadminMiddleware);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Parâmetros de período (padrão: mês atual)
function getPeriodDates(req) {
  const now   = new Date();
  const year  = parseInt(req.query.year  || now.getFullYear());
  const month = parseInt(req.query.month || (now.getMonth() + 1));
  const start = new Date(year, month - 1, 1).toISOString();
  const end   = new Date(year, month, 0, 23, 59, 59).toISOString();
  return { start, end, year, month };
}

// GET /api/admin/usage/summary — resumo de todas as clínicas no período
router.get('/summary', async (req, res) => {
  try {
    const { start, end } = getPeriodDates(req);

    const [aiResult, templateResult, clinicsResult] = await Promise.all([
      supabase
        .from('clinic_ai_usage')
        .select('clinic_id, tokens_total, cost_usd')
        .gte('created_at', start)
        .lte('created_at', end),

      supabase
        .from('clinic_template_usage')
        .select('clinic_id, cost_usd, status')
        .gte('created_at', start)
        .lte('created_at', end),

      supabase
        .from('clinics')
        .select('id, name, is_active')
    ]);

    if (aiResult.error) throw aiResult.error;
    if (templateResult.error) throw templateResult.error;

    // Mapa de clínicas
    const clinicNames = {};
    for (const c of (clinicsResult.data || [])) {
      clinicNames[c.id] = { name: c.name, is_active: c.is_active };
    }

    // Agregar por clinic_id
    const clinicMap = {};

    for (const row of (aiResult.data || [])) {
      if (!clinicMap[row.clinic_id]) {
        clinicMap[row.clinic_id] = {
          clinic_id: row.clinic_id,
          clinic_name: (clinicNames[row.clinic_id] && clinicNames[row.clinic_id].name) || row.clinic_id,
          is_active: clinicNames[row.clinic_id] ? clinicNames[row.clinic_id].is_active : null,
          ai_tokens: 0, ai_cost_usd: 0,
          template_count: 0, template_cost_usd: 0
        };
      }
      clinicMap[row.clinic_id].ai_tokens   += row.tokens_total || 0;
      clinicMap[row.clinic_id].ai_cost_usd += parseFloat(row.cost_usd || 0);
    }

    for (const row of (templateResult.data || [])) {
      if (!clinicMap[row.clinic_id]) {
        clinicMap[row.clinic_id] = {
          clinic_id: row.clinic_id,
          clinic_name: (clinicNames[row.clinic_id] && clinicNames[row.clinic_id].name) || row.clinic_id,
          is_active: clinicNames[row.clinic_id] ? clinicNames[row.clinic_id].is_active : null,
          ai_tokens: 0, ai_cost_usd: 0,
          template_count: 0, template_cost_usd: 0
        };
      }
      clinicMap[row.clinic_id].template_count    += 1;
      clinicMap[row.clinic_id].template_cost_usd += parseFloat(row.cost_usd || 0);
    }

    const summary = Object.values(clinicMap).map(c => ({
      ...c,
      ai_cost_usd:      parseFloat(c.ai_cost_usd.toFixed(6)),
      template_cost_usd: parseFloat(c.template_cost_usd.toFixed(4)),
      total_cost_usd:   parseFloat((c.ai_cost_usd + c.template_cost_usd).toFixed(4))
    })).sort((a, b) => b.total_cost_usd - a.total_cost_usd);

    return res.json({ summary, period: { start, end } });
  } catch (err) {
    console.error('[adminUsage] Erro em /summary:', err);
    return res.status(500).json({ error: 'Erro ao buscar resumo de uso' });
  }
});

// GET /api/admin/usage/clinic/:id — uso completo de uma clínica no período
router.get('/clinic/:id', async (req, res) => {
  try {
    const { start, end } = getPeriodDates(req);
    const clinicId = req.params.id;

    const [aiResult, templateResult] = await Promise.all([
      supabase
        .from('clinic_ai_usage')
        .select('usage_type, model, tokens_input, tokens_output, tokens_total, cost_usd, created_at')
        .eq('clinic_id', clinicId)
        .gte('created_at', start)
        .lte('created_at', end)
        .order('created_at', { ascending: true }),

      supabase
        .from('clinic_template_usage')
        .select('template_name, template_category, status, cost_usd, created_at')
        .eq('clinic_id', clinicId)
        .gte('created_at', start)
        .lte('created_at', end)
        .order('created_at', { ascending: false })
        .limit(100)
    ]);

    if (aiResult.error) throw aiResult.error;
    if (templateResult.error) throw templateResult.error;

    // Totais AI
    const aiTotals = (aiResult.data || []).reduce((acc, row) => {
      acc.tokens_input  += row.tokens_input  || 0;
      acc.tokens_output += row.tokens_output || 0;
      acc.tokens_total  += row.tokens_total  || 0;
      acc.cost_usd      += parseFloat(row.cost_usd || 0);
      acc.calls         += 1;
      return acc;
    }, { tokens_input: 0, tokens_output: 0, tokens_total: 0, cost_usd: 0, calls: 0 });

    // Totais templates
    const templateTotals = (templateResult.data || []).reduce((acc, row) => {
      acc.count    += 1;
      acc.cost_usd += parseFloat(row.cost_usd || 0);
      return acc;
    }, { count: 0, cost_usd: 0 });

    // AI por dia para gráfico
    const aiByDay = {};
    for (const row of (aiResult.data || [])) {
      const day = row.created_at.substring(0, 10);
      if (!aiByDay[day]) aiByDay[day] = { date: day, tokens: 0, cost_usd: 0, calls: 0 };
      aiByDay[day].tokens   += row.tokens_total || 0;
      aiByDay[day].cost_usd += parseFloat(row.cost_usd || 0);
      aiByDay[day].calls    += 1;
    }

    return res.json({
      clinic_id: clinicId,
      period: { start, end },
      ai: {
        totals: {
          ...aiTotals,
          cost_usd: parseFloat(aiTotals.cost_usd.toFixed(6))
        },
        by_day: Object.values(aiByDay).map(d => ({
          ...d,
          cost_usd: parseFloat(d.cost_usd.toFixed(6))
        }))
      },
      templates: {
        totals: {
          ...templateTotals,
          cost_usd: parseFloat(templateTotals.cost_usd.toFixed(4))
        },
        recent: templateResult.data || []
      },
      grand_total_usd: parseFloat((aiTotals.cost_usd + templateTotals.cost_usd).toFixed(4))
    });
  } catch (err) {
    console.error('[adminUsage] Erro em /clinic/:id:', err);
    return res.status(500).json({ error: 'Erro ao buscar uso da clínica' });
  }
});

export default router;

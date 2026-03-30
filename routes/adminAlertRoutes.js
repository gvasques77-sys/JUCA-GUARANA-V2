// routes/adminAlertRoutes.js
// Rotas admin para central de alertas do sistema
//
// GET    /api/admin/alerts              -> listar alertas (com filtros)
// POST   /api/admin/alerts              -> criar alerta manual
// PATCH  /api/admin/alerts/:id/resolve  -> marcar como resolvido
// DELETE /api/admin/alerts/:id          -> deletar alerta

import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { superadminMiddleware } from '../middleware/superadminMiddleware.js';

var router = express.Router();
router.use(superadminMiddleware);

var supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// GET /api/admin/alerts
router.get('/', async function(req, res) {
  try {
    var query = supabase
      .from('system_alerts')
      .select('id, alert_type, source, clinic_id, title, message, metadata, is_resolved, resolved_at, resolved_by, created_at')
      .order('created_at', { ascending: false })
      .limit(parseInt(req.query.limit) || 100);

    if (req.query.clinic_id)   query = query.eq('clinic_id', req.query.clinic_id);
    if (req.query.alert_type)  query = query.eq('alert_type', req.query.alert_type);
    if (req.query.is_resolved !== undefined) {
      query = query.eq('is_resolved', req.query.is_resolved === 'true');
    }

    var result = await query;
    if (result.error) throw result.error;

    // Buscar nome das clinicas para exibicao
    var clinicIds = [];
    var seen = {};
    (result.data || []).forEach(function(a) {
      if (a.clinic_id && !seen[a.clinic_id]) {
        clinicIds.push(a.clinic_id);
        seen[a.clinic_id] = true;
      }
    });
    var clinicNames = {};

    if (clinicIds.length > 0) {
      var clinicsResult = await supabase
        .from('clinics')
        .select('id, name')
        .in('id', clinicIds);

      if (!clinicsResult.error && clinicsResult.data) {
        clinicsResult.data.forEach(function(c) { clinicNames[c.id] = c.name; });
      }
    }

    var alerts = (result.data || []).map(function(alert) {
      return Object.assign({}, alert, {
        clinic_name: alert.clinic_id ? (clinicNames[alert.clinic_id] || 'Clinica desconhecida') : null
      });
    });

    return res.json({ alerts: alerts, total: alerts.length });
  } catch (err) {
    console.error('[adminAlerts] Erro ao listar alertas:', err);
    return res.status(500).json({ error: 'Erro ao buscar alertas' });
  }
});

// POST /api/admin/alerts
router.post('/', async function(req, res) {
  try {
    var body = req.body;
    var alert_type = body.alert_type;
    var source     = body.source || 'internal';
    var clinic_id  = body.clinic_id || null;
    var title      = body.title;
    var message    = body.message;

    if (!alert_type || !title || !message) {
      return res.status(400).json({ error: 'alert_type, title e message sao obrigatorios' });
    }

    var validTypes   = ['error', 'warning', 'info'];
    var validSources = ['railway', 'openai', 'meta', 'supabase', 'internal'];

    if (validTypes.indexOf(alert_type) === -1) {
      return res.status(400).json({ error: 'alert_type invalido. Use: error, warning, info' });
    }
    if (validSources.indexOf(source) === -1) {
      return res.status(400).json({ error: 'source invalido. Use: railway, openai, meta, supabase, internal' });
    }

    var record = {
      alert_type: alert_type,
      source:     source,
      clinic_id:  clinic_id,
      title:      title,
      message:    message,
      metadata:   body.metadata || null
    };

    var result = await supabase
      .from('system_alerts')
      .insert(record)
      .select()
      .single();

    if (result.error) throw result.error;
    return res.status(201).json(result.data);
  } catch (err) {
    console.error('[adminAlerts] Erro ao criar alerta:', err);
    return res.status(500).json({ error: 'Erro ao criar alerta' });
  }
});

// PATCH /api/admin/alerts/:id/resolve
router.patch('/:id/resolve', async function(req, res) {
  try {
    var result = await supabase
      .from('system_alerts')
      .update({
        is_resolved: true,
        resolved_at: new Date().toISOString(),
        resolved_by: req.adminId
      })
      .eq('id', req.params.id)
      .select()
      .single();

    if (result.error) throw result.error;
    if (!result.data) return res.status(404).json({ error: 'Alerta nao encontrado' });

    return res.json(result.data);
  } catch (err) {
    console.error('[adminAlerts] Erro ao resolver alerta:', err);
    return res.status(500).json({ error: 'Erro ao resolver alerta' });
  }
});

// DELETE /api/admin/alerts/:id
router.delete('/:id', async function(req, res) {
  try {
    var result = await supabase
      .from('system_alerts')
      .delete()
      .eq('id', req.params.id);

    if (result.error) throw result.error;
    return res.json({ message: 'Alerta removido com sucesso' });
  } catch (err) {
    console.error('[adminAlerts] Erro ao deletar alerta:', err);
    return res.status(500).json({ error: 'Erro ao deletar alerta' });
  }
});

export default router;

// routes/adminClinicRoutes.js
// Rotas admin para gestão de clínicas
//
// GET    /api/admin/clinics              → lista todas com métricas
// GET    /api/admin/clinics/overview     → KPIs da plataforma
// GET    /api/admin/clinics/:id          → detalhes de uma clínica
// PATCH  /api/admin/clinics/:id/status   → ativar/desativar clínica
// PUT    /api/admin/clinics/:id/billing  → configurar billing da clínica

import express from 'express';
import { superadminMiddleware } from '../middleware/superadminMiddleware.js';
import {
  getAllClinicsOverview,
  getClinicDetail,
  toggleClinicStatus,
  upsertBillingConfig,
  getPlatformOverview
} from '../services/adminClinicService.js';

const router = express.Router();

// Todas as rotas exigem auth de admin
router.use(superadminMiddleware);

// GET /api/admin/clinics/overview — KPIs gerais da plataforma
router.get('/overview', async (req, res) => {
  try {
    const overview = await getPlatformOverview();
    return res.json(overview);
  } catch (err) {
    console.error('[adminClinics] Erro em /overview:', err);
    return res.status(500).json({ error: 'Erro ao buscar overview da plataforma' });
  }
});

// GET /api/admin/clinics — lista todas as clínicas
router.get('/', async (req, res) => {
  try {
    const clinics = await getAllClinicsOverview();
    return res.json({ clinics, total: clinics.length });
  } catch (err) {
    console.error('[adminClinics] Erro ao listar clínicas:', err);
    return res.status(500).json({ error: 'Erro ao buscar clínicas' });
  }
});

// GET /api/admin/clinics/:id — detalhes de uma clínica
router.get('/:id', async (req, res) => {
  try {
    const clinic = await getClinicDetail(req.params.id);
    if (!clinic) return res.status(404).json({ error: 'Clínica não encontrada' });
    return res.json(clinic);
  } catch (err) {
    console.error('[adminClinics] Erro ao buscar clínica:', err);
    return res.status(500).json({ error: 'Erro ao buscar detalhes da clínica' });
  }
});

// PATCH /api/admin/clinics/:id/status
router.patch('/:id/status', async (req, res) => {
  try {
    const { is_active } = req.body;
    if (typeof is_active !== 'boolean') {
      return res.status(400).json({ error: 'Campo is_active deve ser boolean' });
    }
    const updated = await toggleClinicStatus(req.params.id, is_active);
    return res.json(updated);
  } catch (err) {
    console.error('[adminClinics] Erro ao alterar status:', err);
    return res.status(500).json({ error: 'Erro ao alterar status da clínica' });
  }
});

// PUT /api/admin/clinics/:id/billing
router.put('/:id/billing', async (req, res) => {
  try {
    const billing = await upsertBillingConfig(req.params.id, req.body);
    return res.json(billing);
  } catch (err) {
    console.error('[adminClinics] Erro ao salvar billing:', err);
    return res.status(500).json({ error: 'Erro ao salvar configuração de billing' });
  }
});

export default router;

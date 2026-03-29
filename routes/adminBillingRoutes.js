// routes/adminBillingRoutes.js
// Rotas admin para gestao de billing via Asaas

import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { superadminMiddleware } from '../middleware/superadminMiddleware.js';
import {
  createCustomer,
  getCustomer,
  listCustomers,
  listChargesByCustomer,
  createCharge,
  deleteCharge,
  generateMonthlyUsageCharge
} from '../services/asaasService.js';

var router = express.Router();
router.use(superadminMiddleware);

var supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// POST /api/admin/billing/customers — criar cliente no Asaas e salvar ID
router.post('/customers', async function(req, res) {
  try {
    var body = req.body;
    var clinic_id = body.clinic_id;
    var name = body.name;
    var email = body.email;
    var phone = body.phone;
    var cpf_cnpj = body.cpf_cnpj;

    if (!clinic_id || !name || !email) {
      return res.status(400).json({ error: 'clinic_id, name e email sao obrigatorios' });
    }

    var customer = await createCustomer({ clinic_id: clinic_id, name: name, email: email, phone: phone, cpf_cnpj: cpf_cnpj });

    // Salvar asaas_customer_id na clinic_billing_config
    var dbResult = await supabase
      .from('clinic_billing_config')
      .upsert(
        { clinic_id: clinic_id, asaas_customer_id: customer.id },
        { onConflict: 'clinic_id' }
      );

    if (dbResult.error) {
      console.error('[adminBilling] Erro ao salvar customer_id:', dbResult.error);
    }

    return res.json({ customer: customer });
  } catch (err) {
    console.error('[adminBilling] Erro ao criar customer:', err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/billing/customers — listar todos os clientes no Asaas
router.get('/customers', async function(req, res) {
  try {
    var result = await listCustomers({ limit: 100 });
    return res.json(result);
  } catch (err) {
    console.error('[adminBilling] Erro ao listar customers:', err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/billing/customers/:asaasId — detalhes do cliente
router.get('/customers/:asaasId', async function(req, res) {
  try {
    var customer = await getCustomer(req.params.asaasId);
    return res.json(customer);
  } catch (err) {
    console.error('[adminBilling] Erro ao buscar customer:', err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/billing/customers/:asaasId/charges — cobrancas do cliente
router.get('/customers/:asaasId/charges', async function(req, res) {
  try {
    var charges = await listChargesByCustomer(req.params.asaasId, { limit: 50 });
    return res.json(charges);
  } catch (err) {
    console.error('[adminBilling] Erro ao listar charges:', err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/billing/charges — criar cobranca manual
router.post('/charges', async function(req, res) {
  try {
    var body = req.body;
    var asaas_customer_id = body.asaas_customer_id;
    var value = body.value;
    var due_date = body.due_date;
    var description = body.description;
    var billing_type = body.billing_type;

    if (!asaas_customer_id || !value || !due_date) {
      return res.status(400).json({ error: 'asaas_customer_id, value e due_date sao obrigatorios' });
    }

    var charge = await createCharge({
      asaasCustomerId: asaas_customer_id,
      value: value,
      dueDate: due_date,
      description: description || 'Cobranca manual CLINICORE',
      billingType: billing_type || 'UNDEFINED'
    });

    return res.json({ charge: charge });
  } catch (err) {
    console.error('[adminBilling] Erro ao criar charge:', err);
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/billing/charges/:chargeId — cancelar cobranca
router.delete('/charges/:chargeId', async function(req, res) {
  try {
    var result = await deleteCharge(req.params.chargeId);
    return res.json(result);
  } catch (err) {
    console.error('[adminBilling] Erro ao deletar charge:', err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/billing/generate/:clinicId — gerar fatura mensal automatica
router.post('/generate/:clinicId', async function(req, res) {
  try {
    var year = req.body.year;
    var month = req.body.month;

    if (!year || !month) {
      return res.status(400).json({ error: 'year e month sao obrigatorios' });
    }

    var result = await generateMonthlyUsageCharge(req.params.clinicId, year, month);
    return res.json(result);
  } catch (err) {
    console.error('[adminBilling] Erro ao gerar fatura:', err);
    return res.status(500).json({ error: err.message });
  }
});

export default router;

// routes/adminOnboardingRoutes.js
// Onboarding de novas clinicas + gestao de admins GV
//
// --- ONBOARDING ---
// POST /api/admin/onboarding/clinic     -> criar clinica completa (owner + config)
//
// --- ADMINS GV ---
// GET    /api/admin/gv-admins           -> listar admins GV
// POST   /api/admin/gv-admins           -> criar novo admin GV
// PATCH  /api/admin/gv-admins/:id       -> atualizar admin (ativar/desativar/role)
// DELETE /api/admin/gv-admins/:id       -> remover admin GV

import express from 'express';
import bcrypt from 'bcrypt';
import { createClient } from '@supabase/supabase-js';
import { superadminMiddleware, requireSuperadmin } from '../middleware/superadminMiddleware.js';

var router = express.Router();
router.use(superadminMiddleware);

var supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ================================================================
// ONBOARDING DE CLINICAS
// ================================================================

function generateSlug(name) {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    + '-' + Date.now().toString(36);
}

// POST /api/admin/onboarding/clinic
router.post('/onboarding/clinic', requireSuperadmin, async function(req, res) {
  var body = req.body;

  var clinicName    = body.clinic_name;
  var ownerEmail    = body.owner_email;
  var ownerName     = body.owner_name;
  var ownerPassword = body.owner_password;
  var plan          = body.plan || 'basic';
  var monthlyFee    = body.monthly_fee || 0;
  var billingDay    = body.billing_day || 1;

  if (!clinicName || !ownerEmail || !ownerName || !ownerPassword) {
    return res.status(400).json({
      error: 'Campos obrigatorios: clinic_name, owner_email, owner_name, owner_password'
    });
  }

  if (ownerPassword.length < 6) {
    return res.status(400).json({ error: 'Senha do owner deve ter no minimo 6 caracteres' });
  }

  // Validar plan contra enum real: basic, premium
  var validPlans = ['basic', 'premium'];
  if (validPlans.indexOf(plan) === -1) {
    plan = 'basic';
  }

  var clinicId = null;
  var userId   = null;

  try {
    // PASSO 1: Criar clinica
    // Schema real: id, name, slug, status (enum: active/suspended/cancelled), plan (enum: basic/premium), created_at
    var slug = generateSlug(clinicName);
    var clinicResult = await supabase
      .from('clinics')
      .insert({ name: clinicName, slug: slug, status: 'active', plan: plan })
      .select('id, name')
      .single();

    if (clinicResult.error) throw new Error('Erro ao criar clinica: ' + clinicResult.error.message);
    clinicId = clinicResult.data.id;

    // PASSO 2: Criar usuario owner no Supabase Auth
    var authResult = await supabase.auth.admin.createUser({
      email:         ownerEmail,
      password:      ownerPassword,
      email_confirm: true,
      user_metadata: { name: ownerName }
    });

    if (authResult.error) throw new Error('Erro ao criar usuario: ' + authResult.error.message);
    userId = authResult.data.user.id;

    // PASSO 3: Vincular usuario a clinica como owner
    // Schema real clinic_users: id, clinic_id, user_id, role, created_at
    var clinicUserResult = await supabase
      .from('clinic_users')
      .insert({
        clinic_id: clinicId,
        user_id:   userId,
        role:      'owner'
      });

    if (clinicUserResult.error) throw new Error('Erro ao vincular owner: ' + clinicUserResult.error.message);

    // PASSO 4: Criar billing config inicial
    var billingResult = await supabase
      .from('clinic_billing_config')
      .insert({
        clinic_id:   clinicId,
        plan:        plan,
        monthly_fee: monthlyFee,
        billing_day: billingDay,
        is_active:   true,
        price_per_1k_tokens_input:  0,
        price_per_1k_tokens_output: 0,
        price_per_template:         0
      });

    if (billingResult.error) {
      console.warn('[onboarding] Aviso ao criar billing config:', billingResult.error.message);
    }

    return res.status(201).json({
      message:  'Clinica criada com sucesso',
      clinic:   { id: clinicId, name: clinicName },
      owner:    { id: userId, email: ownerEmail, name: ownerName },
      next_steps: [
        'Configurar WhatsApp Business na aba Clinicas',
        'Definir precos de tokens e templates no Billing',
        'Cadastrar a clinica como cliente no Asaas'
      ]
    });
  } catch (err) {
    // Rollback parcial: se a clinica foi criada mas o usuario falhou, remover a clinica
    if (clinicId && !userId) {
      await supabase.from('clinics').delete().eq('id', clinicId).catch(function() {});
    }
    console.error('[onboarding] Erro:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ================================================================
// GESTAO DE ADMINS GV
// ================================================================

// GET /api/admin/gv-admins
router.get('/gv-admins', async function(req, res) {
  try {
    var result = await supabase
      .from('gv_admins')
      .select('id, email, name, role, is_active, last_login_at, created_at')
      .order('created_at', { ascending: true });

    if (result.error) throw result.error;
    return res.json({ admins: result.data || [], total: (result.data || []).length });
  } catch (err) {
    console.error('[adminGV] Erro ao listar admins:', err);
    return res.status(500).json({ error: 'Erro ao buscar admins' });
  }
});

// POST /api/admin/gv-admins
router.post('/gv-admins', requireSuperadmin, async function(req, res) {
  try {
    var body     = req.body;
    var email    = body.email;
    var name     = body.name;
    var password = body.password;
    var role     = body.role || 'admin';

    if (!email || !name || !password) {
      return res.status(400).json({ error: 'email, name e password sao obrigatorios' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Senha deve ter no minimo 8 caracteres' });
    }

    var validRoles = ['superadmin', 'admin', 'viewer'];
    if (validRoles.indexOf(role) === -1) {
      return res.status(400).json({ error: 'role invalido. Use: superadmin, admin, viewer' });
    }

    var passwordHash = await bcrypt.hash(password, 12);

    var result = await supabase
      .from('gv_admins')
      .insert({
        email:         email.toLowerCase().trim(),
        password_hash: passwordHash,
        name:          name,
        role:          role,
        is_active:     true
      })
      .select('id, email, name, role, is_active, created_at')
      .single();

    if (result.error) {
      if (result.error.code === '23505') {
        return res.status(409).json({ error: 'Este email ja esta cadastrado' });
      }
      throw result.error;
    }

    return res.status(201).json(result.data);
  } catch (err) {
    console.error('[adminGV] Erro ao criar admin:', err);
    return res.status(500).json({ error: 'Erro ao criar admin' });
  }
});

// PATCH /api/admin/gv-admins/:id
router.patch('/gv-admins/:id', requireSuperadmin, async function(req, res) {
  try {
    if (req.params.id === req.adminId && req.body.is_active === false) {
      return res.status(400).json({ error: 'Voce nao pode desativar sua propria conta' });
    }

    var updates = {};
    if (req.body.name      !== undefined) updates.name      = req.body.name;
    if (req.body.role      !== undefined) updates.role      = req.body.role;
    if (req.body.is_active !== undefined) updates.is_active = req.body.is_active;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    }

    var result = await supabase
      .from('gv_admins')
      .update(updates)
      .eq('id', req.params.id)
      .select('id, email, name, role, is_active')
      .single();

    if (result.error) throw result.error;
    if (!result.data) return res.status(404).json({ error: 'Admin nao encontrado' });

    return res.json(result.data);
  } catch (err) {
    console.error('[adminGV] Erro ao atualizar admin:', err);
    return res.status(500).json({ error: 'Erro ao atualizar admin' });
  }
});

// DELETE /api/admin/gv-admins/:id
router.delete('/gv-admins/:id', requireSuperadmin, async function(req, res) {
  try {
    if (req.params.id === req.adminId) {
      return res.status(400).json({ error: 'Voce nao pode remover sua propria conta' });
    }

    var result = await supabase
      .from('gv_admins')
      .delete()
      .eq('id', req.params.id);

    if (result.error) throw result.error;
    return res.json({ message: 'Admin removido com sucesso' });
  } catch (err) {
    console.error('[adminGV] Erro ao remover admin:', err);
    return res.status(500).json({ error: 'Erro ao remover admin' });
  }
});

export default router;

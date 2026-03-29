// routes/adminAuthRoutes.js
// Rotas de autenticação do backoffice GV
// POST /api/admin/auth/login
// POST /api/admin/auth/logout
// GET  /api/admin/auth/me

import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { createClient } from '@supabase/supabase-js';
import { superadminMiddleware } from '../middleware/superadminMiddleware.js';

const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET;
const ADMIN_JWT_EXPIRES_IN = '8h';

// POST /api/admin/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email e senha são obrigatórios' });
    }

    const { data: admin, error } = await supabase
      .from('gv_admins')
      .select('id, email, password_hash, name, role, is_active')
      .eq('email', email.toLowerCase().trim())
      .single();

    if (error || !admin) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    if (!admin.is_active) {
      return res.status(401).json({ error: 'Conta desativada. Entre em contato com o suporte.' });
    }

    const passwordMatch = await bcrypt.compare(password, admin.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    await supabase
      .from('gv_admins')
      .update({ last_login_at: new Date().toISOString() })
      .eq('id', admin.id);

    const token = jwt.sign(
      {
        adminId: admin.id,
        email: admin.email,
        name: admin.name,
        role: admin.role
      },
      ADMIN_JWT_SECRET,
      { expiresIn: ADMIN_JWT_EXPIRES_IN }
    );

    return res.json({
      token,
      admin: {
        id: admin.id,
        email: admin.email,
        name: admin.name,
        role: admin.role
      }
    });
  } catch (err) {
    console.error('[adminAuth] Erro no login:', err);
    return res.status(500).json({ error: 'Erro interno' });
  }
});

// GET /api/admin/auth/me — validar token e retornar dados do admin logado
router.get('/me', superadminMiddleware, async (req, res) => {
  try {
    const { data: admin, error } = await supabase
      .from('gv_admins')
      .select('id, email, name, role, last_login_at')
      .eq('id', req.adminId)
      .single();

    if (error || !admin) {
      return res.status(404).json({ error: 'Admin não encontrado' });
    }

    return res.json({ admin });
  } catch (err) {
    console.error('[adminAuth] Erro em /me:', err);
    return res.status(500).json({ error: 'Erro interno' });
  }
});

// POST /api/admin/auth/logout — apenas invalida no client (JWT stateless)
router.post('/logout', superadminMiddleware, (req, res) => {
  return res.json({ message: 'Logout realizado com sucesso' });
});

export default router;

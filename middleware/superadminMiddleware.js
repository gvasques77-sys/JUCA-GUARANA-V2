// middleware/superadminMiddleware.js
// Middleware de autenticação exclusivo para rotas /api/admin/*
// Usa JWT separado do sistema de auth das clínicas

import jwt from 'jsonwebtoken';

const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET;

if (!ADMIN_JWT_SECRET) {
  console.error('[superadminMiddleware] ADMIN_JWT_SECRET não configurado!');
}

export function superadminMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Token de autenticação não fornecido',
        code: 'ADMIN_AUTH_REQUIRED'
      });
    }

    const token = authHeader.split(' ')[1];

    const decoded = jwt.verify(token, ADMIN_JWT_SECRET);

    if (!decoded.adminId || !decoded.role) {
      return res.status(401).json({
        error: 'Token inválido',
        code: 'ADMIN_TOKEN_INVALID'
      });
    }

    // Anexar dados do admin na requisição
    req.adminId = decoded.adminId;
    req.adminRole = decoded.role;
    req.adminEmail = decoded.email;

    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        error: 'Sessão expirada. Faça login novamente.',
        code: 'ADMIN_TOKEN_EXPIRED'
      });
    }

    return res.status(401).json({
      error: 'Token inválido',
      code: 'ADMIN_TOKEN_INVALID'
    });
  }
}

// Middleware adicional: somente superadmin pode executar ação
export function requireSuperadmin(req, res, next) {
  if (req.adminRole !== 'superadmin') {
    return res.status(403).json({
      error: 'Permissão insuficiente. Apenas superadmin pode executar esta ação.',
      code: 'ADMIN_FORBIDDEN'
    });
  }
  next();
}

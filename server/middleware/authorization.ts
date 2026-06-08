import { Request, Response, NextFunction } from 'express';

const ROLE_RANK: Record<string, number> = {
  Responder: 0,
  Viewer: 1,
  Validator: 2,
  'Senior Validator': 2,
  Admin: 3,
};

export function requireRole(minRole: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (process.env.DISABLE_LOGIN === 'true') return next();
    const userRank = ROLE_RANK[req.user?.role || ''] ?? -1;
    const minRank = ROLE_RANK[minRole] ?? 999;
    if (userRank < minRank) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

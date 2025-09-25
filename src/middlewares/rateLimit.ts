/** @format */
import type { Request, Response, NextFunction } from "express";
import { RATE_LIMIT, ERROR_MESSAGES } from "../config/constants";

export const gameLimiter = (() => {
  type Entry = { count: number; resetAt: number };
  const hits = new Map<string, Entry>();
  const windowMs = RATE_LIMIT.GAME.windowMs;
  const max = RATE_LIMIT.GAME.max;

  return (req: Request, res: Response, next: NextFunction) => {
    // ใช้ userId เป็น key ถ้ามี ไม่งั้นใช้ IP
    const key = (req as any).user?.id || req.ip || (Array.isArray(req.ips) ? req.ips[0] : req.ips) || "anon";

    const now = Date.now();
    const cur = hits.get(key);

    if (!cur || now > cur.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (cur.count >= max) {
      const retryAfter = Math.ceil((cur.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({ error: ERROR_MESSAGES.TOO_MANY_REQUESTS });
    }

    cur.count++;
    next();
  };
})();

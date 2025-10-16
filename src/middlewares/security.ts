/** @format */
import rateLimit from "express-rate-limit";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { prisma } from "../prisma";

declare global {
  namespace Express {
    interface Request {
      user?: {
        uid: string;
        username: string;
        role: "PLAYER" | "ADMIN";
      };
    }
  }
}

const JWT_SECRET = process.env.JWT_SECRET || "change_me";
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "change_me_refresh";

// ⭐ Rate Limiters - ปรับใหม่เหมาะสม
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 นาที
  max: 100, // 100 requests ต่อ 15 นาที
  message: { error: "Too many authentication attempts" },
  standardHeaders: true,
  legacyHeaders: false,
});

export const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 นาที
  max: 60, // 60 requests ต่อนาที
  message: { error: "Too many requests" },
  standardHeaders: true,
  legacyHeaders: false,
});

// ⭐ /me endpoint - จำกัดแต่ไม่เข้มงวดเกินไป
export const meRouteLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 นาที
  max: 30, // 30 requests ต่อนาที (เพียงพอสำหรับ refresh ปกติ)
  message: { error: "Too many authentication checks" },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // ข้าม rate limit ถ้าเป็น OPTIONS request
    return req.method === "OPTIONS";
  },
});

// Validation schemas
export const signUpSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(20)
    .regex(/^[a-zA-Z0-9_-]+$/),
  password: z.string().min(6),
  preferredLang: z.enum(["th", "en"]).optional(),
});

export const signInSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

// Token utilities
export interface TokenPayload {
  uid: string;
  username: string;
  role: "PLAYER" | "ADMIN";
}

// ⭐ Token อายุปกติ
export const generateTokens = (payload: TokenPayload) => {
  const accessToken = jwt.sign(payload, JWT_SECRET, {
    expiresIn: "24h", // ⭐ เปลี่ยนจาก 15m เป็น 24h
  });

  const refreshToken = jwt.sign(payload, JWT_REFRESH_SECRET, {
    expiresIn: "30d", // ⭐ เปลี่ยนจาก 7d เป็น 30d
  });

  return { accessToken, refreshToken };
};

export const verifyAccessToken = (token: string): TokenPayload =>
  jwt.verify(token, JWT_SECRET) as TokenPayload;

export const verifyRefreshToken = (token: string): TokenPayload =>
  jwt.verify(token, JWT_REFRESH_SECRET) as TokenPayload;

// Middleware
export const validateInput = (schema: z.ZodSchema) => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      schema.parse(req.body);
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          error: "Validation failed",
          details: error.errors.map((err) => ({
            field: err.path.join("."),
            message: err.message,
          })),
        });
      }
      return res.status(400).json({ error: "Invalid input" });
    }
  };
};

export const authenticateToken = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.cookies?.auth_token || req.headers.authorization?.replace("Bearer ", "");

    if (!token) {
      return res.status(401).json({ error: "Access token required" });
    }

    const payload = verifyAccessToken(token);

    const user = await prisma.user.findUnique({
      where: { id: payload.uid },
      select: { id: true, username: true, role: true, isActive: true },
    });

    if (!user || !user.isActive) {
      return res.status(401).json({ error: "Invalid user" });
    }

    req.user = {
      uid: user.id,
      username: user.username,
      role: user.role,
    };

    next();
  } catch (error) {
    // ⭐ Token หมดอายุ = ให้ logout
    return res.status(401).json({
      error: "Token expired",
      shouldLogout: true,
    });
  }
};

export const adminOnly = (req: Request, res: Response, next: NextFunction) => {
  if (!req.user || req.user.role !== "ADMIN") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
};

// Utilities
export const hashPassword = (password: string) => bcrypt.hash(password, 12);
export const comparePassword = (password: string, hash: string) => bcrypt.compare(password, hash);

export const sanitizeUser = (user: any) => {
  const { passwordHash, ...sanitized } = user;
  return sanitized;
};

export const requireAuth = async (req: Request & { auth?: any }, res: Response, next: NextFunction) => {
  try {
    const token = req.cookies?.auth_token || req.headers.authorization?.replace("Bearer ", "");

    if (!token) {
      return res.status(401).json({
        error: "Authentication required",
        shouldLogout: true,
      });
    }

    const payload = verifyAccessToken(token);

    if (payload.uid.startsWith("anon_")) {
      req.auth = {
        userId: payload.uid,
        username: "Anonymous",
        role: "PLAYER",
        lang: "th",
      };
      return next();
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.uid },
      select: { id: true, username: true, role: true, preferredLang: true, isActive: true },
    });

    if (!user || !user.isActive) {
      return res.status(401).json({
        error: "Invalid user",
        shouldLogout: true,
      });
    }

    req.auth = {
      userId: user.id,
      username: user.username,
      role: user.role,
      lang: user.preferredLang,
    };

    next();
  } catch (error) {
    return res.status(401).json({
      error: "Token expired",
      shouldLogout: true,
    });
  }
};

// CORS options
export const corsOptions = {
  origin: function (origin: any, callback: any) {
    if (!origin) return callback(null, true);

    const allowedOrigins = [
      "http://localhost:3000",
      "http://localhost:3001",
      "http://127.0.0.1:3000",
      process.env.FRONTEND_URL,
    ].filter(Boolean);

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Cookie"],
  exposedHeaders: ["set-cookie"],
};

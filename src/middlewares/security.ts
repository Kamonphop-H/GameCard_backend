/** @format */
import rateLimit from "express-rate-limit";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { prisma } from "../prisma";

// ============================
// Type augmentations
// ============================
declare global {
  namespace Express {
    interface Request {
      user?: {
        uid: string;
        username: string;
        role: "PLAYER" | "ADMIN";
      };
      auth?: {
        userId: string;
        username: string;
        role: "PLAYER" | "ADMIN";
        lang: "th" | "en";
      };
    }
  }
}

export interface TokenPayload {
  uid: string;
  username: string;
  role: "PLAYER" | "ADMIN";
}

export interface AuthRequest extends Request {
  auth?: {
    userId: string;
    username: string;
    role: "PLAYER" | "ADMIN";
    lang: "th" | "en";
  };
}

// ============================
// JWT Secrets
// ============================
const JWT_SECRET = process.env.JWT_SECRET || "change_me";
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "change_me_refresh";

// ============================
// Rate Limiters
// ============================
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: "Too many authentication attempts" },
  standardHeaders: true,
  legacyHeaders: false,
});

export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: "Too many requests" },
  standardHeaders: true,
  legacyHeaders: false,
});

export const meRouteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: "Too many authentication checks" },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "OPTIONS",
});

// ============================
// Validation Schemas & Helper
// ============================
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

// 🔥 FIX: เพิ่ม error logging และ handle edge cases
export const validateInput = (schema: z.ZodSchema) => (req: Request, res: Response, next: NextFunction) => {
  try {
    schema.parse(req.body);
    return next();
  } catch (error) {
    console.error("❌ Validation error:", error);

    if (error instanceof z.ZodError) {
      return res.status(400).json({
        error: "Validation failed",
        details: error.errors.map((e) => ({
          field: e.path.join("."),
          message: e.message,
        })),
      });
    }

    // Handle unexpected errors
    return res.status(400).json({
      error: "Invalid input",
      details: error instanceof Error ? error.message : "Unknown validation error",
    });
  }
};

// ============================
// Auth Utils
// ============================
export const generateTokens = (payload: TokenPayload) => {
  const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: "24h" });
  const refreshToken = jwt.sign(payload, JWT_REFRESH_SECRET, { expiresIn: "30d" });
  return { accessToken, refreshToken };
};

export const verifyAccessToken = (token: string): TokenPayload =>
  jwt.verify(token, JWT_SECRET) as TokenPayload;

export const verifyRefreshToken = (token: string): TokenPayload =>
  jwt.verify(token, JWT_REFRESH_SECRET) as TokenPayload;

// ============================
// Password Utils
// ============================
export const hashPassword = (password: string) => bcrypt.hash(password, 12);
export const comparePassword = (password: string, hash: string) => bcrypt.compare(password, hash);

export const sanitizeUser = (user: any) => {
  const { passwordHash, ...sanitized } = user;
  return sanitized;
};

// ============================
// Middlewares
// ============================

/**
 * requireAuth
 * - ตรวจสอบ JWT (cookie: auth_token หรือ Authorization: Bearer)
 * - แนบข้อมูลไว้ที่ req.auth
 * - รองรับผู้ใช้ anon_* (ไม่เช็คฐานข้อมูล)
 */
export const requireAuth = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const token = req.cookies?.auth_token || req.headers.authorization?.replace("Bearer ", "");

    if (!token) {
      return res.status(401).json({ error: "Authentication required", shouldLogout: true });
    }

    const payload = verifyAccessToken(token);

    // อนุญาตโหมด Anonymous
    if (payload.uid.startsWith("anon_")) {
      req.auth = {
        userId: payload.uid,
        username: "Anonymous",
        role: "PLAYER",
        lang: "th",
      };
      return next();
    }

    // ตรวจสอบผู้ใช้จริงใน DB
    const user = await prisma.user.findUnique({
      where: { id: payload.uid },
      select: { id: true, username: true, role: true, preferredLang: true, isActive: true },
    });

    if (!user || !user.isActive) {
      return res.status(401).json({ error: "Invalid user", shouldLogout: true });
    }

    req.auth = {
      userId: user.id,
      username: user.username,
      role: user.role,
      lang: (user.preferredLang as "th" | "en") ?? "th",
    };

    return next();
  } catch (error: any) {
    const isExpired = error?.name === "TokenExpiredError";
    return res.status(401).json({
      error: isExpired ? "Token expired" : "Invalid token",
      shouldLogout: !isExpired,
      shouldRefresh: !!isExpired,
    });
  }
};

/**
 * authenticateToken (legacy)
 * - เวอร์ชันที่ตั้งค่า req.user (เพื่อรองรับโค้ดเก่า)
 * - ถ้าอยากใช้รูปแบบใหม่ ให้ใช้ requireAuth แล้วอ่านจาก req.auth
 */
export const authenticateToken = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.cookies?.auth_token || req.headers.authorization?.replace("Bearer ", "");

    if (!token) {
      return res.status(401).json({ error: "Access token required" });
    }

    const payload = verifyAccessToken(token);

    // รองรับ anon_* แต่จะ map เป็น PLAYER ปกติ
    if (payload.uid.startsWith("anon_")) {
      req.user = { uid: payload.uid, username: "Anonymous", role: "PLAYER" };
      return next();
    }

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

    return next();
  } catch (error) {
    return res.status(401).json({ error: "Token expired", shouldLogout: true });
  }
};

/**
 * requireAdmin
 * - ใช้ได้ทั้งกับ requireAuth (อ่านจาก req.auth.role) และ authenticateToken (อ่านจาก req.user.role)
 */
export const requireAdmin = (
  req: Request & { auth?: any; user?: any },
  res: Response,
  next: NextFunction
) => {
  const role: "PLAYER" | "ADMIN" | undefined = req.auth?.role ?? req.user?.role;
  if (role !== "ADMIN") {
    return res.status(403).json({ error: "Admin access required" });
  }
  return next();
};

// alias เดิมให้เข้ากัน
export const adminOnly = requireAdmin;

// ============================
// CORS Options
// ============================
export const corsOptions = {
  origin: function (origin: any, callback: any) {
    // อนุญาตคำขอที่ไม่มี origin (เช่น curl / mobile app)
    if (!origin) return callback(null, true);

    const allowedOrigins = [
      "http://localhost:3000",
      "http://localhost:3001",
      "http://127.0.0.1:3000",
      "http://172.20.10.6:3000",
      "http://172.20.10.6:3001",
      "http://45.32.115.120:3000",
      "http://45.32.115.120:3001",
      process.env.FRONTEND_URL,
    ].filter(Boolean) as string[];

    console.log(`CORS check - Origin: ${origin}, Allowed: ${allowedOrigins.includes(origin)}`);

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`CORS blocked: ${origin}`);
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
  allowedHeaders: ["Content-Type", "Authorization", "Cookie", "X-Requested-With"],
  exposedHeaders: ["set-cookie"],
  maxAge: 86400,
  preflightContinue: false,
  optionsSuccessStatus: 204,
};

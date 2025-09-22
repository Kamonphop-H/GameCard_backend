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

// Rate limiters
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  message: { error: "Too many authentication attempts" },
});

export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: "Too many requests" },
});

// Validation schemas
export const signUpSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(20)
    .regex(/^[a-zA-Z0-9_-]+$/),
  password: z
    .string()
    .min(8)
    .regex(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*#?&])/),
  preferredLang: z.enum(["th", "en"]).optional(),
});

export const signInSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1), // ลดความเข้มงวดสำหรับ signin
});

// Token utilities
export interface TokenPayload {
  uid: string;
  username: string;
  role: "PLAYER" | "ADMIN";
}

export const generateTokens = (payload: TokenPayload) => {
  const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: "15m" });
  const refreshToken = jwt.sign(payload, JWT_REFRESH_SECRET, { expiresIn: "7d" });
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
    return res.status(401).json({ error: "Authentication failed" });
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

// Fixed CORS options for development
export const corsOptions = {
  origin: function (origin: any, callback: any) {
    // Allow requests with no origin (like mobile apps or Postman)
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
  credentials: true, // สำคัญมาก! ต้องเป็น true เพื่อส่ง cookies
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Cookie"],
  exposedHeaders: ["set-cookie"],
};

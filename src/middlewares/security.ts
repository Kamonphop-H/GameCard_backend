/** @format */

// backend/src/middlewares/security.ts
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { Request, Response, NextFunction } from "express";
import { z } from "zod";

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      user?: {
        uid: string;
        email: string;
        role: "PLAYER" | "ADMIN";
      };
    }
  }
}

// Rate limiting configuration
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 requests
  message: "Too many authentication attempts, please try again later",
  standardHeaders: true,
  legacyHeaders: false,
});

export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: "Too many requests from this IP",
});

// JWT token generation
export interface TokenPayload {
  uid: string;
  email: string;
  role: "PLAYER" | "ADMIN";
}

export const generateTokens = (payload: TokenPayload) => {
  const accessToken = jwt.sign(payload, process.env.JWT_SECRET || "change_me", { expiresIn: "15m" });
  const refreshToken = jwt.sign(payload, process.env.JWT_REFRESH_SECRET || "change_me2", { expiresIn: "7d" });
  return { accessToken, refreshToken };
};

export const verifyAccessToken = (token: string): TokenPayload =>
  jwt.verify(token, process.env.JWT_SECRET || "change_me") as TokenPayload;

// Input validation middleware
export const validateInput = (schema: z.ZodSchema) => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      schema.parse(req.body);
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          error: "Invalid input",
          details: error.errors,
        });
      }
      return res.status(400).json({ error: "Invalid input" });
    }
  };
};

// CORS configuration
export const corsOptions = {
  origin: process.env.FRONTEND_URL || "http://localhost:3000",
  credentials: true,
  optionsSuccessStatus: 200,
};

// Security middleware setup
export const setupSecurity = (app: any) => {
  app.use(helmet());
  app.use("/api/auth", authLimiter);
  app.use("/api", apiLimiter);
};

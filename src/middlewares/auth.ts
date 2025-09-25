/** @format */
import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { prisma } from "../config/database";
import { JWT_SECRET, JWT_REFRESH_SECRET, ERROR_MESSAGES } from "../config/constants";

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        username: string;
        role: "PLAYER" | "ADMIN";
        lang: "th" | "en";
      };
    }
  }
}

// Token payload interface
export interface TokenPayload {
  userId: string;
  username: string;
  role: "PLAYER" | "ADMIN";
}

// Generate JWT tokens
export const generateTokens = (payload: TokenPayload) => {
  const accessToken = jwt.sign(payload, JWT_SECRET, {
    expiresIn: "15m",
  });

  const refreshToken = jwt.sign(payload, JWT_REFRESH_SECRET, {
    expiresIn: "7d",
  });

  return { accessToken, refreshToken };
};

// Verify tokens
export const verifyAccessToken = (token: string): TokenPayload => {
  return jwt.verify(token, JWT_SECRET) as TokenPayload;
};

export const verifyRefreshToken = (token: string): TokenPayload => {
  return jwt.verify(token, JWT_REFRESH_SECRET) as TokenPayload;
};

// Hash password
export const hashPassword = async (password: string): Promise<string> => {
  return bcrypt.hash(password, 12);
};

// Compare password
export const comparePassword = async (password: string, hash: string): Promise<boolean> => {
  return bcrypt.compare(password, hash);
};

// Authentication middleware
export const authenticateToken = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Get token from cookie or header
    const token = req.cookies?.auth_token || req.headers.authorization?.replace("Bearer ", "");

    if (!token) {
      return res.status(401).json({
        error: ERROR_MESSAGES.AUTH_REQUIRED,
      });
    }

    // Verify token
    const payload = verifyAccessToken(token);

    // Get user from database
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: {
        id: true,
        username: true,
        role: true,
        lang: true,
        isActive: true,
      },
    });

    if (!user || !user.isActive) {
      return res.status(401).json({
        error: ERROR_MESSAGES.USER_NOT_FOUND,
      });
    }

    // Attach user to request
    req.user = {
      id: user.id,
      username: user.username,
      role: user.role,
      lang: user.lang,
    };

    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return res.status(401).json({
        error: ERROR_MESSAGES.TOKEN_EXPIRED,
      });
    }

    if (error instanceof jwt.JsonWebTokenError) {
      return res.status(401).json({
        error: ERROR_MESSAGES.TOKEN_INVALID,
      });
    }

    return res.status(401).json({
      error: ERROR_MESSAGES.AUTH_REQUIRED,
    });
  }
};

// Admin only middleware
export const adminOnly = (req: Request, res: Response, next: NextFunction) => {
  if (!req.user || req.user.role !== "ADMIN") {
    return res.status(403).json({
      error: ERROR_MESSAGES.ADMIN_ONLY,
    });
  }
  next();
};

// Optional auth - doesn't fail if no token, but attaches user if valid
export const optionalAuth = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.cookies?.auth_token || req.headers.authorization?.replace("Bearer ", "");

    if (!token) {
      return next();
    }

    const payload = verifyAccessToken(token);

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: {
        id: true,
        username: true,
        role: true,
        lang: true,
        isActive: true,
      },
    });

    if (user && user.isActive) {
      req.user = {
        id: user.id,
        username: user.username,
        role: user.role,
        lang: user.lang,
      };
    }
  } catch {
    // Ignore errors for optional auth
  }

  next();
};

/** @format */

import { Router } from "express";
import { prisma } from "../prisma";
import {
  generateTokens,
  authLimiter,
  verifyAccessToken,
  verifyRefreshToken,
  hashPassword,
  comparePassword,
  sanitizeUser,
} from "../middlewares/security";
import { z } from "zod";

const router = Router();

// ⭐ แก้ไข: validation schema ที่เรียบง่ายและชัดเจน
const signUpSchema = z.object({
  username: z
    .string()
    .min(3, "ชื่อผู้ใช้ต้องมีอย่างน้อย 3 ตัวอักษร")
    .max(20, "ชื่อผู้ใช้ต้องไม่เกิน 20 ตัวอักษร")
    .regex(/^[a-zA-Z0-9_-]+$/, "ชื่อผู้ใช้ใช้ได้เฉพาะ a-z, A-Z, 0-9, _, -"),
  password: z.string().min(6, "รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร"),
  preferredLang: z.enum(["th", "en"]).optional().default("th"),
});

const signInSchema = z.object({
  username: z.string().min(1, "กรุณากรอกชื่อผู้ใช้"),
  password: z.string().min(1, "กรุณากรอกรหัสผ่าน"),
});

// ⭐ แก้ไข: middleware ที่ให้ error message ชัดเจน
const validateInput = (schema: z.ZodSchema) => {
  return (req: any, res: any, next: any) => {
    try {
      schema.parse(req.body);
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        const firstError = error.errors[0];
        return res.status(400).json({
          error: firstError.message,
          field: firstError.path.join("."),
        });
      }
      return res.status(400).json({ error: "ข้อมูลไม่ถูกต้อง" });
    }
  };
};

const cookieConfig = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: false,
  path: "/",
};

// ⭐ Sign up - ปรับปรุง
router.post("/signup", authLimiter, validateInput(signUpSchema), async (req, res) => {
  try {
    const { username, password, preferredLang } = req.body;

    const existing = await prisma.user.findUnique({ where: { username } });
    if (existing) {
      return res.status(409).json({
        error: "ชื่อผู้ใช้นี้ถูกใช้ไปแล้ว",
        field: "username",
      });
    }

    const passwordHash = await hashPassword(password);

    const user = await prisma.user.create({
      data: {
        username,
        passwordHash,
        preferredLang: preferredLang || "th",
        profile: { create: { displayName: username } },
      },
      include: { profile: true },
    });

    const { accessToken, refreshToken } = generateTokens({
      uid: user.id,
      username: user.username,
      role: user.role,
    });

    await prisma.session.create({
      data: {
        userId: user.id,
        token: refreshToken,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    res.cookie("auth_token", accessToken, { ...cookieConfig, maxAge: 15 * 60 * 1000 });
    res.cookie("refresh_token", refreshToken, { ...cookieConfig, maxAge: 7 * 24 * 60 * 60 * 1000 });

    return res.status(201).json({
      user: sanitizeUser(user),
      message: "สร้างบัญชีสำเร็จ! กำลังเข้าสู่ระบบ...",
    });
  } catch (error) {
    console.error("Signup error:", error);
    return res.status(500).json({ error: "เกิดข้อผิดพลาดในการสร้างบัญชี กรุณาลองใหม่" });
  }
});

// ⭐ Sign in - ปรับปรุง
router.post("/signin", authLimiter, validateInput(signInSchema), async (req, res) => {
  try {
    const { username, password } = req.body;

    const user = await prisma.user.findUnique({
      where: { username },
      include: { profile: true },
    });

    if (!user || !user.isActive) {
      return res.status(401).json({
        error: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง",
      });
    }

    const isValid = await comparePassword(password, user.passwordHash);

    if (!isValid) {
      return res.status(401).json({
        error: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง",
      });
    }

    const { accessToken, refreshToken } = generateTokens({
      uid: user.id,
      username: user.username,
      role: user.role,
    });

    await prisma.session.deleteMany({ where: { userId: user.id } });
    await prisma.session.create({
      data: {
        userId: user.id,
        token: refreshToken,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    res.cookie("auth_token", accessToken, { ...cookieConfig, maxAge: 15 * 60 * 1000 });
    res.cookie("refresh_token", refreshToken, { ...cookieConfig, maxAge: 7 * 24 * 60 * 60 * 1000 });

    return res.json({
      user: sanitizeUser(user),
      message: "เข้าสู่ระบบสำเร็จ",
    });
  } catch (error) {
    console.error("Signin error:", error);
    return res.status(500).json({ error: "เกิดข้อผิดพลาดในการเข้าสู่ระบบ" });
  }
});

// Token refresh
router.post("/refresh", async (req, res) => {
  try {
    const refreshToken = req.cookies?.refresh_token;
    if (!refreshToken) return res.status(401).json({ error: "Refresh token required" });

    const payload = verifyRefreshToken(refreshToken);

    const session = await prisma.session.findFirst({
      where: {
        token: refreshToken,
        expiresAt: { gt: new Date() },
      },
      include: {
        user: {
          include: { profile: true },
        },
      },
    });

    if (!session || !session.user.isActive) {
      return res.status(401).json({ error: "Invalid refresh token" });
    }

    const { accessToken, refreshToken: newRefreshToken } = generateTokens({
      uid: session.user.id,
      username: session.user.username,
      role: session.user.role,
    });

    await prisma.session.update({
      where: { id: session.id },
      data: {
        token: newRefreshToken,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    res.cookie("auth_token", accessToken, { ...cookieConfig, maxAge: 15 * 60 * 1000 });
    res.cookie("refresh_token", newRefreshToken, { ...cookieConfig, maxAge: 7 * 24 * 60 * 60 * 1000 });

    return res.json({
      user: sanitizeUser(session.user),
      message: "Token refreshed",
    });
  } catch (error) {
    console.error("Token refresh error:", error);
    return res.status(401).json({ error: "Token refresh failed" });
  }
});

// Logout
router.post("/logout", async (req, res) => {
  try {
    const refreshToken = req.cookies?.refresh_token;

    if (refreshToken) {
      await prisma.session.deleteMany({
        where: { token: refreshToken },
      });
    }

    res.clearCookie("auth_token", cookieConfig);
    res.clearCookie("refresh_token", cookieConfig);

    return res.json({ message: "ออกจากระบบสำเร็จ" });
  } catch (error) {
    res.clearCookie("auth_token");
    res.clearCookie("refresh_token");
    return res.json({ message: "ออกจากระบบสำเร็จ" });
  }
});

// Get current user
router.get("/me", async (req, res) => {
  try {
    const token = req.cookies?.auth_token;

    if (!token) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const payload = verifyAccessToken(token);

    const user = await prisma.user.findUnique({
      where: { id: payload.uid },
      include: { profile: true },
    });

    if (!user?.isActive) {
      return res.status(401).json({ error: "User not found" });
    }

    return res.json({ user: sanitizeUser(user) });
  } catch (error) {
    console.error("/me error:", error);
    return res.status(401).json({ error: "Authentication failed" });
  }
});

export default router;

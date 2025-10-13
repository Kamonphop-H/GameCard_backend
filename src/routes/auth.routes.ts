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
  requireAuth, // ⭐ เปลี่ยนจาก authenticateToken เป็น requireAuth
} from "../middlewares/security";
import { z } from "zod";
import QRCode from "qrcode";
import { nanoid } from "nanoid";

const router = Router();

const signUpSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(20)
    .regex(/^[a-zA-Z0-9_-]+$/),
  password: z.string().min(6),
  preferredLang: z.enum(["th", "en"]).optional().default("th"),
});

const signInSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

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
  maxAge: 365 * 24 * 60 * 60 * 1000,
};

// ===== Sign Up =====
router.post("/signup", authLimiter, validateInput(signUpSchema), async (req, res) => {
  try {
    const { username, password, preferredLang } = req.body;

    const existing = await prisma.user.findUnique({ where: { username } });
    if (existing) {
      return res.status(409).json({ error: "ชื่อผู้ใช้นี้ถูกใช้ไปแล้ว", field: "username" });
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
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      },
    });

    res.cookie("auth_token", accessToken, cookieConfig);
    res.cookie("refresh_token", refreshToken, cookieConfig);

    return res.status(201).json({
      user: sanitizeUser(user),
      message: "สร้างบัญชีสำเร็จ! กำลังเข้าสู่ระบบ...",
    });
  } catch (error) {
    console.error("Signup error:", error);
    return res.status(500).json({ error: "เกิดข้อผิดพลาดในการสร้างบัญชี กรุณาลองใหม่" });
  }
});

// ===== Sign In =====
router.post("/signin", authLimiter, validateInput(signInSchema), async (req, res) => {
  try {
    const { username, password } = req.body;

    const user = await prisma.user.findUnique({
      where: { username },
      include: { profile: true },
    });

    if (!user || !user.isActive) {
      return res.status(401).json({ error: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" });
    }

    const isValid = await comparePassword(password, user.passwordHash);

    if (!isValid) {
      return res.status(401).json({ error: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" });
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
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      },
    });

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    res.cookie("auth_token", accessToken, cookieConfig);
    res.cookie("refresh_token", refreshToken, cookieConfig);

    return res.json({
      user: sanitizeUser(user),
      message: "เข้าสู่ระบบสำเร็จ",
    });
  } catch (error) {
    console.error("Signin error:", error);
    return res.status(500).json({ error: "เกิดข้อผิดพลาดในการเข้าสู่ระบบ" });
  }
});

// ===== 🆕 QR Code Login - Generate Token =====
router.post("/qr/generate", requireAuth, async (req, res) => {
  try {
    console.log("QR Generate - Auth data:", req.auth); // ⭐ Debug log

    const userId = req.auth!.userId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { username: true },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // สร้าง QR Token (มีอายุ 1 ปี)
    const qrToken = nanoid(32);
    const qrData = JSON.stringify({
      token: qrToken,
      username: user.username,
      timestamp: Date.now(),
    });

    // บันทึก QR Token
    await prisma.session.create({
      data: {
        userId,
        token: qrToken,
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      },
    });

    // สร้าง QR Code
    const qrCodeUrl = await QRCode.toDataURL(qrData, {
      errorCorrectionLevel: "M",
      width: 300,
    });

    console.log("QR Code generated successfully for:", user.username); // ⭐ Success log

    res.json({
      qrCode: qrCodeUrl,
      qrToken,
      username: user.username,
    });
  } catch (error) {
    console.error("QR generate error:", error);
    res.status(500).json({ error: "Failed to generate QR code" });
  }
});

// ===== 🆕 QR Code Login - Verify & Auto Login =====
router.post("/qr/login", authLimiter, async (req, res) => {
  try {
    const { qrData } = req.body;

    if (!qrData) {
      return res.status(400).json({ error: "QR data required" });
    }

    let parsed;
    try {
      parsed = JSON.parse(qrData);
    } catch {
      return res.status(400).json({ error: "Invalid QR code" });
    }

    const { token, username } = parsed;

    const session = await prisma.session.findFirst({
      where: {
        token,
        expiresAt: { gt: new Date() },
      },
      include: {
        user: {
          include: { profile: true },
        },
      },
    });

    if (!session || !session.user.isActive) {
      return res.status(401).json({ error: "Invalid or expired QR code" });
    }

    if (session.user.username !== username) {
      return res.status(401).json({ error: "QR code mismatch" });
    }

    const { accessToken, refreshToken } = generateTokens({
      uid: session.user.id,
      username: session.user.username,
      role: session.user.role,
    });

    await prisma.session.deleteMany({ where: { userId: session.user.id } });
    await prisma.session.create({
      data: {
        userId: session.user.id,
        token: refreshToken,
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      },
    });

    await prisma.user.update({
      where: { id: session.user.id },
      data: { lastLoginAt: new Date() },
    });

    res.cookie("auth_token", accessToken, cookieConfig);
    res.cookie("refresh_token", refreshToken, cookieConfig);

    return res.json({
      user: sanitizeUser(session.user),
      message: "เข้าสู่ระบบด้วย QR Code สำเร็จ",
    });
  } catch (error) {
    console.error("QR login error:", error);
    return res.status(500).json({ error: "QR login failed" });
  }
});

// ===== 🆕 Anonymous Login =====
router.post("/anonymous", authLimiter, async (req, res) => {
  try {
    const { preferredLang = "th" } = req.body;

    const anonymousId = `anon_${nanoid(16)}`;

    const { accessToken } = generateTokens({
      uid: anonymousId,
      username: "Anonymous",
      role: "PLAYER",
    });

    res.cookie("auth_token", accessToken, {
      ...cookieConfig,
      maxAge: 24 * 60 * 60 * 1000,
    });

    return res.json({
      user: {
        id: anonymousId,
        username: "Anonymous",
        role: "PLAYER",
        preferredLang,
        isAnonymous: true,
      },
      message: "เข้าสู่ระบบแบบไม่ระบุตัวตนสำเร็จ (ข้อมูลจะไม่ถูกบันทึก)",
    });
  } catch (error) {
    console.error("Anonymous login error:", error);
    return res.status(500).json({ error: "Anonymous login failed" });
  }
});

// ===== Token Refresh =====
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
      include: { user: { include: { profile: true } } },
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
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      },
    });

    res.cookie("auth_token", accessToken, cookieConfig);
    res.cookie("refresh_token", newRefreshToken, cookieConfig);

    return res.json({
      user: sanitizeUser(session.user),
      message: "Token refreshed",
    });
  } catch (error) {
    console.error("Token refresh error:", error);
    return res.status(401).json({ error: "Token refresh failed" });
  }
});

// ===== Logout =====
router.post("/logout", async (req, res) => {
  try {
    const refreshToken = req.cookies?.refresh_token;

    if (refreshToken) {
      await prisma.session.deleteMany({ where: { token: refreshToken } });
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

// ===== Get Current User =====
router.get("/me", async (req, res) => {
  try {
    const token = req.cookies?.auth_token;

    if (!token) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const payload = verifyAccessToken(token);

    if (payload.uid.startsWith("anon_")) {
      return res.json({
        user: {
          id: payload.uid,
          username: "Anonymous",
          role: "PLAYER",
          preferredLang: "th",
          isAnonymous: true,
        },
      });
    }

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

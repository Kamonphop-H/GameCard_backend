/** @format */

import { Router } from "express";
import { prisma } from "../prisma";
import {
  generateTokens,
  authLimiter,
  verifyAccessToken,
  meRouteLimiter,
  verifyRefreshToken,
  hashPassword,
  comparePassword,
  sanitizeUser,
} from "../middlewares/security";
import { z } from "zod";
import QRCode from "qrcode";
import { nanoid } from "nanoid";
import firebaseService from "../services/firebaseService";

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
  secure: false, // ตั้งเป็น false สำหรับ HTTP, true สำหรับ HTTPS
  path: "/",
  maxAge: 365 * 24 * 60 * 60 * 1000,
  domain: undefined, // ไม่ระบุ domain เพื่อให้ใช้ได้กับทุก domain
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

    await prisma.session.deleteMany({
      where: {
        userId: user.id,
        token: { not: { startsWith: "qr_" } },
      },
    });

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

// ===== Get Current User (/me) - Single Endpoint =====
router.get("/me", meRouteLimiter, async (req, res) => {
  try {
    const token = req.cookies?.auth_token || req.headers.authorization?.replace("Bearer ", "");

    if (!token) {
      return res.status(401).json({
        error: "Authentication required",
        shouldLogout: false,
      });
    }

    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch (error: any) {
      console.error("/me token verification failed:", error.message);

      // Token expired - suggest refresh
      if (error.name === "TokenExpiredError") {
        return res.status(401).json({
          error: "Token expired",
          shouldLogout: false,
          shouldRefresh: true,
        });
      }

      // Invalid token
      return res.status(401).json({
        error: "Invalid token",
        shouldLogout: true,
      });
    }

    // Handle anonymous users
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

    // Get user from database
    const user = await prisma.user.findUnique({
      where: { id: payload.uid },
      include: { profile: true },
    });

    if (!user) {
      return res.status(401).json({
        error: "User not found",
        shouldLogout: true,
      });
    }

    if (!user.isActive) {
      return res.status(401).json({
        error: "User account is deactivated",
        shouldLogout: true,
      });
    }

    return res.json({
      user: sanitizeUser(user),
    });
  } catch (error) {
    console.error("/me error:", error);
    return res.status(500).json({
      error: "Authentication failed",
      shouldLogout: false,
    });
  }
});

// ===== Token Refresh Endpoint =====
router.post("/refresh", async (req, res) => {
  try {
    const refreshToken = req.cookies?.refresh_token;

    if (!refreshToken) {
      return res.status(401).json({
        error: "Refresh token required",
        shouldLogout: true,
      });
    }

    let payload;
    try {
      payload = verifyRefreshToken(refreshToken);
    } catch (error: any) {
      console.error("Refresh token verification failed:", error.message);

      res.clearCookie("auth_token");
      res.clearCookie("refresh_token");

      return res.status(401).json({
        error: "Refresh token expired",
        shouldLogout: true,
      });
    }

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
      res.clearCookie("auth_token");
      res.clearCookie("refresh_token");

      return res.status(401).json({
        error: "Invalid session",
        shouldLogout: true,
      });
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
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      },
    });

    res.cookie("auth_token", accessToken, cookieConfig);
    res.cookie("refresh_token", newRefreshToken, cookieConfig);

    console.log(`✅ Token refreshed for user: ${session.user.username}`);

    return res.json({
      message: "Token refreshed successfully",
      user: sanitizeUser(session.user),
    });
  } catch (error) {
    console.error("Token refresh error:", error);
    return res.status(401).json({
      error: "Token refresh failed",
      shouldLogout: true,
    });
  }
});

// ===== QR Code Login - Generate Token =====
router.post("/qr/generate", async (req, res) => {
  try {
    // First authenticate the user using the same logic as /me
    const token = req.cookies?.auth_token || req.headers.authorization?.replace("Bearer ", "");

    if (!token) {
      return res.status(401).json({ error: "Authentication required" });
    }

    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch (error) {
      return res.status(401).json({ error: "Invalid token" });
    }

    const userId = payload.uid;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { username: true },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const existingQrToken = await prisma.session.findFirst({
      where: {
        userId,
        token: { startsWith: "qr_" },
        expiresAt: { gt: new Date() },
      },
    });

    let qrToken: string;

    if (existingQrToken) {
      qrToken = existingQrToken.token.replace("qr_", "");
      console.log("Using existing QR token for:", user.username);
    } else {
      qrToken = nanoid(32);

      await prisma.session.create({
        data: {
          userId,
          token: `qr_${qrToken}`,
          expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        },
      });

      console.log("New QR token created for:", user.username);
    }

    const qrData = JSON.stringify({
      token: qrToken,
      username: user.username,
      timestamp: Date.now(),
    });

    const qrCodeUrl = await QRCode.toDataURL(qrData, {
      errorCorrectionLevel: "M",
      width: 300,
    });

    res.json({
      qrCode: qrCodeUrl,
      qrToken,
      username: user.username,
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    });
  } catch (error) {
    console.error("QR generate error:", error);
    res.status(500).json({ error: "Failed to generate QR code" });
  }
});

// ===== QR Code Login - Verify & Auto Login =====
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
        token: `qr_${token}`,
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

    await prisma.session.deleteMany({
      where: {
        userId: session.user.id,
        token: { not: { startsWith: "qr_" } },
      },
    });

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

// ===== Revoke QR Token =====
router.post("/qr/revoke", async (req, res) => {
  try {
    const token = req.cookies?.auth_token || req.headers.authorization?.replace("Bearer ", "");

    if (!token) {
      return res.status(401).json({ error: "Authentication required" });
    }

    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch (error) {
      return res.status(401).json({ error: "Invalid token" });
    }

    const userId = payload.uid;

    const result = await prisma.session.deleteMany({
      where: {
        userId,
        token: { startsWith: "qr_" },
      },
    });

    res.json({
      message: "QR token revoked successfully",
      deletedCount: result.count,
    });
  } catch (error) {
    console.error("QR revoke error:", error);
    res.status(500).json({ error: "Failed to revoke QR token" });
  }
});

// ===== Get Active QR Token =====
router.get("/qr/active", async (req, res) => {
  try {
    const token = req.cookies?.auth_token || req.headers.authorization?.replace("Bearer ", "");

    if (!token) {
      return res.status(401).json({ error: "Authentication required" });
    }

    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch (error) {
      return res.status(401).json({ error: "Invalid token" });
    }

    const userId = payload.uid;

    const activeQrToken = await prisma.session.findFirst({
      where: {
        userId,
        token: { startsWith: "qr_" },
        expiresAt: { gt: new Date() },
      },
      select: {
        token: true,
        expiresAt: true,
        createdAt: true,
      },
    });

    if (!activeQrToken) {
      return res.json({ hasActiveToken: false });
    }

    res.json({
      hasActiveToken: true,
      createdAt: activeQrToken.createdAt,
      expiresAt: activeQrToken.expiresAt,
    });
  } catch (error) {
    console.error("Get active QR token error:", error);
    res.status(500).json({ error: "Failed to get active QR token" });
  }
});

// ===== Anonymous Login =====
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

// ===== Google Sign-In =====
router.post("/google", authLimiter, async (req, res) => {
  try {
    const { idToken, preferredLang = "th" } = req.body;

    if (!idToken) {
      return res.status(400).json({ error: "ID token required" });
    }

    if (!firebaseService.isInitialized()) {
      return res.status(503).json({
        error: "Google Sign-In is not available",
        message: "Firebase service is not configured",
      });
    }

    const decodedToken = await firebaseService.verifyIdToken(idToken);

    if (!decodedToken) {
      return res.status(401).json({ error: "Invalid ID token" });
    }

    const { uid: firebaseUid, email, name, picture, email_verified } = decodedToken;

    if (!email_verified) {
      return res.status(401).json({
        error: "Email not verified",
        message: "กรุณายืนยันอีเมลก่อนเข้าสู่ระบบ",
      });
    }

    let user = await prisma.user.findFirst({
      where: {
        OR: [{ username: email }, { username: `google_${firebaseUid}` }],
      },
      include: { profile: true },
    });

    if (user) {
      // User exists - Sign In
      if (!user.isActive) {
        return res.status(401).json({
          error: "Account is deactivated",
          message: "บัญชีของคุณถูกระงับการใช้งาน",
        });
      }

      if (user.profile && (user.profile.avatar !== picture || user.profile.displayName !== name)) {
        await prisma.profile.update({
          where: { userId: user.id },
          data: {
            displayName: name || user.profile.displayName,
            avatar: picture || user.profile.avatar,
          },
        });
      }

      await prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });

      user = (await prisma.user.findUnique({
        where: { id: user.id },
        include: { profile: true },
      })) as any;
    } else {
      // New user - Sign Up
      let username = email?.split("@")[0] || `user_${firebaseUid.substring(0, 8)}`;

      const existingUsername = await prisma.user.findUnique({
        where: { username },
      });

      if (existingUsername) {
        username = `${username}_${Date.now().toString().slice(-4)}`;
      }

      user = await prisma.user.create({
        data: {
          username,
          passwordHash: "",
          role: "PLAYER",
          preferredLang: preferredLang as "th" | "en",
          isActive: true,
          profile: {
            create: {
              displayName: name || username,
              avatar: picture || null,
            },
          },
        },
        include: { profile: true },
      });

      console.log(`✅ New user created via Google: ${username}`);
    }

    const { accessToken, refreshToken } = generateTokens({
      uid: user.id,
      username: user.username,
      role: user.role,
    });

    await prisma.session.deleteMany({
      where: {
        userId: user.id,
        token: { not: { startsWith: "qr_" } },
      },
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

    return res.json({
      user: sanitizeUser(user),
      message: "เข้าสู่ระบบด้วย Google สำเร็จ",
      isNewUser: !user.lastLoginAt,
    });
  } catch (error) {
    console.error("Google sign-in error:", error);
    return res.status(500).json({
      error: "Google sign-in failed",
      message: "เกิดข้อผิดพลาดในการเข้าสู่ระบบด้วย Google",
    });
  }
});

// ===== Link Google Account =====
router.post("/google/link", async (req, res) => {
  try {
    const { idToken } = req.body;
    const token = req.cookies?.auth_token || req.headers.authorization?.replace("Bearer ", "");

    if (!token) {
      return res.status(401).json({ error: "Authentication required" });
    }

    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch (error) {
      return res.status(401).json({ error: "Invalid token" });
    }

    const userId = payload.uid;

    if (!idToken) {
      return res.status(400).json({ error: "ID token required" });
    }

    if (!firebaseService.isInitialized()) {
      return res.status(503).json({ error: "Firebase service not available" });
    }

    const decodedToken = await firebaseService.verifyIdToken(idToken);
    if (!decodedToken) {
      return res.status(401).json({ error: "Invalid ID token" });
    }

    const { email, name, picture } = decodedToken;

    const existingLink = await prisma.user.findFirst({
      where: {
        username: email,
        id: { not: userId },
      },
    });

    if (existingLink) {
      return res.status(409).json({
        error: "Google account already linked to another user",
        message: "บัญชี Google นี้ถูกเชื่อมกับผู้ใช้อื่นแล้ว",
      });
    }

    await prisma.profile.update({
      where: { userId },
      data: {
        displayName: name || undefined,
        avatar: picture || undefined,
      },
    });

    return res.json({
      message: "เชื่อมต่อบัญชี Google สำเร็จ",
      profile: {
        displayName: name,
        avatar: picture,
      },
    });
  } catch (error) {
    console.error("Link Google account error:", error);
    return res.status(500).json({ error: "Failed to link Google account" });
  }
});

// ===== Unlink Google Account =====
router.post("/google/unlink", async (req, res) => {
  try {
    const token = req.cookies?.auth_token || req.headers.authorization?.replace("Bearer ", "");

    if (!token) {
      return res.status(401).json({ error: "Authentication required" });
    }

    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch (error) {
      return res.status(401).json({ error: "Invalid token" });
    }

    const userId = payload.uid;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    });

    if (!user?.passwordHash || user.passwordHash === "") {
      return res.status(400).json({
        error: "Cannot unlink Google account",
        message: "กรุณาตั้งรหัสผ่านก่อนยกเลิกการเชื่อมต่อบัญชี Google",
      });
    }

    return res.json({
      message: "ยกเลิกการเชื่อมต่อบัญชี Google สำเร็จ",
    });
  } catch (error) {
    console.error("Unlink Google account error:", error);
    return res.status(500).json({ error: "Failed to unlink Google account" });
  }
});

// ===== Logout =====
router.post("/logout", async (req, res) => {
  try {
    const refreshToken = req.cookies?.refresh_token;

    if (refreshToken) {
      await prisma.session.deleteMany({
        where: {
          token: refreshToken,
        },
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

export default router;

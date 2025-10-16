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
  requireAuth, // ⭐ เปลี่ยนจาก authenticateToken เป็น requireAuth
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

    // ⭐ ลบเฉพาะ refresh token เก่า (ไม่ลบ QR token)
    await prisma.session.deleteMany({
      where: {
        userId: user.id,
        token: { not: { startsWith: "qr_" } }, // ⭐ ไม่ลบ QR token
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

// ===== 🆕 QR Code Login - Generate Token =====
router.post("/qr/generate", requireAuth, async (req, res) => {
  try {
    console.log("QR Generate - Auth data:", req.auth);

    const userId = req.auth!.userId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { username: true },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // ⭐ ตรวจสอบว่ามี QR Token อยู่แล้วหรือไม่
    const existingQrToken = await prisma.session.findFirst({
      where: {
        userId,
        token: { startsWith: "qr_" }, // ใช้ prefix เพื่อแยก QR Token
        expiresAt: { gt: new Date() },
      },
    });

    let qrToken: string;

    if (existingQrToken) {
      // ใช้ QR Token เดิม
      qrToken = existingQrToken.token.replace("qr_", "");
      console.log("Using existing QR token for:", user.username);
    } else {
      // สร้าง QR Token ใหม่ (มีอายุ 1 ปี)
      qrToken = nanoid(32);

      // บันทึก QR Token โดยใช้ prefix "qr_" เพื่อแยกจาก refresh token
      await prisma.session.create({
        data: {
          userId,
          token: `qr_${qrToken}`, // ⭐ เพิ่ม prefix
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

    // สร้าง QR Code
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

    // ⭐ หา QR Token (ใช้ prefix "qr_")
    const session = await prisma.session.findFirst({
      where: {
        token: `qr_${token}`, // ⭐ ใช้ prefix
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

    // สร้าง access token และ refresh token ใหม่
    const { accessToken, refreshToken } = generateTokens({
      uid: session.user.id,
      username: session.user.username,
      role: session.user.role,
    });

    // ⭐ ลบเฉพาะ refresh token เก่า (ไม่ลบ QR token)
    await prisma.session.deleteMany({
      where: {
        userId: session.user.id,
        token: { not: { startsWith: "qr_" } }, // ⭐ ไม่ลบ QR token
      },
    });

    // บันทึก refresh token ใหม่
    await prisma.session.create({
      data: {
        userId: session.user.id,
        token: refreshToken,
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      },
    });

    // อัพเดท lastLoginAt
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

router.post("/qr/revoke", requireAuth, async (req, res) => {
  try {
    const userId = req.auth!.userId;

    // ลบ QR Token ทั้งหมดของผู้ใช้
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

// ===== 🆕 Get Active QR Token =====
router.get("/qr/active", requireAuth, async (req, res) => {
  try {
    const userId = req.auth!.userId;

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

    // Verify refresh token
    let payload;
    try {
      payload = verifyRefreshToken(refreshToken);
    } catch (error: any) {
      console.error("Refresh token verification failed:", error.message);

      // ล้าง cookies ที่หมดอายุ
      res.clearCookie("auth_token");
      res.clearCookie("refresh_token");

      return res.status(401).json({
        error: "Refresh token expired",
        shouldLogout: true,
      });
    }

    // Check session in database
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

    // Generate new tokens
    const { accessToken, refreshToken: newRefreshToken } = generateTokens({
      uid: session.user.id,
      username: session.user.username,
      role: session.user.role,
    });

    // Update session
    await prisma.session.update({
      where: { id: session.id },
      data: {
        token: newRefreshToken,
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), // 90 days
      },
    });

    // Set new cookies
    const cookieConfig = {
      httpOnly: true,
      sameSite: "lax" as const,
      secure: false,
      path: "/",
      maxAge: 90 * 24 * 60 * 60 * 1000, // 90 days
    };

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

// ===== Update /me Endpoint =====
router.get("/me", meRouteLimiter, async (req, res) => {
  try {
    const token = req.cookies?.auth_token;

    if (!token) {
      return res.status(401).json({
        error: "Authentication required",
        shouldLogout: false, // ยังไม่ต้อง logout
      });
    }

    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch (error: any) {
      console.error("/me token verification failed:", error.message);

      // ⭐ ถ้า token หมดอายุ บอกให้ refresh
      if (error.name === "TokenExpiredError") {
        return res.status(401).json({
          error: "Token expired",
          shouldLogout: false,
          shouldRefresh: true, // ⭐ บอกให้ client ลอง refresh
        });
      }

      // Token invalid
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

    if (!user || !user.isActive) {
      return res.status(401).json({
        error: "User not found or inactive",
        shouldLogout: true,
      });
    }

    return res.json({
      user: sanitizeUser(user),
    });
  } catch (error) {
    console.error("/me error:", error);
    return res.status(401).json({
      error: "Authentication failed",
      shouldLogout: true,
    });
  }
});

// ===== Logout =====
router.post("/logout", async (req, res) => {
  try {
    const refreshToken = req.cookies?.refresh_token;

    if (refreshToken) {
      // ⭐ ลบเฉพาะ refresh token ที่ใช้ logout (ไม่ลบ QR token)
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

// ===== Get Current User =====
router.get("/me", meRouteLimiter, async (req, res) => {
  try {
    const token = req.cookies?.auth_token;

    if (!token) {
      return res.status(401).json({
        error: "Authentication required",
        shouldLogout: false, // ⭐ ยังไม่ต้อง logout อาจมี refresh token
      });
    }

    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch (error: any) {
      console.error("/me token verification failed:", error.message);

      // ⭐ ถ้า access token หมดอายุ บอกให้ refresh
      if (error.name === "TokenExpiredError") {
        return res.status(401).json({
          error: "Token expired",
          shouldLogout: false,
          shouldRefresh: true, // ⭐ บอก frontend ให้ลอง refresh
        });
      }

      // ⭐ ถ้า token ไม่ valid ให้ logout
      return res.status(401).json({
        error: "Invalid token",
        shouldLogout: true,
      });
    }

    // ⭐ Handle anonymous users
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

    // ⭐ Get user from database
    const user = await prisma.user.findUnique({
      where: { id: payload.uid },
      include: { profile: true },
    });

    if (!user || !user.isActive) {
      return res.status(401).json({
        error: "User not found or inactive",
        shouldLogout: true, // ⭐ User ไม่มีจริงๆ ให้ logout
      });
    }

    return res.json({
      user: sanitizeUser(user),
    });
  } catch (error) {
    console.error("/me error:", error);
    return res.status(401).json({
      error: "Authentication failed",
      shouldLogout: true,
    });
  }
});

router.post("/google", authLimiter, async (req, res) => {
  try {
    const { idToken, preferredLang = "th" } = req.body;

    if (!idToken) {
      return res.status(400).json({ error: "ID token required" });
    }

    // ตรวจสอบว่า Firebase ถูก initialize หรือไม่
    if (!firebaseService.isInitialized()) {
      return res.status(503).json({
        error: "Google Sign-In is not available",
        message: "Firebase service is not configured",
      });
    }

    // Verify Firebase ID Token
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

    // ตรวจสอบว่ามี user ในระบบหรือไม่ (ใช้ email เป็น unique identifier)
    let user = await prisma.user.findFirst({
      where: {
        OR: [
          { username: email }, // ใช้ email เป็น username
          { username: `google_${firebaseUid}` }, // หรือใช้ firebase UID
        ],
      },
      include: { profile: true },
    });

    if (user) {
      // ===== User มีอยู่แล้ว - Sign In =====

      // ตรวจสอบว่า user ยัง active อยู่หรือไม่
      if (!user.isActive) {
        return res.status(401).json({
          error: "Account is deactivated",
          message: "บัญชีของคุณถูกระงับการใช้งาน",
        });
      }

      // อัพเดทข้อมูลจาก Google (ถ้ามีการเปลี่ยนแปลง)
      if (user.profile && (user.profile.avatar !== picture || user.profile.displayName !== name)) {
        await prisma.profile.update({
          where: { userId: user.id },
          data: {
            displayName: name || user.profile.displayName,
            avatar: picture || user.profile.avatar,
          },
        });
      }

      // อัพเดท lastLoginAt
      await prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });

      // Refresh user data
      user = (await prisma.user.findUnique({
        where: { id: user.id },
        include: { profile: true },
      })) as any;
    } else {
      // ===== User ยังไม่มี - Sign Up =====

      // สร้าง username จาก email หรือ name
      let username = email?.split("@")[0] || `user_${firebaseUid.substring(0, 8)}`;

      // ตรวจสอบว่า username ซ้ำหรือไม่
      const existingUsername = await prisma.user.findUnique({
        where: { username },
      });

      if (existingUsername) {
        // ถ้า username ซ้ำ ให้เพิ่ม suffix
        username = `${username}_${Date.now().toString().slice(-4)}`;
      }

      // สร้าง user ใหม่
      user = await prisma.user.create({
        data: {
          username,
          passwordHash: "", // ไม่มี password สำหรับ Google Sign-In
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

    // สร้าง JWT tokens
    const { accessToken, refreshToken } = generateTokens({
      uid: user.id,
      username: user.username,
      role: user.role,
    });

    // ลบ refresh token เก่า (ไม่ลบ QR token)
    await prisma.session.deleteMany({
      where: {
        userId: user.id,
        token: { not: { startsWith: "qr_" } },
      },
    });

    // บันทึก refresh token ใหม่
    await prisma.session.create({
      data: {
        userId: user.id,
        token: refreshToken,
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      },
    });

    // Set cookies
    res.cookie("auth_token", accessToken, cookieConfig);
    res.cookie("refresh_token", refreshToken, cookieConfig);

    return res.json({
      user: sanitizeUser(user),
      message: "เข้าสู่ระบบด้วย Google สำเร็จ",
      isNewUser: !user.lastLoginAt, // ถ้าไม่มี lastLoginAt แสดงว่าเป็น user ใหม่
    });
  } catch (error) {
    console.error("Google sign-in error:", error);
    return res.status(500).json({
      error: "Google sign-in failed",
      message: "เกิดข้อผิดพลาดในการเข้าสู่ระบบด้วย Google",
    });
  }
});

// ===== 🔥 Link Google Account (สำหรับ user ที่มีอยู่แล้ว) =====
router.post("/google/link", requireAuth, async (req, res) => {
  try {
    const { idToken } = req.body;
    const userId = req.auth!.userId;

    if (!idToken) {
      return res.status(400).json({ error: "ID token required" });
    }

    if (!firebaseService.isInitialized()) {
      return res.status(503).json({ error: "Firebase service not available" });
    }

    // Verify token
    const decodedToken = await firebaseService.verifyIdToken(idToken);
    if (!decodedToken) {
      return res.status(401).json({ error: "Invalid ID token" });
    }

    const { email, name, picture } = decodedToken;

    // ตรวจสอบว่า Google account นี้ยังไม่ได้ link กับ user คนอื่น
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

    // อัพเดทข้อมูล profile
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

// ===== 🔥 Unlink Google Account =====
router.post("/google/unlink", requireAuth, async (req, res) => {
  try {
    const userId = req.auth!.userId;

    // ตรวจสอบว่า user มี password หรือไม่
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

    // ในกรณีนี้เราไม่ได้เก็บ Firebase UID ไว้แยก
    // แต่สามารถเพิ่มฟีเจอร์นี้ได้ถ้าต้องการ

    return res.json({
      message: "ยกเลิกการเชื่อมต่อบัญชี Google สำเร็จ",
    });
  } catch (error) {
    console.error("Unlink Google account error:", error);
    return res.status(500).json({ error: "Failed to unlink Google account" });
  }
});

export default router;

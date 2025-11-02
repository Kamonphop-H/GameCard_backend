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

// ✅ ผ่อนคลายเงื่อนไข - รับได้ทุกอักขระ แค่ไม่ซ้ำ
const signUpSchema = z.object({
  username: z.string().min(1, "กรุณากรอกชื่อผู้ใช้").max(50, "ชื่อผู้ใช้ยาวเกินไป"),
  password: z.string().min(8, "รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร"),
  preferredLang: z.enum(["th", "en"]).optional().default("th"),
});

const signInSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

// 🔥 FIXED: เพิ่ม error handling ที่ถูกต้อง
const validateInput = (schema: z.ZodSchema) => {
  return (req: any, res: any, next: any) => {
    try {
      schema.parse(req.body);
      next();
    } catch (error) {
      console.error("❌ Validation error:", error);
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
  domain: undefined,
};

// ===== Sign Up =====
router.post("/signup", authLimiter, validateInput(signUpSchema), async (req: any, res: any) => {
  try {
    const { username, password, preferredLang = "th" } = req.body;

    // ตรวจสอบว่า username ซ้ำหรือไม่
    const existingUser = await prisma.user.findUnique({
      where: { username },
    });

    if (existingUser) {
      return res.status(400).json({ error: "ชื่อผู้ใช้นี้ถูกใช้งานแล้ว" });
    }

    // สร้าง user ใหม่ (ID จะถูกสร้างอัตโนมัติโดย Prisma - unique ไม่ซ้ำ)
    const passwordHash = await hashPassword(password);
    const user = await prisma.user.create({
      data: {
        username,
        passwordHash,
        role: "PLAYER",
        preferredLang,
        isActive: true,
      },
    });

    // สร้าง profile
    await prisma.profile.create({
      data: {
        userId: user.id,
        displayName: username,
        totalScore: 0,
        gamesPlayed: 0,
        healthMastery: 0,
        cognitionMastery: 0,
        digitalMastery: 0,
        financeMastery: 0,
      },
    });

    // สร้าง tokens
    const { accessToken, refreshToken } = generateTokens({
      uid: user.id,
      username: user.username,
      role: user.role,
    });

    // ตั้งค่า cookie
    res.cookie("auth_token", accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      maxAge: 24 * 60 * 60 * 1000,
    });

    res.cookie("refresh_token", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });

    console.log("✅ User registered:", username);

    res.status(201).json({
      user: sanitizeUser(user),
      accessToken,
      refreshToken,
    });
  } catch (error) {
    console.error("❌ Signup error:", error);
    res.status(500).json({ error: "ไม่สามารถสร้างบัญชีได้" });
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

// ===== Get Current User (/me) =====
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

      if (error.name === "TokenExpiredError") {
        return res.status(401).json({
          error: "Token expired",
          shouldLogout: false,
          shouldRefresh: true,
        });
      }

      return res.status(401).json({
        error: "Invalid token",
        shouldLogout: true,
      });
    }

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

// ===== Token Refresh =====
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

    if (payload.uid.startsWith("anon_")) {
      const { accessToken: newAccessToken } = generateTokens({
        uid: payload.uid,
        username: "Anonymous",
        role: "PLAYER",
      });

      res.cookie("auth_token", newAccessToken, cookieConfig);

      return res.json({
        message: "Token refreshed",
        user: {
          id: payload.uid,
          username: "Anonymous",
          role: "PLAYER",
          isAnonymous: true,
        },
      });
    }

    const session = await prisma.session.findFirst({
      where: {
        token: refreshToken,
        userId: payload.uid,
        expiresAt: { gt: new Date() },
      },
    });

    if (!session) {
      res.clearCookie("auth_token");
      res.clearCookie("refresh_token");

      return res.status(401).json({
        error: "Invalid or expired session",
        shouldLogout: true,
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.uid },
      include: { profile: true },
    });

    if (!user || !user.isActive) {
      res.clearCookie("auth_token");
      res.clearCookie("refresh_token");

      return res.status(401).json({
        error: "User not found or inactive",
        shouldLogout: true,
      });
    }

    const { accessToken: newAccessToken } = generateTokens({
      uid: user.id,
      username: user.username,
      role: user.role,
    });

    res.cookie("auth_token", newAccessToken, cookieConfig);

    return res.json({
      message: "Token refreshed successfully",
      user: sanitizeUser(user),
    });
  } catch (error) {
    console.error("Token refresh error:", error);

    res.clearCookie("auth_token");
    res.clearCookie("refresh_token");

    return res.status(500).json({
      error: "Token refresh failed",
      shouldLogout: true,
    });
  }
});

// ===== QR Code Generation =====
router.post("/qr/generate", async (req, res) => {
  try {
    const qrToken = `qr_${nanoid(32)}`;
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    await prisma.session.create({
      data: {
        userId: null,
        token: qrToken,
        expiresAt,
      },
    });

    const qrCodeUrl = await QRCode.toDataURL(
      JSON.stringify({
        token: qrToken,
        timestamp: Date.now(),
      })
    );

    return res.json({
      qrToken,
      qrCodeUrl,
      expiresAt,
    });
  } catch (error) {
    console.error("QR generation error:", error);
    return res.status(500).json({ error: "Failed to generate QR code" });
  }
});

// ===== QR Code Login =====
router.post("/qr/login", async (req, res) => {
  try {
    const { qrToken } = req.body;
    const token = req.cookies?.auth_token || req.headers.authorization?.replace("Bearer ", "");

    if (!token) {
      return res.status(401).json({ error: "Authentication required" });
    }

    if (!qrToken) {
      return res.status(400).json({ error: "QR token required" });
    }

    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch (error) {
      return res.status(401).json({ error: "Invalid token" });
    }

    const session = await prisma.session.findFirst({
      where: {
        token: qrToken,
        userId: null,
        expiresAt: { gt: new Date() },
      },
    });

    if (!session) {
      return res.status(404).json({
        error: "QR code expired or invalid",
        message: "QR code หมดอายุหรือไม่ถูกต้อง",
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.uid },
      include: { profile: true },
    });

    if (!user || !user.isActive) {
      return res.status(401).json({ error: "User not found or inactive" });
    }

    const { refreshToken } = generateTokens({
      uid: user.id,
      username: user.username,
      role: user.role,
    });

    await prisma.session.update({
      where: { id: session.id },
      data: {
        userId: user.id,
        token: refreshToken,
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      },
    });

    return res.json({
      message: "QR login successful",
      user: sanitizeUser(user),
    });
  } catch (error) {
    console.error("QR login error:", error);
    return res.status(500).json({ error: "QR login failed" });
  }
});

// ===== QR Status Check =====
router.get("/qr/status/:qrToken", async (req, res) => {
  try {
    const { qrToken } = req.params;

    const session = await prisma.session.findFirst({
      where: {
        token: { in: [qrToken, `qr_${qrToken}`] },
      },
      include: {
        user: {
          include: { profile: true },
        },
      },
    });

    if (!session) {
      return res.status(404).json({
        status: "not_found",
        message: "QR session not found",
      });
    }

    if (session.expiresAt < new Date()) {
      await prisma.session.delete({ where: { id: session.id } });
      return res.json({
        status: "expired",
        message: "QR code expired",
      });
    }

    if (!session.userId) {
      return res.json({
        status: "pending",
        message: "Waiting for scan",
      });
    }

    if (!session.user) {
      return res.status(500).json({
        status: "error",
        message: "User data not found",
      });
    }

    const { accessToken, refreshToken } = generateTokens({
      uid: session.user.id,
      username: session.user.username,
      role: session.user.role,
    });

    res.cookie("auth_token", accessToken, cookieConfig);
    res.cookie("refresh_token", refreshToken, cookieConfig);

    await prisma.session.update({
      where: { id: session.id },
      data: {
        token: refreshToken,
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      },
    });

    return res.json({
      status: "success",
      message: "Login successful",
      user: sanitizeUser(session.user),
    });
  } catch (error) {
    console.error("QR status check error:", error);
    return res.status(500).json({
      status: "error",
      message: "Failed to check QR status",
    });
  }
});

// ===== Anonymous Login =====
router.post("/anonymous", async (req, res) => {
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

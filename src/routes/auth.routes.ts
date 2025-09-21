/** @format */
// backend/src/routes/auth.routes.ts
import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs"; // ใช้ js ก็พอ
import { prisma } from "../prisma";
import type { Request, Response } from "express";
import { generateTokens, authLimiter, validateInput, verifyAccessToken } from "../middlewares/security";

const router = Router();

const signUpSchema = z.object({
  username: z.string().min(3).max(20),
  password: z
    .string()
    .min(8)
    .regex(/^(?=.*[A-Za-z])(?=.*\d)(?=.*[@$!%*#?&])/),
  preferredLang: z.enum(["th", "en"]).optional(),
});

const signInSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

router.post("/signup", authLimiter, validateInput(signUpSchema), async (req, res) => {
  try {
    const { username, password, preferredLang } = req.body;

    const existing = await prisma.user.findUnique({ where: { username } });
    if (existing) return res.status(409).json({ error: "User already exists" });

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await prisma.user.create({
      data: {
        username,
        passwordHash,
        role: "PLAYER",
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

    await prisma.session.upsert({
      where: { userId: user.id },
      update: {
        token: refreshToken,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
      create: {
        userId: user.id,
        token: refreshToken,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    // ตั้งคุกกี้ให้ middleware อ่าน (auth_token)
    const isProd = process.env.NODE_ENV === "production";
    res.cookie("auth_token", accessToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: isProd,
      maxAge: 15 * 60 * 1000, // 15 นาที
      path: "/",
    });
    res.cookie("refresh_token", refreshToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: isProd,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: "/",
    });

    return res.status(201).json({
      user: { id: user.id, username: user.username, profile: user.profile },
      message: "success",
    });
  } catch (error) {
    console.error("Signup error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/signin", authLimiter, validateInput(signInSchema), async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await prisma.user.findUnique({
      where: { username },
      include: { profile: true },
    });
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: "Invalid credentials" });

    const { accessToken, refreshToken } = generateTokens({
      uid: user.id,
      username: user.username,
      role: user.role,
    });

    await prisma.session.upsert({
      where: { userId: user.id }, // ⚠ ต้องมี unique index
      update: {
        token: refreshToken,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
      create: {
        userId: user.id,
        token: refreshToken,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    const isProd = process.env.NODE_ENV === "production";
    res.cookie("auth_token", accessToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: isProd,
      maxAge: 15 * 60 * 1000,
      path: "/",
    });
    res.cookie("refresh_token", refreshToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: isProd,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: "/",
    });

    return res.json({
      user: { id: user.id, username: user.username, profile: user.profile },
      message: "success",
    });
  } catch (error) {
    console.error("Signin error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/logout", async (req: Request, res: Response) => {
  try {
    const refresh = req.cookies?.refresh_token as string | undefined;

    if (refresh) {
      await prisma.session.deleteMany({ where: { token: refresh } });
    }

    const isProd = process.env.NODE_ENV === "production";
    res.clearCookie("auth_token", { httpOnly: true, sameSite: "lax", secure: isProd, path: "/" });
    res.clearCookie("refresh_token", { httpOnly: true, sameSite: "lax", secure: isProd, path: "/" });

    return res.json({ message: "logged out" });
  } catch (e) {
    console.error("Logout error:", e);
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/me", async (req: Request, res: Response) => {
  try {
    const access = req.cookies?.auth_token as string | undefined;
    if (!access) return res.status(401).json({ error: "Unauthenticated" });

    const payload = verifyAccessToken(access); // <— ใช้ของคุณเอง
    const user = await prisma.user.findUnique({
      where: { id: payload.uid },
      include: { profile: true },
    });
    if (!user) return res.status(401).json({ error: "Unauthenticated" });

    return res.json({ user: { id: user.id, username: user.username, profile: user.profile } });
  } catch {
    return res.status(401).json({ error: "Unauthenticated" });
  }
});

export default router;

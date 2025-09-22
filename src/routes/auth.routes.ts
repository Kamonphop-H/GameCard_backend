/** @format */
import { Router } from "express";
import { prisma } from "../prisma";
import {
  generateTokens,
  authLimiter,
  validateInput,
  verifyAccessToken,
  verifyRefreshToken,
  signUpSchema,
  signInSchema,
  hashPassword,
  comparePassword,
  sanitizeUser,
} from "../middlewares/security";

const router = Router();
const IS_PROD = process.env.NODE_ENV === "production";

// Fixed cookie config for development
const cookieConfig = {
  httpOnly: true,
  sameSite: "lax" as const, // เปลี่ยนจาก "none" เป็น "lax"
  secure: false, // ต้องเป็น false สำหรับ localhost
  path: "/",
  // ไม่ต้องใส่ domain สำหรับ localhost
};

// Sign up
router.post("/signup", authLimiter, validateInput(signUpSchema), async (req, res) => {
  try {
    const { username, password, preferredLang } = req.body;

    const existing = await prisma.user.findUnique({ where: { username } });
    if (existing) return res.status(409).json({ error: "Username already exists" });

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
      message: "Account created successfully",
    });
  } catch (error) {
    console.error("Signup error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Sign in - FIXED VERSION
router.post("/signin", authLimiter, validateInput(signInSchema), async (req, res) => {
  try {
    const { username, password } = req.body;

    console.log("=== SIGNIN ATTEMPT ===");
    console.log("Username:", username);

    const user = await prisma.user.findUnique({
      where: { username },
      include: { profile: true },
    });

    if (!user || !user.isActive) {
      console.log("User not found or inactive");
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const isValid = await comparePassword(password, user.passwordHash);
    console.log("Password valid:", isValid);

    if (!isValid) {
      console.log("Invalid password");
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // *** ส่วนที่ขาดไป - Generate tokens และ set cookies ***
    const { accessToken, refreshToken } = generateTokens({
      uid: user.id,
      username: user.username,
      role: user.role,
    });

    // Delete old sessions and create new one
    await prisma.session.deleteMany({
      where: { userId: user.id },
    });

    await prisma.session.create({
      data: {
        userId: user.id,
        token: refreshToken,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    // Update last login
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    // Set cookies
    res.cookie("auth_token", accessToken, {
      ...cookieConfig,
      maxAge: 15 * 60 * 1000, // 15 minutes
    });
    res.cookie("refresh_token", refreshToken, {
      ...cookieConfig,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    console.log("Sign in successful for:", username);
    console.log("Cookies set successfully");

    // Return success response
    return res.json({
      user: sanitizeUser(user),
      message: "Sign in successful",
    });
  } catch (error) {
    console.error("Signin error:", error);
    return res.status(500).json({ error: "Internal server error" });
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

    // Clear cookies without domain for localhost
    res.clearCookie("auth_token", {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      path: "/",
    });
    res.clearCookie("refresh_token", {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      path: "/",
    });

    return res.json({ message: "Logged out successfully" });
  } catch (error) {
    // Clear cookies even if error
    res.clearCookie("auth_token");
    res.clearCookie("refresh_token");
    return res.json({ message: "Logged out" });
  }
});

router.get("/me", async (req, res) => {
  try {
    console.log("=== /me endpoint ===");
    console.log("Cookies:", req.cookies);

    const token = req.cookies?.auth_token;

    if (!token) {
      console.log("No auth token found in cookies");
      return res.status(401).json({ error: "Authentication required" });
    }

    const payload = verifyAccessToken(token);
    console.log("Token payload:", { uid: payload.uid, username: payload.username });

    const user = await prisma.user.findUnique({
      where: { id: payload.uid },
      include: { profile: true },
    });

    if (!user?.isActive) {
      console.log("User not found or inactive");
      return res.status(401).json({ error: "User not found" });
    }

    return res.json({ user: sanitizeUser(user) });
  } catch (error) {
    console.error("/me error:", error);
    return res.status(401).json({ error: "Authentication failed" });
  }
});

export default router;

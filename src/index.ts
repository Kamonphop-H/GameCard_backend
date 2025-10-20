/** @format */
import "dotenv/config";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import { createServer } from "http";
import path from "path";

// Import routes
import authRoutes from "./routes/auth.routes";
import gameRoutes from "./routes/game.routes";
import userRoutes from "./routes/user.routes";
import leaderboardRoutes from "./routes/leaderboard.routes";
import adminRoutes, { initializeFileService } from "./routes/admin.routes";
import questionRoutes from "./routes/question.routes";
import aiRoutes from "./routes/ai.routes";

import { apiLimiter, corsOptions } from "./middlewares/security";
import firebaseService from "./services/firebaseService";
import { prisma } from "./prisma";

// ENV guard
const required = ["DATABASE_URL", "JWT_SECRET", "JWT_REFRESH_SECRET"];
for (const env of required) {
  if (!process.env[env]) {
    console.error(`Missing ${env}`);
    process.exit(1);
  }
}

// ⚠️ Gemini API Key warning (optional but recommended)
if (!process.env.GEMINI_API_KEY) {
  console.warn("⚠️  GEMINI_API_KEY not found - AI features will not work");
}

const app = express();
const server = createServer(app);
const port = Number(process.env.PORT) || 5000;

// Core middlewares
app.use(cors(corsOptions));
app.use(cookieParser());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
app.use("/api", apiLimiter);

// Health Check
app.get("/health", async (_req, res) => {
  try {
    await prisma.$runCommandRaw({ ping: 1 });
    res.json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      services: {
        database: "connected",
        firebase: firebaseService.initialize() ? "enabled" : "disabled",
        ai: process.env.GEMINI_API_KEY ? "enabled" : "disabled",
      },
    });
  } catch (error) {
    res.status(503).json({
      status: "unhealthy",
      error: "Database connection failed",
    });
  }
});

// Root
app.get("/", (_req, res) => {
  res.json({
    name: "Quiz Game API",
    version: "1.0.0",
    status: "running",
    endpoints: {
      health: "/health",
      auth: "/api/auth",
      game: "/api/game",
      user: "/api/user",
      leaderboard: "/api/leaderboard",
      admin: "/api/admin",
      ai: "/api/ai",
    },
  });
});

// ⭐ API Routes - ครบทุก endpoint
app.use("/api/auth", authRoutes);
app.use("/api/game", gameRoutes);
app.use("/api/questions", questionRoutes);
app.use("/api/user", userRoutes);
app.use("/api/leaderboard", leaderboardRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/ai", aiRoutes); // ⭐ เพิ่ม AI routes

// Static files for uploads
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    error: "Route not found",
    path: req.originalUrl,
  });
});

// Error Handler
app.use((err: any, _req: any, res: any, _next: any) => {
  console.error("Error:", err);
  res.status(err.status || 500).json({
    error: err.message || "Internal server error",
    ...(process.env.NODE_ENV !== "production" && { stack: err.stack }),
  });
});

// Graceful shutdown
const shutdown = async () => {
  console.log("🔄 Shutting down gracefully...");
  server.close(() => {
    console.log("HTTP server closed");
  });

  await prisma.$disconnect();
  console.log("Database disconnected");

  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Start Server
async function start() {
  try {
    await prisma.$connect();
    console.log("✅ Database connected");

    await initializeFileService();
    console.log("✅ File service initialized");

    const firebaseInitialized = firebaseService.initialize();
    if (firebaseInitialized) {
      console.log("✅ Firebase service initialized");
    } else {
      console.warn("⚠️  Firebase service not configured - Google Sign-In will not work");
    }

    // Check Gemini AI
    if (process.env.GEMINI_API_KEY) {
      console.log("✅ Gemini AI service enabled");
    } else {
      console.warn("⚠️  Gemini AI not configured - AI features will not work");
    }

    server.listen(port, () => {
      console.log(`🚀 Server running on http://localhost:${port}`);
      console.log(`📦 Environment: ${process.env.NODE_ENV || "development"}`);
      console.log(`🤖 AI Features: ${process.env.GEMINI_API_KEY ? "Enabled" : "Disabled"}`);
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
}

start();

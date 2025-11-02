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

import { apiLimiter } from "./middlewares/security";
import firebaseService from "./services/firebaseService";
import { prisma } from "./prisma";
import { corsOptions } from "./config/cors";

// ============================
// ENV Validation
// ============================
const required = ["DATABASE_URL", "JWT_SECRET", "JWT_REFRESH_SECRET"];
for (const env of required) {
  if (!process.env[env]) {
    console.error(`❌ Missing required environment variable: ${env}`);
    process.exit(1);
  }
}

// Optional but recommended warnings
if (!process.env.GEMINI_API_KEY) {
  console.warn("⚠️  GEMINI_API_KEY not found - AI features will not work");
}

if (!process.env.FRONTEND_URL) {
  console.warn("⚠️  FRONTEND_URL not set - using default CORS settings");
}

// ============================
// Express App Setup
// ============================
const app = express();
const server = createServer(app);
const port = Number(process.env.PORT) || 5000;

// ============================
// Core Middlewares
// ============================
app.use(cors(corsOptions));
app.use(cookieParser());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// Rate limiting for all API routes
app.use("/api", apiLimiter);

// ============================
// Health Check Endpoint
// ============================
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
    console.error("Health check failed:", error);
    res.status(503).json({
      status: "unhealthy",
      error: "Database connection failed",
    });
  }
});

// ============================
// Root Endpoint
// ============================
app.get("/", (_req, res) => {
  res.json({
    name: "Quiz Game API",
    version: "1.0.0",
    status: "running",
    timestamp: new Date().toISOString(),
    endpoints: {
      health: "/health",
      auth: "/api/auth",
      game: "/api/game",
      questions: "/api/questions",
      user: "/api/user",
      leaderboard: "/api/leaderboard",
      admin: "/api/admin",
      ai: "/api/ai",
    },
  });
});

// ============================
// API Routes
// ============================
app.use("/api/auth", authRoutes);
app.use("/api/game", gameRoutes);
app.use("/api/questions", questionRoutes);
app.use("/api/user", userRoutes);
app.use("/api/leaderboard", leaderboardRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/ai", aiRoutes);

// ============================
// Static Files (Uploaded Images)
// ============================
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

// ============================
// 404 Handler (Must be after all routes)
// ============================
app.use((req, res) => {
  console.warn(`⚠️  404 - Route not found: ${req.method} ${req.originalUrl}`);
  res.status(404).json({
    error: "Route not found",
    method: req.method,
    path: req.originalUrl,
    timestamp: new Date().toISOString(),
  });
});

// ============================
// Global Error Handler
// ============================
app.use((err: any, _req: any, res: any, _next: any) => {
  console.error("❌ Unhandled error:", err);

  res.status(err.status || 500).json({
    error: err.message || "Internal server error",
    ...(process.env.NODE_ENV !== "production" && {
      stack: err.stack,
      details: err,
    }),
  });
});

// ============================
// Graceful Shutdown Handlers
// ============================
const shutdown = async (signal: string) => {
  console.log(`\n🔄 Received ${signal}, shutting down gracefully...`);

  server.close(() => {
    console.log("✅ HTTP server closed");
  });

  try {
    await prisma.$disconnect();
    console.log("✅ Database disconnected");
    process.exit(0);
  } catch (error) {
    console.error("❌ Error during shutdown:", error);
    process.exit(1);
  }
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Handle uncaught exceptions
process.on("uncaughtException", (error) => {
  console.error("❌ Uncaught Exception:", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Unhandled Rejection at:", promise, "reason:", reason);
  process.exit(1);
});

// ============================
// Server Startup
// ============================
async function start() {
  try {
    // 1. Connect to Database
    await prisma.$connect();
    console.log("✅ Database connected");

    // 2. Initialize File Service (create upload directories)
    await initializeFileService();
    console.log("✅ File service initialized");

    // 3. Initialize Firebase (if configured)
    const firebaseInitialized = firebaseService.initialize();
    if (firebaseInitialized) {
      console.log("✅ Firebase service initialized");
    } else {
      console.warn("⚠️  Firebase service not configured - Google Sign-In will not work");
    }

    // 4. Check AI Service
    if (process.env.GEMINI_API_KEY) {
      console.log("✅ Gemini AI service enabled");
    } else {
      console.warn("⚠️  Gemini AI not configured - AI features will not work");
    }

    // 5. Start HTTP Server (bind to all network interfaces)
    server.listen(port, "0.0.0.0", () => {
      console.log("\n" + "=".repeat(60));
      console.log(`🚀 Server running on http://0.0.0.0:${port}`);
      console.log(`🌐 Accessible at http://172.20.10.6:${port}`);
      console.log(`📦 Environment: ${process.env.NODE_ENV || "development"}`);
      console.log(`🤖 AI Features: ${process.env.GEMINI_API_KEY ? "Enabled ✅" : "Disabled ❌"}`);
      console.log(`🔐 Firebase Auth: ${firebaseInitialized ? "Enabled ✅" : "Disabled ❌"}`);

      const allowedOrigins = [
        "http://localhost:3000",
        "http://localhost:3001",
        "http://127.0.0.1:3000",
        "http://172.20.10.6:3000",
        "http://172.20.10.6:3001",
        "http://45.32.115.120:3000",
        "http://45.32.115.120:3001",
        process.env.FRONTEND_URL,
      ].filter(Boolean);

      console.log(`🌍 CORS allowed origins: ${allowedOrigins.length}`);
      allowedOrigins.forEach((origin) => console.log(`   - ${origin}`));
      console.log("=".repeat(60) + "\n");

      console.log("📌 Available endpoints:");
      console.log("   - GET  /health");
      console.log("   - POST /api/auth/sign-in");
      console.log("   - POST /api/auth/sign-up");
      console.log("   - GET  /api/game/start");
      console.log("   - GET  /api/admin/questions");
      console.log("   - GET  /api/leaderboard");
      console.log("   - POST /api/ai/chat");
      console.log("\n✨ Server ready to accept connections!\n");
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
}

// Start the server
start();

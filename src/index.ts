/** @format */
import "dotenv/config";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import { createServer } from "http";
import path from "path";

// Import routes - à¸„à¸£à¸±à¹‰à¸‡à¹€à¸”à¸µà¸¢à¸§
import authRoutes from "../src/routes/auth.routes";
import gameRoutes from "../src/routes/game.routes";
import userRoutes from "../src/routes/user.routes";
import leaderboardRoutes from "../src/routes/leaderboard.routes";
import adminRoutes, { initializeFileService } from "../src/routes/admin.routes";
import questionRoutes from "../src/routes/question.routes";

import { apiLimiter, corsOptions } from "../src/middlewares/security";
import { prisma } from "../src/prisma";

// ===== ENV guard =====
const required = ["DATABASE_URL", "JWT_SECRET", "JWT_REFRESH_SECRET"];
for (const env of required) {
  if (!process.env[env]) {
    console.error(`âŒ Missing ${env}`);
    process.exit(1);
  }
}

const app = express();
const server = createServer(app);
const port = Number(process.env.PORT) || 5000;

// ===== Core middlewares =====
app.use(cors(corsOptions));
app.use(cookieParser());
app.use(express.json({ limit: "10mb" })); // à¹€à¸žà¸´à¹ˆà¸¡à¸‚à¸™à¸²à¸”à¸ªà¸³à¸«à¸£à¸±à¸šà¸£à¸¹à¸›à¸ à¸²à¸ž
app.use(express.urlencoded({ extended: true }));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
app.use("/api", apiLimiter);

// ===== Health Check =====
app.get("/health", async (_req, res) => {
  try {
    await prisma.$runCommandRaw({ ping: 1 });
    res.json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  } catch (error) {
    res.status(503).json({
      status: "unhealthy",
      error: "Database connection failed",
    });
  }
});

// ===== Root =====
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
    },
  });
});

// ===== API Routes - à¸ˆà¸±à¸”à¹€à¸£à¸µà¸¢à¸‡à¹ƒà¸«à¸¡à¹ˆà¹ƒà¸«à¹‰à¸Šà¸±à¸”à¹€à¸ˆà¸™ =====
app.use("/api/auth", authRoutes);
app.use("/api/game", gameRoutes);
app.use("/api/questions", questionRoutes);
app.use("/api/user", userRoutes);
app.use("/api/leaderboard", leaderboardRoutes);
app.use("/api/admin", adminRoutes);

// ===== Static files for uploads =====
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

// ===== 404 Handler =====
app.use((req, res) => {
  res.status(404).json({
    error: "Route not found",
    path: req.originalUrl,
  });
});

// ===== Error Handler =====
app.use((err: any, _req: any, res: any, _next: any) => {
  console.error("Error:", err);
  res.status(err.status || 500).json({
    error: err.message || "Internal server error",
    ...(process.env.NODE_ENV !== "production" && { stack: err.stack }),
  });
});

// ===== Graceful shutdown =====
const shutdown = async () => {
  console.log("ðŸ”„ Shutting down gracefully...");
  server.close(() => {
    console.log("HTTP server closed");
  });

  await prisma.$disconnect();
  console.log("Database disconnected");

  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ===== Start Server =====
async function start() {
  try {
    // Connect to database
    await prisma.$connect();
    console.log("âœ… Database connected");

    // Initialize GridFS for image storage
    await initializeFileService();
    console.log("âœ… File service initialized");

    // Start server
    server.listen(port, () => {
      console.log(`ðŸš€ Server running on http://localhost:${port}`);
      console.log(`ðŸ“ Environment: ${process.env.NODE_ENV || "development"}`);
    });
  } catch (error) {
    console.error("âŒ Failed to start server:", error);
    process.exit(1);
  }
}

// Start the application
start();

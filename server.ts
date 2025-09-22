/** @format */
import "dotenv/config";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import { createServer } from "http";
import authRouter from "./src/routes/auth.routes";
import { initWebSocket } from "./src/services/websocket";
import { apiLimiter, corsOptions } from "./src/middlewares/security";
import { prisma } from "./src/prisma";

// Validate required environment variables
const required = ["DATABASE_URL", "JWT_SECRET", "JWT_REFRESH_SECRET"];
for (const env of required) {
  if (!process.env[env]) {
    console.error(`❌ Missing ${env}`);
    process.exit(1);
  }
}

const app = express();
const server = createServer(app);
const port = Number(process.env.PORT) || 5000;

// Initialize WebSocket
initWebSocket(server);

// Middleware
app.use(cors(corsOptions));
app.use(cookieParser());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
app.use("/api", apiLimiter);

// Health check
app.get("/health", async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
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

// Root route
app.get("/", (req, res) => {
  res.json({
    name: "Quiz Game API",
    version: "1.0.0",
    status: "running",
    endpoints: {
      health: "/health",
      auth: "/api/auth",
    },
  });
});

// Routes
app.use("/api/auth", authRouter);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: "Route not found",
    path: req.originalUrl,
  });
});

// Error handler
app.use((err: any, req: any, res: any, next: any) => {
  console.error(err);
  res.status(500).json({
    error: "Internal server error",
    ...(process.env.NODE_ENV !== "production" && { details: err.message }),
  });
});

// Graceful shutdown
const shutdown = async () => {
  console.log("🔄 Shutting down...");
  server.close();
  await prisma.$disconnect();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Start server
async function start() {
  try {
    await prisma.$connect();
    console.log("✅ Database connected");

    server.listen(port, () => {
      console.log(`🚀 Server running on http://localhost:${port}`);
    });
  } catch (error) {
    console.error("❌ Failed to start:", error);
    process.exit(1);
  }
}

start();

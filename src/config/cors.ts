/** @format */

// backend/src/config/cors.ts
import type { CorsOptions } from "cors";

export const getAllowedOrigins = () => {
  const origins = [
    "http://localhost:3000",
    "http://localhost:3001",
    "http://127.0.0.1:3000",
    process.env.FRONTEND_URL,
    // เพิ่ม IP ที่เป็นไปได้ทั้งหมด
    "http://172.20.10.6:3000",
    "http://172.20.10.6:3001",
    "http://45.32.115.120:3000",
    "http://45.32.115.120:3001",
    // ถ้ามี IP อื่นๆ ให้เพิ่มที่นี่
  ].filter(Boolean) as string[];

  // ในโหมด dev อนุญาตทุก origin
  if (process.env.NODE_ENV !== "production") {
    console.log("📋 Allowed origins:", origins);
  }

  return origins;
};

export const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    const allowedOrigins = getAllowedOrigins();

    // Allow requests with no origin (mobile apps, postman)
    if (!origin) {
      return callback(null, true);
    }

    // Check if origin is allowed
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    // In development, allow all origins but log warning
    if (process.env.NODE_ENV !== "production") {
      console.warn(`⚠️ CORS: Allowing origin ${origin} in development mode`);
      return callback(null, true);
    }

    // In production, reject unknown origins
    console.error(`❌ CORS blocked origin: ${origin}`);
    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
  allowedHeaders: ["Content-Type", "Authorization", "Cookie", "X-Requested-With"],
  exposedHeaders: ["set-cookie"],
  maxAge: 86400,
  preflightContinue: false,
  optionsSuccessStatus: 204,
};

/** @format */

// src/config/constants.ts
/** @format */
import type { CorsOptions } from "cors";

export const IS_PROD = process.env.NODE_ENV === "production";
export const PORT = Number(process.env.PORT) || 5000;

const REQUIRED_ENVS = ["DATABASE_URL", "JWT_SECRET", "JWT_REFRESH_SECRET"] as const;

export function checkEnvVariables(): string[] {
  const missing = REQUIRED_ENVS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error("Missing environment variables:", missing.join(", "));
    console.error("Please check .env.example for required variables");
  }
  return missing as string[];
}

export const JWT_SECRET = process.env.JWT_SECRET!;
export const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET!;

// --- CORS ---
const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3000",
  process.env.FRONTEND_URL,
].filter(Boolean) as string[];

export const corsOptions: CorsOptions = {
  origin(origin, callback) {
    // allow server-to-server / same-origin / tools with no origin
    if (!origin) return callback(null, true);

    if (IS_PROD) {
      if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      return callback(new Error("Not allowed by CORS"));
    }

    // dev: allow all (log it for visibility)
    console.warn(`CORS (dev): allowing origin ${origin}`);
    return callback(null, true);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Cookie"],
  exposedHeaders: ["set-cookie"],
};

// --- Cookies ---
export const cookieConfig = {
  httpOnly: true,
  sameSite: (IS_PROD ? "strict" : "lax") as const,
  secure: IS_PROD,
  path: "/",
  ...(IS_PROD && process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}),
};

// --- Tokens ---
export const TOKEN_EXPIRY = {
  ACCESS: 15 * 60 * 1000,
  REFRESH: 7 * 24 * 60 * 60 * 1000,
};

// --- Rate Limit ---
export const RATE_LIMIT = {
  AUTH: { windowMs: 15 * 60 * 1000, max: 5 },
  API: { windowMs: 15 * 60 * 1000, max: 100 },
  GAME: { windowMs: 60 * 1000, max: 30 },
};

// --- Uploads ---
export const FILE_UPLOAD = {
  MAX_SIZE: 5 * 1024 * 1024,
  ALLOWED_TYPES: ["image/jpeg", "image/png", "image/webp", "image/gif"],
};

// --- Game Config ---
export const GAME_CONFIG = {
  QUESTIONS_PER_GAME: 10,
  QUESTIONS_PER_CATEGORY_MIXED: 10,
  SCORE_MULTIPLIERS: { EASY: 10, MEDIUM: 20, HARD: 30 },
  TIME_BONUS_THRESHOLD: 10,
  TIME_BONUS_MULTIPLIER: 1.5,
} as const;

// --- Categories ---
export const CATEGORIES = ["HEALTH", "COGNITION", "DIGITAL", "FINANCE"] as const;
export type Category = (typeof CATEGORIES)[number];

// --- Question Types ---
export const QUESTION_TYPES = {
  HEALTH: [
    { id: "MISSING_NUTRIENT", name: "สารอาหารที่หายไป", inputType: "TEXT", multipleAnswers: true },
    { id: "NUTRIENT_FROM_IMAGE", name: "ภาพนี้ได้สารอาหารอะไร", inputType: "TEXT", multipleAnswers: true },
    {
      id: "DISEASE_FROM_IMAGE",
      name: "ภาพนี้คือโรคอะไร",
      inputType: "MULTIPLE_CHOICE_4",
      multipleAnswers: false,
    },
  ],
  COGNITION: [
    { id: "ILLEGAL_TEXT", name: "ข้อความผิดกฎหมาย", inputType: "MULTIPLE_CHOICE_4", multipleAnswers: false },
    { id: "ODD_ONE_OUT", name: "สิ่งของไม่เข้าพวก", inputType: "TEXT", multipleAnswers: false },
  ],
  DIGITAL: [
    {
      id: "APP_IDENTITY",
      name: "แอปพลิเคชันนี้คืออะไร",
      inputType: "MULTIPLE_CHOICE_4",
      multipleAnswers: false,
    },
    { id: "SCAM_TEXT", name: "ข้อความหลอกลวง", inputType: "MULTIPLE_CHOICE_4", multipleAnswers: false },
    { id: "DONT_SHARE", name: "ข้อมูลที่ไม่ควรแชร์", inputType: "MULTIPLE_CHOICE_4", multipleAnswers: false },
  ],
  FINANCE: [
    { id: "ARITHMETIC_TARGET", name: "บวกเลขตามเป้าหมาย", inputType: "CALCULATION", multipleAnswers: false },
    {
      id: "MAX_VALUE_STACK",
      name: "ธนบัตรกองไหนมากสุด",
      inputType: "MULTIPLE_CHOICE_3",
      multipleAnswers: false,
    },
  ],
} as const;

// --- Error Messages ---
export const ERROR_MESSAGES = {
  AUTH_REQUIRED: "Authentication required",
  INVALID_CREDENTIALS: "Invalid credentials",
  USER_EXISTS: "Username already exists",
  USER_NOT_FOUND: "User not found",
  TOKEN_EXPIRED: "Token expired",
  TOKEN_INVALID: "Invalid token",
  INVALID_INPUT: "Invalid input data",
  VALIDATION_FAILED: "Validation failed",
  SESSION_NOT_FOUND: "Game session not found",
  INVALID_CATEGORY: "Invalid category",
  QUESTION_NOT_FOUND: "Question not found",
  ADMIN_ONLY: "Admin access required",
  FILE_NOT_FOUND: "File not found",
  FILE_TOO_LARGE: "File size exceeds limit",
  INVALID_FILE_TYPE: "Invalid file type",
  INTERNAL_ERROR: "Internal server error",
  NOT_FOUND: "Resource not found",
  TOO_MANY_REQUESTS: "Too many requests",
} as const;

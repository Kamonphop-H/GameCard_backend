/** @format */

import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z.string().url().or(z.string().startsWith("mongodb")),
  JWT_SECRET: z.string().min(16),
  PORT: z.string().transform(Number).default(3001),
  CORS_ORIGIN: z.string().optional(),
  UPLOAD_DIR: z.string().default("./uploads"),
});

export const env = EnvSchema.parse(process.env);

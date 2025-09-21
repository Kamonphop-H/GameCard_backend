/** @format */
// src/server.ts
import "dotenv/config";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import authRouter from "./src/routes/auth.routes"; // ⬅️ แก้ path ให้ตรงกับโครงจริง

const app = express();
const port = Number(process.env.PORT) || 5000;

app.use(cors({ origin: process.env.FRONTEND_ORIGIN ?? "http://localhost:3000", credentials: true }));

app.use(cookieParser());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan("dev"));

app.use("/api/auth", authRouter);

// Health
app.get("/", (_req, res) => res.json({ message: "Server is running" }));

// 404/500
app.use((_req, res) => res.status(404).json({ message: "Not Found" }));
app.use((err: unknown, _req: any, res: any, _next: any) => {
  console.error(err);
  res.status(500).json({ message: "Internal Server Error" });
});

app.listen(port, () => console.log(`Server is running on http://localhost:${port}`));

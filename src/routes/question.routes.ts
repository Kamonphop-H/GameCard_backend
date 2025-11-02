/** @format */
// src/routes/admin.routes.ts

import { Router, Request, Response } from "express";
import path from "path";
import fs from "fs";
import multer from "multer";
import { prisma } from "../prisma";
import { requireAuth, requireAdmin } from "../middlewares/security";
import { Category, Lang, QType, InputType } from "@prisma/client";

const router = Router();

// ============================
// File Service Init (export ชื่อเดียวกับที่ index.ts เรียกใช้)
// ============================
export async function initializeFileService() {
  const baseDir = path.join(process.cwd(), "uploads");
  const qDir = path.join(baseDir, "questions");

  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
  if (!fs.existsSync(qDir)) fs.mkdirSync(qDir, { recursive: true });
}

// ============================
// Multer config (upload questions images)
// ============================
const uploadDir = path.join(process.cwd(), "uploads", "questions");

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, unique + path.extname(file.originalname));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    const extOk = allowed.test(path.extname(file.originalname).toLowerCase());
    const mimeOk = allowed.test(file.mimetype);
    if (extOk && mimeOk) cb(null, true);
    else cb(new Error("Only image files are allowed"));
  },
});

// ============================
// ⭐ ALL ROUTES MUST USE requireAuth + requireAdmin
// ============================

// Admin Stats
router.get("/stats", requireAuth, requireAdmin, async (_req: Request, res: Response) => {
  try {
    const [totalQuestions, activeQuestions, totalUsers, totalGames, avgScoreData, categoryGroup] =
      await Promise.all([
        prisma.question.count(),
        prisma.question.count({ where: { isActive: true } }),
        prisma.user.count(),
        prisma.gameResult.count({ where: { isCompleted: true } }),
        prisma.gameResult.aggregate({
          where: { isCompleted: true },
          _avg: { score: true },
        }),
        prisma.question.groupBy({
          by: ["category"],
          _count: { _all: true },
          where: { isActive: true },
        }),
      ]);

    const categories: Record<string, number> = {};
    categoryGroup.forEach((g) => {
      categories[g.category] = g._count._all;
    });

    res.json({
      totalQuestions,
      activeQuestions,
      totalUsers,
      totalGames,
      avgScore: Math.round(avgScoreData._avg.score || 0),
      categories,
    });
  } catch (error) {
    console.error("Get admin stats error:", error);
    res.status(500).json({ error: "Failed to get stats" });
  }
});

// ⭐ Get Questions (filters + pagination + search in translations)
router.get("/questions", requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const { category, search, isActive, page = "1", limit = "50" } = req.query;

    const pageNum = parseInt(String(page), 10);
    const limitNum = Math.min(200, parseInt(String(limit), 10) || 50);
    const skip = (pageNum - 1) * limitNum;

    const where: any = {};
    if (category && category !== "ALL") where.category = category as Category;
    if (typeof isActive !== "undefined") where.isActive = String(isActive) === "true";

    const [questions, total] = await Promise.all([
      prisma.question.findMany({
        where,
        include: { translations: true },
        orderBy: { createdAt: "desc" },
        skip,
        take: limitNum,
      }),
      prisma.question.count({ where }),
    ]);

    let items = questions;
    if (typeof search === "string" && search.trim()) {
      const needle = search.toLowerCase();
      items = questions.filter((q) =>
        q.translations.some((t) => t.questionText.toLowerCase().includes(needle))
      );
    }

    res.json({
      questions: items,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    console.error("Get questions error:", error);
    res.status(500).json({ error: "Failed to get questions" });
  }
});

// Get Single Question
router.get("/questions/:id", requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const question = await prisma.question.findUnique({
      where: { id },
      include: { translations: true },
    });
    if (!question) return res.status(404).json({ error: "Question not found" });
    res.json(question);
  } catch (error) {
    console.error("Get question error:", error);
    res.status(500).json({ error: "Failed to get question" });
  }
});

// Create Question
router.post(
  "/questions",
  requireAuth,
  requireAdmin,
  upload.single("image"),
  async (req: Request, res: Response) => {
    try {
      const { category, type, inputType, difficulty, translations } = req.body;

      const parsed = typeof translations === "string" ? JSON.parse(translations) : translations;

      const imageFilename = req.file ? req.file.filename : undefined;

      const dataTrans = (lang: "th" | "en") => ({
        lang,
        questionText: parsed?.[lang]?.questionText ?? "",
        imageUrl: imageFilename ?? parsed?.[lang]?.imageUrl ?? null,
        options: parsed?.[lang]?.options ?? [],
        correctAnswers: parsed?.[lang]?.correctAnswers ?? [],
        targetValue: parsed?.[lang]?.targetValue ?? null,
        explanation: parsed?.[lang]?.explanation ?? "",
        hint1: parsed?.[lang]?.hint1 ?? null,
        hint2: parsed?.[lang]?.hint2 ?? null,
        hint3: parsed?.[lang]?.hint3 ?? null,
      });

      const created = await prisma.question.create({
        data: {
          category: category as Category,
          type: type as QType,
          inputType: inputType as InputType,
          difficulty: parseInt(String(difficulty), 10) || 1,
          isActive: true,
          translations: { create: [dataTrans("th"), dataTrans("en")] },
        },
        include: { translations: true },
      });

      res.json({ message: "Question created successfully", question: created });
    } catch (error) {
      console.error("Create question error:", error);
      res.status(500).json({ error: "Failed to create question" });
    }
  }
);

// Update Question
router.put(
  "/questions/:id",
  requireAuth,
  requireAdmin,
  upload.single("image"),
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { category, type, inputType, difficulty, translations, isActive } = req.body;

      const parsed = typeof translations === "string" ? JSON.parse(translations) : translations;

      const existing = await prisma.question.findUnique({
        where: { id },
        include: { translations: true },
      });
      if (!existing) return res.status(404).json({ error: "Question not found" });

      let imageUrl = existing.translations[0]?.imageUrl ?? null;

      if (req.file) {
        // delete old if exists
        if (imageUrl) {
          const oldPath = path.join(uploadDir, imageUrl);
          if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        }
        imageUrl = req.file.filename;
      }

      // update base
      await prisma.question.update({
        where: { id },
        data: {
          category: (category as Category) ?? existing.category,
          type: (type as QType) ?? existing.type,
          inputType: (inputType as InputType) ?? existing.inputType,
          difficulty:
            typeof difficulty !== "undefined" ? parseInt(String(difficulty), 10) : existing.difficulty,
          isActive:
            typeof isActive !== "undefined"
              ? String(isActive) === "true" || isActive === true
              : existing.isActive,
        },
      });

      // update translations th/en
      for (const lang of ["th", "en"] as Lang[]) {
        const t = existing.translations.find((x) => x.lang === lang);
        if (t) {
          await prisma.questionTranslation.update({
            where: { id: t.id },
            data: {
              questionText: parsed?.[lang]?.questionText ?? t.questionText,
              imageUrl: imageUrl ?? t.imageUrl,
              options: parsed?.[lang]?.options ?? t.options,
              correctAnswers: parsed?.[lang]?.correctAnswers ?? t.correctAnswers,
              targetValue:
                typeof parsed?.[lang]?.targetValue !== "undefined" ? parsed[lang].targetValue : t.targetValue,
              explanation: parsed?.[lang]?.explanation ?? t.explanation,
              hint1: typeof parsed?.[lang]?.hint1 !== "undefined" ? parsed[lang].hint1 : t.hint1,
              hint2: typeof parsed?.[lang]?.hint2 !== "undefined" ? parsed[lang].hint2 : t.hint2,
              hint3: typeof parsed?.[lang]?.hint3 !== "undefined" ? parsed[lang].hint3 : t.hint3,
            },
          });
        }
      }

      const finalQ = await prisma.question.findUnique({
        where: { id },
        include: { translations: true },
      });

      res.json({ message: "Question updated successfully", question: finalQ });
    } catch (error) {
      console.error("Update question error:", error);
      res.status(500).json({ error: "Failed to update question" });
    }
  }
);

// Delete Question
router.delete("/questions/:id", requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const q = await prisma.question.findUnique({
      where: { id },
      include: { translations: true },
    });
    if (!q) return res.status(404).json({ error: "Question not found" });

    const imageUrl = q.translations[0]?.imageUrl ?? null;
    if (imageUrl) {
      const p = path.join(uploadDir, imageUrl);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }

    await prisma.question.delete({ where: { id } });
    res.json({ message: "Question deleted successfully" });
  } catch (error) {
    console.error("Delete question error:", error);
    res.status(500).json({ error: "Failed to delete question" });
  }
});

// Toggle Active
router.patch("/questions/:id/toggle", requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const q = await prisma.question.findUnique({ where: { id } });
    if (!q) return res.status(404).json({ error: "Question not found" });

    const updated = await prisma.question.update({
      where: { id },
      data: { isActive: !q.isActive },
    });

    res.json({ message: "Question status updated", question: updated });
  } catch (error) {
    console.error("Toggle question error:", error);
    res.status(500).json({ error: "Failed to toggle question status" });
  }
});

// Bulk Delete
router.post("/questions/bulk-delete", requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "Invalid ids" });
    }

    const list = await prisma.question.findMany({
      where: { id: { in: ids } },
      include: { translations: true },
    });

    list.forEach((q) => {
      const img = q.translations[0]?.imageUrl;
      if (img) {
        const p = path.join(uploadDir, img);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
    });

    await prisma.question.deleteMany({ where: { id: { in: ids } } });
    res.json({ message: `${ids.length} questions deleted successfully` });
  } catch (error) {
    console.error("Bulk delete error:", error);
    res.status(500).json({ error: "Failed to delete questions" });
  }
});

// Bulk Toggle
router.post("/questions/bulk-toggle", requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const { ids, isActive } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "Invalid ids" });
    }
    await prisma.question.updateMany({
      where: { id: { in: ids } },
      data: { isActive: !!isActive },
    });
    res.json({ message: `${ids.length} questions updated successfully` });
  } catch (error) {
    console.error("Bulk toggle error:", error);
    res.status(500).json({ error: "Failed to toggle questions" });
  }
});

// Import Questions from JSON
router.post("/questions/import", requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const { category, questions } = req.body;

    if (!category || !Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ error: "Invalid import data" });
    }

    let successCount = 0;
    const errors: string[] = [];

    for (const q of questions) {
      try {
        const dataTrans = (lang: "th" | "en") => ({
          lang,
          questionText: q.translations?.[lang]?.questionText ?? "",
          imageUrl: q.translations?.[lang]?.imageUrl ?? null,
          options: q.translations?.[lang]?.options ?? [],
          correctAnswers: q.translations?.[lang]?.correctAnswers ?? [],
          targetValue: q.translations?.[lang]?.targetValue ?? null,
          explanation: q.translations?.[lang]?.explanation ?? "",
          hint1: q.translations?.[lang]?.hint1 ?? null,
          hint2: q.translations?.[lang]?.hint2 ?? null,
          hint3: q.translations?.[lang]?.hint3 ?? null,
        });

        await prisma.question.create({
          data: {
            category: category as Category,
            type: q.type as QType,
            inputType: q.inputType as InputType,
            difficulty: q.difficulty || 1,
            isActive: true,
            translations: { create: [dataTrans("th"), dataTrans("en")] },
          },
        });

        successCount++;
      } catch (err: any) {
        errors.push(`Question ${successCount + 1}: ${err.message}`);
      }
    }

    res.json({
      message: `Imported ${successCount}/${questions.length} questions`,
      successCount,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error("Import questions error:", error);
    res.status(500).json({ error: "Failed to import questions" });
  }
});

// Validate Answer (for testing tools)
router.post("/validate-answer", requireAuth, async (req: Request, res: Response) => {
  try {
    const { questionId, userAnswer, lang = "th" } = req.body;

    const question = await prisma.question.findUnique({
      where: { id: questionId },
      include: { translations: { where: { lang } } },
    });

    if (!question || !question.translations[0]) {
      return res.status(404).json({ error: "Question not found" });
    }

    const t = question.translations[0];
    let isCorrect = false;

    switch (question.inputType) {
      case "TEXT":
        isCorrect = t.correctAnswers.some(
          (ans) => ans.toLowerCase().trim() === String(userAnswer).toLowerCase().trim()
        );
        break;
      case "CALCULATION":
        if (t.targetValue !== null && t.targetValue !== undefined) {
          try {
            const sanitized = String(userAnswer).replace(/[^0-9+\-*/\s()]/g, "");
            const result = Function(`"use strict"; return (${sanitized})`)();
            isCorrect = Math.abs(Number(result) - Number(t.targetValue)) < 0.001;
          } catch {
            isCorrect = false;
          }
        }
        break;
      case "MULTIPLE_CHOICE_3":
      case "MULTIPLE_CHOICE_4":
        isCorrect = String(userAnswer) === t.correctAnswers[0];
        break;
    }

    res.json({
      isCorrect,
      correctAnswers: t.correctAnswers,
      explanation: t.explanation,
    });
  } catch (error) {
    console.error("Validate answer error:", error);
    res.status(500).json({ error: "Failed to validate answer" });
  }
});

// Serve image via route (back-compat)
router.get("/images/:filename", (req: Request, res: Response) => {
  try {
    const file = path.join(uploadDir, req.params.filename);
    if (!fs.existsSync(file)) return res.status(404).json({ error: "Image not found" });
    res.sendFile(file);
  } catch (error) {
    console.error("Serve image error:", error);
    res.status(500).json({ error: "Failed to serve image" });
  }
});

export default router;

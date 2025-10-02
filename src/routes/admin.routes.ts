/** @format */

import { Router } from "express";
import { prisma } from "../prisma";
import { authenticateToken, adminOnly } from "../middlewares/security";
import multer from "multer";
import { z } from "zod";
import fileService from "../services/fileService";
import { questionTypes } from "../config/questionTypes";

const router = Router();

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type. Only JPEG, PNG, WebP and GIF are allowed"));
    }
  },
});

// Validation schemas
const questionSchema = z.object({
  category: z.enum(["HEALTH", "COGNITION", "DIGITAL", "FINANCE"]),
  type: z.enum([
    "MISSING_NUTRIENT",
    "NUTRIENT_FROM_IMAGE",
    "DISEASE_FROM_IMAGE",
    "ILLEGAL_TEXT",
    "ODD_ONE_OUT",
    "APP_IDENTITY",
    "SCAM_TEXT",
    "DONT_SHARE",
    "ARITHMETIC_TARGET",
    "MAX_VALUE_STACK",
  ]),
  inputType: z.enum(["TEXT", "MULTIPLE_CHOICE_4", "MULTIPLE_CHOICE_3", "CALCULATION"]),
  difficulty: z.number().min(1).max(5),
  translations: z.object({
    th: z.object({
      questionText: z.string().min(1),
      options: z.array(z.string()),
      correctAnswers: z.array(z.string()).min(1),
      targetValue: z.number().nullable().optional(),
      explanation: z.string().optional(),
    }),
    en: z.object({
      questionText: z.string().min(1),
      options: z.array(z.string()),
      correctAnswers: z.array(z.string()).min(1),
      targetValue: z.number().nullable().optional(),
      explanation: z.string().optional(),
    }),
  }),
});

// Initialize GridFS when server starts
export const initializeFileService = async () => {
  const mongoUri = process.env.DATABASE_URL || "";
  const dbName = process.env.DB_NAME || "quiz-game";
  await fileService.initialize(mongoUri, dbName);
};

// Get admin statistics
router.get("/stats", authenticateToken, adminOnly, async (req, res) => {
  try {
    const [totalQuestions, activeQuestions, categoryStats, totalUsers, totalGames, storageStats] =
      await Promise.all([
        prisma.question.count(),
        prisma.question.count({ where: { isActive: true } }),
        prisma.question.groupBy({
          by: ["category"],
          _count: true,
        }),
        // ⭐ นับผู้ใช้จริง
        prisma.user.count({ where: { isActive: true } }),
        // ⭐ นับเกมที่เล่นจริง
        prisma.gameResult.count({ where: { isCompleted: true } }),
        fileService.getStorageStats(),
      ]);

    // ⭐ คำนวณคะแนนเฉลี่ยจริง
    const avgScoreResult = await prisma.gameResult.aggregate({
      where: { isCompleted: true },
      _avg: { score: true },
    });

    const stats = {
      totalQuestions,
      activeQuestions,
      categories: categoryStats.reduce((acc, cat) => {
        acc[cat.category] = cat._count;
        return acc;
      }, {} as any),
      totalUsers,
      totalGames,
      avgScore: Math.round(avgScoreResult._avg.score || 0),
      storage: {
        totalFiles: storageStats.totalFiles,
        totalSize: storageStats.totalSize,
        totalSizeMB: (storageStats.totalSize / (1024 * 1024)).toFixed(2),
      },
    };

    res.json(stats);
  } catch (error) {
    console.error("Stats error:", error);
    res.status(500).json({ error: "Failed to load statistics" });
  }
});

// Get questions with filters
router.get("/questions", authenticateToken, adminOnly, async (req, res) => {
  try {
    const { category, search, page = 1, limit = 50 } = req.query;

    const where: any = {};

    if (category) {
      where.category = category;
    }

    if (search) {
      where.translations = {
        some: {
          OR: [
            { questionText: { contains: search as string, mode: "insensitive" } },
            { explanation: { contains: search as string, mode: "insensitive" } },
          ],
        },
      };
    }

    const skip = (Number(page) - 1) * Number(limit);

    const [questions, total] = await Promise.all([
      prisma.question.findMany({
        where,
        include: {
          translations: true,
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: Number(limit),
      }),
      prisma.question.count({ where }),
    ]);

    // Transform imageUrl to full URL if exists
    const questionsWithImageUrls = questions.map((q) => ({
      ...q,
      translations: q.translations.map((t) => ({
        ...t,
        imageUrl: t.imageUrl ? `/api/admin/images/${t.imageUrl}` : null,
      })),
    }));

    res.json({
      questions: questionsWithImageUrls,
      total,
      page: Number(page),
      totalPages: Math.ceil(total / Number(limit)),
    });
  } catch (error) {
    console.error("Get questions error:", error);
    res.status(500).json({ error: "Failed to load questions" });
  }
});

// Create new question
router.post("/questions", authenticateToken, adminOnly, upload.single("image"), async (req, res) => {
  try {
    const { category, type, inputType, difficulty, translations } = req.body;

    // Parse translations if it's a string (from FormData)
    const translationsData = typeof translations === "string" ? JSON.parse(translations) : translations;

    // Validate input
    const validatedData = questionSchema.parse({
      category,
      type,
      inputType,
      difficulty: Number(difficulty),
      translations: translationsData,
    });

    // Upload image to GridFS if provided
    let imageFileId = null;
    if (req.file) {
      const uploadResult = await fileService.uploadImage(req.file, {
        category: validatedData.category,
        uploadedBy: req.user?.username,
      });
      imageFileId = uploadResult.fileId;
    }

    // Create question with translations
    const question = await prisma.question.create({
      data: {
        category: validatedData.category,
        type: validatedData.type,
        inputType: validatedData.inputType,
        difficulty: validatedData.difficulty,
        isActive: true,
        translations: {
          create: [
            {
              lang: "th",
              questionText: validatedData.translations.th.questionText,
              options: validatedData.translations.th.options,
              correctAnswers: validatedData.translations.th.correctAnswers,
              targetValue: validatedData.translations.th.targetValue || null,
              explanation: validatedData.translations.th.explanation || "",
              imageUrl: imageFileId,
            },
            {
              lang: "en",
              questionText: validatedData.translations.en.questionText,
              options: validatedData.translations.en.options,
              correctAnswers: validatedData.translations.en.correctAnswers,
              targetValue: validatedData.translations.en.targetValue || null,
              explanation: validatedData.translations.en.explanation || "",
              imageUrl: imageFileId,
            },
          ],
        },
      },
      include: {
        translations: true,
      },
    });

    // Update image metadata with question ID
    if (imageFileId) {
      await fileService.updateImageMetadata(imageFileId, {
        questionId: question.id,
        category: question.category,
        uploadedBy: req.user?.username,
        uploadedAt: new Date(),
      });
    }

    res.status(201).json({
      message: "Question created successfully",
      question,
    });
  } catch (error) {
    console.error("Create question error:", error);

    if (error instanceof z.ZodError) {
      return res.status(400).json({
        error: "Validation failed",
        details: error.errors,
      });
    }

    res.status(500).json({ error: "Failed to create question" });
  }
});

// Update question
router.put("/questions/:id", authenticateToken, adminOnly, upload.single("image"), async (req, res) => {
  try {
    const { id } = req.params;
    const { category, type, inputType, difficulty, translations } = req.body;

    // Parse translations if it's a string
    const translationsData = typeof translations === "string" ? JSON.parse(translations) : translations;

    // Validate input
    const validatedData = questionSchema.parse({
      category,
      type,
      inputType,
      difficulty: Number(difficulty),
      translations: translationsData,
    });

    // Check if question exists
    const existingQuestion = await prisma.question.findUnique({
      where: { id },
      include: { translations: true },
    });

    if (!existingQuestion) {
      return res.status(404).json({ error: "Question not found" });
    }

    // Handle image update
    let imageFileId = existingQuestion.translations[0]?.imageUrl;

    if (req.file) {
      // Upload new image
      const uploadResult = await fileService.uploadImage(req.file, {
        category: validatedData.category,
        questionId: id,
        uploadedBy: req.user?.username,
      });

      // Delete old image if exists
      if (imageFileId) {
        await fileService.deleteImage(imageFileId);
      }

      imageFileId = uploadResult.fileId;
    }

    // Update question
    const updatedQuestion = await prisma.question.update({
      where: { id },
      data: {
        category: validatedData.category,
        type: validatedData.type,
        inputType: validatedData.inputType,
        difficulty: validatedData.difficulty,
      },
    });

    // Update translations
    for (const lang of ["th", "en"] as const) {
      const translationData = validatedData.translations[lang];

      await prisma.questionTranslation.upsert({
        where: {
          questionId_lang: {
            questionId: id,
            lang,
          },
        },
        update: {
          questionText: translationData.questionText,
          options: translationData.options,
          correctAnswers: translationData.correctAnswers,
          targetValue: translationData.targetValue || null,
          explanation: translationData.explanation || "",
          imageUrl: imageFileId,
        },
        create: {
          questionId: id,
          lang,
          questionText: translationData.questionText,
          options: translationData.options,
          correctAnswers: translationData.correctAnswers,
          targetValue: translationData.targetValue || null,
          explanation: translationData.explanation || "",
          imageUrl: imageFileId,
        },
      });
    }

    // Get updated question with translations
    const finalQuestion = await prisma.question.findUnique({
      where: { id },
      include: { translations: true },
    });

    res.json({
      message: "Question updated successfully",
      question: finalQuestion,
    });
  } catch (error) {
    console.error("Update question error:", error);

    if (error instanceof z.ZodError) {
      return res.status(400).json({
        error: "Validation failed",
        details: error.errors,
      });
    }

    res.status(500).json({ error: "Failed to update question" });
  }
});

// Delete question
router.delete("/questions/:id", authenticateToken, adminOnly, async (req, res) => {
  try {
    const { id } = req.params;

    // Get question with translations to delete image
    const question = await prisma.question.findUnique({
      where: { id },
      include: { translations: true },
    });

    if (!question) {
      return res.status(404).json({ error: "Question not found" });
    }

    // Delete image from GridFS if exists
    const imageFileId = question.translations[0]?.imageUrl;
    if (imageFileId) {
      await fileService.deleteImage(imageFileId);
    }

    // Delete question (cascades to translations)
    await prisma.question.delete({
      where: { id },
    });

    res.json({ message: "Question deleted successfully" });
  } catch (error) {
    console.error("Delete question error:", error);
    res.status(500).json({ error: "Failed to delete question" });
  }
});

// *** à¸ªà¸³à¸„à¸±à¸: à¹à¸à¹‰à¹„à¸‚à¸ªà¹ˆà¸§à¸™à¸™à¸µà¹‰à¹ƒà¸«à¹‰à¸ªà¹ˆà¸‡ image à¸à¸¥à¸±à¸šà¸­à¸¢à¹ˆà¸²à¸‡à¸–à¸¹à¸à¸•à¹‰à¸­à¸‡ ***
// Get image from GridFS - PUBLIC ACCESS (à¹„à¸¡à¹ˆà¸•à¹‰à¸­à¸‡ auth à¸ªà¸³à¸«à¸£à¸±à¸šà¸”à¸¹à¸£à¸¹à¸›)
router.get("/images/:fileId", async (req, res) => {
  try {
    const { fileId } = req.params;

    console.log("Fetching image with ID:", fileId);

    const exists = await fileService.fileExists(fileId);
    if (!exists) {
      console.log("Image not found:", fileId);
      return res.status(404).json({ error: "Image not found" });
    }

    // à¹ƒà¸Šà¹‰ stream method à¹à¸—à¸™ download method
    const stream = fileService.getImageStream(fileId);
    const metadata = await fileService.getImageMetadata(fileId);

    // Set proper headers
    res.set({
      "Content-Type": metadata.contentType || "image/jpeg",
      "Cache-Control": "public, max-age=86400", // cache 1 day
      // à¹€à¸›à¸¥à¸µà¹ˆà¸¢à¸™à¹€à¸›à¹‡à¸™ inline à¹€à¸žà¸·à¹ˆà¸­à¹ƒà¸«à¹‰à¹à¸ªà¸”à¸‡à¹ƒà¸™à¸šà¸£à¸²à¸§à¹€à¸‹à¸­à¸£à¹Œ
      "Content-Disposition": `inline; filename="${metadata.filename}"`,
      // à¹€à¸žà¸´à¹ˆà¸¡ CORS headers
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    });

    // Pipe stream to response
    stream.on("error", (error) => {
      console.error("Stream error:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to stream image" });
      }
    });

    stream.pipe(res);
  } catch (error) {
    console.error("Get image error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to retrieve image" });
    }
  }
});

// Bulk import questions
router.post("/questions/bulk", authenticateToken, adminOnly, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const fileContent = req.file.buffer.toString("utf-8");
    const data = JSON.parse(fileContent);

    if (!data.questions || !Array.isArray(data.questions)) {
      return res.status(400).json({ error: "Invalid file format" });
    }

    const results = {
      success: 0,
      failed: 0,
      errors: [] as any[],
    };

    // Process each question
    for (const questionData of data.questions) {
      try {
        // Auto-detect inputType based on question type
        const questionTypeConfig = questionTypes[questionData.category]?.find(
          (qt) => qt.id === questionData.type
        );

        const inputType = questionTypeConfig?.inputType || "TEXT";

        const validatedData = questionSchema.parse({
          ...questionData,
          inputType,
        });

        await prisma.question.create({
          data: {
            category: validatedData.category,
            type: validatedData.type,
            inputType: validatedData.inputType,
            difficulty: validatedData.difficulty,
            isActive: true,
            translations: {
              create: [
                {
                  lang: "th",
                  questionText: validatedData.translations.th.questionText,
                  options: validatedData.translations.th.options,
                  correctAnswers: validatedData.translations.th.correctAnswers,
                  targetValue: validatedData.translations.th.targetValue || null,
                  explanation: validatedData.translations.th.explanation || "",
                },
                {
                  lang: "en",
                  questionText: validatedData.translations.en.questionText,
                  options: validatedData.translations.en.options,
                  correctAnswers: validatedData.translations.en.correctAnswers,
                  targetValue: validatedData.translations.en.targetValue || null,
                  explanation: validatedData.translations.en.explanation || "",
                },
              ],
            },
          },
        });

        results.success++;
      } catch (error) {
        results.failed++;
        results.errors.push({
          question: questionData.translations?.th?.questionText || "Unknown",
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    res.json({
      message: `Bulk import completed. Success: ${results.success}, Failed: ${results.failed}`,
      results,
    });
  } catch (error) {
    console.error("Bulk import error:", error);
    res.status(500).json({ error: "Failed to import questions" });
  }
});

export default router;

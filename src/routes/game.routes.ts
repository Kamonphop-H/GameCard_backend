/** @format */

import { Router } from "express";
import { prisma } from "../prisma";
import { requireAuth } from "../middlewares/security";
import { Category, Lang } from "@prisma/client";

const router = Router();

const CATEGORY_LIST: Category[] = ["HEALTH", "COGNITION", "DIGITAL", "FINANCE"];

function shuffleArray<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function sampleArray<T>(arr: T[], n: number): T[] {
  return shuffleArray(arr).slice(0, Math.min(n, arr.length));
}

async function fetchQuestionsOfCategory(cat: Category, count: number, lang: Lang) {
  const qs = await prisma.question.findMany({
    where: { category: cat, isActive: true },
    select: {
      id: true,
      category: true,
      difficulty: true,
      inputType: true,
      type: true,
      translations: {
        where: { lang },
        select: {
          questionText: true,
          options: true,
          correctAnswers: true,
          explanation: true,
          imageUrl: true,
          targetValue: true,
        },
      },
    },
  });

  const normalized = qs.map((q) => {
    const t = q.translations[0];

    // ⭐ กรองตัวเลือกที่ไม่ว่าง
    const filteredOptions = (t?.options || []).filter((opt) => opt && opt.trim() !== "");

    return {
      id: q.id,
      category: q.category,
      type: q.type,
      inputType: q.inputType,
      question: t?.questionText || "—",
      options: filteredOptions, // ใช้ตัวเลือกที่กรองแล้ว
      correctAnswer: (t?.correctAnswers?.[0] || "").toString(),
      correctAnswers: t?.correctAnswers || [],
      targetValue: t?.targetValue || null,
      explanation: t?.explanation || "",
      imageUrl: t?.imageUrl ? `/api/admin/images/${t.imageUrl}` : "",
      difficulty: q.difficulty >= 3 ? "HARD" : q.difficulty === 2 ? "MEDIUM" : "EASY",
    };
  });

  return sampleArray(normalized, count);
}

// ⭐ เริ่มเกม - เล่นแบบ MIXED เท่านั้น (40 คำถาม)
router.post("/start", requireAuth, async (req, res) => {
  try {
    const { lang } = req.body || {};
    const selectedLang = (lang || req.auth!.lang || "th") as Lang;
    const userId = req.auth!.userId;

    // ดึงคำถามแต่ละหมวด 10 ข้อ
    const questionList: any[] = [];

    for (const cat of CATEGORY_LIST) {
      const questions = await fetchQuestionsOfCategory(cat, 10, selectedLang);
      questionList.push(...questions);
    }

    // สลับลำดับคำถามทั้งหมด
    const shuffledQuestions = shuffleArray(questionList);

    // สร้าง GameResult
    const result = await prisma.gameResult.create({
      data: {
        userId,
        category: "HEALTH", // ใช้ default category (ไม่มีผลต่อการคำนวณ)
        score: 0,
        totalQuestions: shuffledQuestions.length,
        correctAnswers: 0,
        timeSpent: 0,
        isCompleted: false,
      },
    });

    res.json({
      sessionId: result.id,
      category: "MIXED",
      questions: shuffledQuestions,
    });
  } catch (error) {
    console.error("Start game error:", error);
    res.status(500).json({ error: "Failed to start game" });
  }
});

// ⭐ จบเกม - คำนวณคะแนนและความชำนาญ
router.post("/complete", requireAuth, async (req, res) => {
  try {
    const { sessionId, answers = [] } = req.body || {};
    const userId = req.auth!.userId;

    const result = await prisma.gameResult.findUnique({
      where: { id: sessionId },
    });

    if (!result || result.userId !== userId) {
      return res.status(404).json({ error: "ไม่พบเซสชันเกม" });
    }

    // ดึงข้อมูลคำถาม
    const qIds = answers.map((a: any) => a.id).filter(Boolean);
    const questions = await prisma.question.findMany({
      where: { id: { in: qIds } },
      select: {
        id: true,
        category: true,
        difficulty: true,
        inputType: true,
        translations: {
          select: {
            correctAnswers: true,
            targetValue: true,
          },
        },
      },
    });

    const qMap = new Map(questions.map((q) => [q.id, q]));

    let totalCorrect = 0;
    let serverScore = 0;
    const toCreateGQ: any[] = [];

    // ตรวจคำตอบและเก็บสถิติแยกตามหมวด
    const categoryStats: Record<Category, { correct: number; total: number }> = {
      HEALTH: { correct: 0, total: 0 },
      COGNITION: { correct: 0, total: 0 },
      DIGITAL: { correct: 0, total: 0 },
      FINANCE: { correct: 0, total: 0 },
    };

    for (const a of answers) {
      const q = qMap.get(a.id);
      if (!q) continue;

      const category = q.category as Category;
      categoryStats[category].total += 1;

      const corrList = (q.translations?.[0]?.correctAnswers || []).map((s: any) =>
        String(s).trim().toLowerCase()
      );

      let chosen = String(a.chosen ?? "")
        .trim()
        .toLowerCase();
      let isCorrect = false;

      // ตรวจคำตอบ
      if (q.inputType === "CALCULATION") {
        try {
          const targetValue = q.translations?.[0]?.targetValue;
          if (targetValue !== null && targetValue !== undefined) {
            const sanitized = chosen.replace(/[^0-9+\-*/\s()]/g, "");
            const calculatedResult = Function(`"use strict"; return (${sanitized})`)();
            isCorrect = Math.abs(calculatedResult - targetValue) < 0.001;
          }
        } catch {
          isCorrect = false;
        }
      } else {
        isCorrect = chosen && corrList.includes(chosen);
      }

      if (isCorrect) {
        totalCorrect += 1;
        categoryStats[category].correct += 1;

        // คำนวณคะแนน
        const baseScore = q.difficulty >= 3 ? 30 : q.difficulty === 2 ? 20 : 10;
        serverScore += baseScore;
      }

      toCreateGQ.push({
        gameResultId: result.id,
        questionId: q.id,
        userAnswer: a.chosen ?? "",
        isCorrect,
        timeSpent: Number(a.timeSpent ?? 0),
      });
    }

    // ⭐ คำนวณความชำนาญแต่ละหมวดจากเกมนี้
    const calculateMastery = (stats: { correct: number; total: number }) => {
      return stats.total > 0 ? Math.round((stats.correct / stats.total) * 100) : 0;
    };

    const masteryScores = {
      healthMastery: calculateMastery(categoryStats.HEALTH),
      cognitionMastery: calculateMastery(categoryStats.COGNITION),
      digitalMastery: calculateMastery(categoryStats.DIGITAL),
      financeMastery: calculateMastery(categoryStats.FINANCE),
    };

    // บันทึกข้อมูลลง Database
    await prisma.$transaction(async (tx) => {
      // บันทึกคำตอบ
      await tx.gameQuestion.createMany({ data: toCreateGQ });

      // อัพเดท GameResult
      await tx.gameResult.update({
        where: { id: result.id },
        data: {
          score: serverScore,
          correctAnswers: totalCorrect,
          totalQuestions: answers.length,
          isCompleted: true,
          completedAt: new Date(),
        },
      });

      // อัพเดท Profile
      await tx.profile.update({
        where: { userId },
        data: {
          totalScore: { increment: serverScore },
          gamesPlayed: { increment: 1 },
          ...masteryScores, // อัพเดทความชำนาญจากเกมนี้
        },
      });
    });

    res.json({
      ok: true,
      serverScore,
      correct: totalCorrect,
      masteryScores, // ส่งกลับไปแสดงผล
      categoryStats, // ส่งสถิติแต่ละหมวด
      message: "บันทึกคะแนนสำเร็จ",
    });
  } catch (error) {
    console.error("Complete game error:", error);
    res.status(500).json({
      error: "เกิดข้อผิดพลาดในการบันทึกคะแนน",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// เก็บ endpoint session ไว้
router.get("/session/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const gr = await prisma.gameResult.findUnique({
      where: { id },
      include: {
        gameQuestions: {
          include: {
            question: {
              select: {
                category: true,
                difficulty: true,
                translations: true,
              },
            },
          },
        },
      },
    });

    if (!gr || gr.userId !== req.auth!.userId) {
      return res.status(404).json({ ok: false });
    }

    const questions = gr.gameQuestions.map((gq) => {
      const t = gq.question.translations[0];
      return {
        id: gq.questionId,
        question: t?.questionText || "—",
        correctAnswer: (t?.correctAnswers?.[0] ?? "").toString(),
        explanation: t?.explanation || "",
        imageUrl: t?.imageUrl ? `/api/admin/images/${t.imageUrl}` : "",
        isCorrect: gq.isCorrect,
      };
    });

    res.json({
      sessionId: gr.id,
      score: gr.score,
      correctAnswers: gr.correctAnswers,
      totalQuestions: gr.totalQuestions,
      category: "MIXED",
      masteryPercent: gr.totalQuestions ? (gr.correctAnswers / gr.totalQuestions) * 100 : 0,
      questions,
    });
  } catch (error) {
    console.error("Get session error:", error);
    res.status(500).json({ error: "Failed to get session" });
  }
});

export default router;

// ===== user.routes.ts - ลบ hasPlayedMixed =====

/** @format */

import { Router } from "express";
import { prisma } from "../prisma";
import { requireAuth } from "../middlewares/security";
import { Category, Lang } from "@prisma/client";

const router = Router();

const CATEGORY_LIST: Category[] = ["HEALTH", "COGNITION", "DIGITAL", "FINANCE"];
const diffLabel = (n: number) => (n >= 3 ? "HARD" : n === 2 ? "MEDIUM" : "EASY");

function sampleArray<T>(arr: T[], n: number) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, Math.max(0, Math.min(n, a.length)));
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
    return {
      id: q.id,
      category: q.category,
      type: q.type,
      inputType: q.inputType,
      question: t?.questionText || "—",
      options: t?.options || [],
      correctAnswer: (t?.correctAnswers?.[0] || "").toString(),
      correctAnswers: t?.correctAnswers || [],
      targetValue: t?.targetValue || null,
      explanation: t?.explanation || "",
      imageUrl: t?.imageUrl ? `/api/admin/images/${t.imageUrl}` : "",
      difficulty: diffLabel(q.difficulty),
    };
  });

  return sampleArray(normalized, count);
}

router.post("/start", requireAuth, async (req, res) => {
  try {
    const { category = "MIXED", questionCount = 10, lang } = req.body || {};
    const selectedLang = (lang || req.auth!.lang || "th") as Lang;
    const userId = req.auth!.userId;

    let questionList: any[] = [];

    if (category === "MIXED") {
      for (const c of CATEGORY_LIST) {
        const part = await fetchQuestionsOfCategory(c, 10, selectedLang);
        questionList.push(...part);
      }
      questionList = sampleArray(questionList, questionList.length);
    } else {
      if (!CATEGORY_LIST.includes(category)) {
        return res.status(400).json({ ok: false, error: "INVALID_CATEGORY" });
      }
      questionList = await fetchQuestionsOfCategory(category, Number(questionCount) || 10, selectedLang);
    }

    const result = await prisma.gameResult.create({
      data: {
        userId,
        category: CATEGORY_LIST.includes(category) ? category : "HEALTH",
        score: 0,
        totalQuestions: questionList.length,
        correctAnswers: 0,
        timeSpent: 0,
        isCompleted: false,
      },
    });

    res.json({ sessionId: result.id, category, questions: questionList });
  } catch (error) {
    console.error("Start game error:", error);
    res.status(500).json({ error: "Failed to start game" });
  }
});

router.post("/complete", requireAuth, async (req, res) => {
  try {
    const { sessionId, answers = [], category } = req.body || {};
    const userId = req.auth!.userId;

    const result = await prisma.gameResult.findUnique({
      where: { id: sessionId },
    });

    if (!result || result.userId !== userId) {
      return res.status(404).json({
        ok: false,
        error: "ไม่พบเซสชันเกม",
      });
    }

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
            lang: true,
            correctAnswers: true,
            targetValue: true,
          },
        },
      },
    });

    const qMap = new Map(questions.map((q) => [q.id, q]));

    let correct = 0;
    let serverScore = 0;
    const toCreateGQ: any[] = [];

    const makeBase = (d: number) => (d >= 3 ? 30 : d === 2 ? 20 : 10);

    for (const a of answers) {
      const q = qMap.get(a.id);
      if (!q) continue;

      const corrList = (q.translations?.[0]?.correctAnswers || []).map((s: any) =>
        String(s).trim().toLowerCase()
      );

      let chosen = String(a.chosen ?? "")
        .trim()
        .toLowerCase();
      let isCorrect = false;

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
        correct += 1;
        serverScore += makeBase(q.difficulty);
      }

      toCreateGQ.push({
        gameResultId: result.id,
        questionId: q.id,
        userAnswer: a.chosen ?? "",
        isCorrect,
        timeSpent: Number(a.timeSpent ?? 0),
      });
    }

    await prisma.$transaction(async (tx) => {
      await tx.gameQuestion.createMany({ data: toCreateGQ });
      await tx.gameResult.update({
        where: { id: result.id },
        data: {
          score: serverScore,
          correctAnswers: correct,
          totalQuestions: answers.length,
          isCompleted: true,
          completedAt: new Date(),
        },
      });

      await tx.profile.update({
        where: { userId },
        data: {
          totalScore: { increment: serverScore },
          gamesPlayed: { increment: 1 },
        },
      });
    });

    const allAnswers = await prisma.gameQuestion.findMany({
      where: {
        gameResult: {
          userId,
          isCompleted: true,
        },
      },
      select: {
        isCorrect: true,
        question: { select: { category: true } },
      },
    });

    const acc = {
      HEALTH: { correct: 0, total: 0 },
      COGNITION: { correct: 0, total: 0 },
      DIGITAL: { correct: 0, total: 0 },
      FINANCE: { correct: 0, total: 0 },
    } as Record<Category, { correct: number; total: number }>;

    for (const x of allAnswers) {
      const c = x.question.category;
      acc[c].total += 1;
      if (x.isCorrect) acc[c].correct += 1;
    }

    const pct = (x: { correct: number; total: number }) =>
      x.total ? Math.round((x.correct / x.total) * 100) : 0;

    await prisma.profile.update({
      where: { userId },
      data: {
        healthMastery: pct(acc.HEALTH),
        cognitionMastery: pct(acc.COGNITION),
        digitalMastery: pct(acc.DIGITAL),
        financeMastery: pct(acc.FINANCE),
      },
    });

    if (category === "MIXED") {
      await prisma.achievement.upsert({
        where: {
          userId_type_category: {
            userId,
            type: "MIXED_UNLOCK",
            category: null,
          },
        },
        update: {
          isCompleted: true,
          unlockedAt: new Date(),
        },
        create: {
          userId,
          type: "MIXED_UNLOCK",
          isCompleted: true,
        },
      });
    }

    res.json({
      ok: true,
      serverScore,
      correct,
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

    const distinctCats = new Set(gr.gameQuestions.map((gq) => gq.question.category));
    const category = distinctCats.size > 1 ? "MIXED" : Array.from(distinctCats)[0];

    res.json({
      sessionId: gr.id,
      score: gr.score,
      correctAnswers: gr.correctAnswers,
      totalQuestions: gr.totalQuestions,
      category,
      masteryPercent: gr.totalQuestions ? (gr.correctAnswers / gr.totalQuestions) * 100 : 0,
      questions,
    });
  } catch (error) {
    console.error("Get session error:", error);
    res.status(500).json({ error: "Failed to get session" });
  }
});

export default router;

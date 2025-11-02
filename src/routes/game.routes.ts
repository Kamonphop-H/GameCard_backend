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
          hint1: true,
          hint2: true,
          hint3: true,
        },
      },
    },
  });

  const normalized = qs.map((q) => {
    const t = q.translations[0];
    const allOptions = t?.options || [];

    return {
      id: q.id,
      category: q.category,
      type: q.type,
      inputType: q.inputType,
      question: t?.questionText || "—",
      options: allOptions,
      correctAnswer: (t?.correctAnswers?.[0] || "").toString(),
      correctAnswers: t?.correctAnswers || [],
      targetValue: t?.targetValue || null,
      explanation: t?.explanation || "",
      imageUrl: t?.imageUrl ? `/api/admin/images/${t.imageUrl}` : "",
      difficulty: q.difficulty >= 3 ? "HARD" : q.difficulty === 2 ? "MEDIUM" : "EASY",
      hints: {
        hint1: t?.hint1 || null,
        hint2: t?.hint2 || null,
        hint3: t?.hint3 || null,
      },
    };
  });

  return sampleArray(normalized, count);
}

// 🔥 FIX: เช็คว่าเป็น anonymous ก่อน
function isAnonymous(userId: string): boolean {
  return userId.startsWith("anon_");
}

// บันทึกการใช้คำใบ้
router.post("/hint/use", requireAuth, async (req, res) => {
  try {
    const { questionId, hintLevel } = req.body;
    const userId = req.auth!.userId;

    // 🔥 FIX: Anonymous ไม่บันทึกการใช้ hint
    if (isAnonymous(userId)) {
      return res.json({ success: true, message: "Anonymous mode - hint not saved" });
    }

    await prisma.hintUsage.create({
      data: {
        userId,
        questionId,
        hintLevel: Number(hintLevel),
      },
    });

    await prisma.profile.update({
      where: { userId },
      data: {
        totalHintsUsed: { increment: 1 },
      },
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Hint usage error:", error);
    res.status(500).json({ error: "Failed to record hint usage" });
  }
});

// เริ่มเกมใหม่
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

    // 🔥 FIX: Anonymous ไม่สร้าง GameResult
    if (isAnonymous(userId)) {
      console.log("🎮 Anonymous game started - no session saved");
      return res.json({
        sessionId: null, // ไม่มี session
        category: "MIXED",
        questions: shuffledQuestions,
        isAnonymous: true,
      });
    }

    // สร้าง GameResult (ยังไม่ complete)
    const result = await prisma.gameResult.create({
      data: {
        userId,
        category: "HEALTH",
        score: 0,
        totalQuestions: shuffledQuestions.length,
        correctAnswers: 0,
        timeSpent: 0,
        isCompleted: false,
      },
    });

    console.log("📊 Questions per category:", {
      HEALTH: shuffledQuestions.filter((q) => q.category === "HEALTH").length,
      COGNITION: shuffledQuestions.filter((q) => q.category === "COGNITION").length,
      DIGITAL: shuffledQuestions.filter((q) => q.category === "DIGITAL").length,
      FINANCE: shuffledQuestions.filter((q) => q.category === "FINANCE").length,
    });

    res.json({
      sessionId: result.id,
      category: "MIXED",
      questions: shuffledQuestions,
      isAnonymous: false,
    });
  } catch (error) {
    console.error("Start game error:", error);
    res.status(500).json({ error: "Failed to start game" });
  }
});

// 🎯 จบเกม - บันทึกคะแนนและความชำนาญ (ใช้ค่าปัจจุบันโดยตรง)
router.post("/complete", requireAuth, async (req, res) => {
  try {
    const { sessionId, answers = [], finalScore, finalCorrect, categoryStats } = req.body || {};
    const userId = req.auth!.userId;

    console.log("🎮 Game completion started:", {
      sessionId,
      userId,
      answersReceived: answers.length,
      finalScore,
      finalCorrect,
      categoryStats,
      isAnonymous: isAnonymous(userId),
    });

    // 🔥 FIX: Anonymous ไม่บันทึกผล
    if (isAnonymous(userId)) {
      console.log("✅ Anonymous game completed - no data saved");
      return res.json({
        ok: true,
        message: "Anonymous mode - results not saved",
        savedScore: finalScore,
        savedCorrect: finalCorrect,
        categoryStats,
        isAnonymous: true,
      });
    }

    // ตรวจสอบว่ามี GameResult หรือไม่
    if (!sessionId) {
      return res.status(400).json({ error: "Session ID required" });
    }

    const result = await prisma.gameResult.findUnique({
      where: { id: sessionId },
    });

    if (!result || result.userId !== userId) {
      return res.status(404).json({ error: "ไม่พบเซสชันเกม" });
    }

    // สร้างข้อมูล GameQuestion สำหรับบันทึก
    const toCreateGQ: any[] = [];

    for (const a of answers) {
      toCreateGQ.push({
        gameResultId: result.id,
        questionId: a.id,
        userAnswer: String(a.chosen || ""),
        isCorrect: Boolean(a.isCorrect),
        timeSpent: Number(a.timeSpent || 0),
      });
    }

    // ⭐ คำนวณ % ความชำนาญจากเกมนี้โดยตรง (ไม่เอาข้อมูลเก่ามาหาค่าเฉลี่ย)
    const calculateMastery = (stats: { correct: number; total: number }) => {
      return stats.total > 0 ? Math.round((stats.correct / stats.total) * 100) : 0;
    };

    const newMasteryScores = {
      healthMastery: calculateMastery(categoryStats?.HEALTH || { correct: 0, total: 0 }),
      cognitionMastery: calculateMastery(categoryStats?.COGNITION || { correct: 0, total: 0 }),
      digitalMastery: calculateMastery(categoryStats?.DIGITAL || { correct: 0, total: 0 }),
      financeMastery: calculateMastery(categoryStats?.FINANCE || { correct: 0, total: 0 }),
    };

    console.log("🎯 Current game mastery (will be saved directly):", newMasteryScores);

    // บันทึกทุกอย่างใน Transaction
    await prisma.$transaction(async (tx) => {
      // 1. บันทึก GameQuestion
      if (toCreateGQ.length > 0) {
        await tx.gameQuestion.createMany({ data: toCreateGQ });
      }

      // 2. อัพเดท GameResult
      await tx.gameResult.update({
        where: { id: result.id },
        data: {
          score: finalScore,
          correctAnswers: finalCorrect,
          totalQuestions: answers.length,
          isCompleted: true,
          completedAt: new Date(),
        },
      });

      // 3. ⭐ อัพเดท Profile - ใช้ค่าปัจจุบันโดยตรง (ไม่หาค่าเฉลี่ย)
      await tx.profile.update({
        where: { userId },
        data: {
          totalScore: { increment: finalScore },
          gamesPlayed: { increment: 1 },
          healthMastery: newMasteryScores.healthMastery, // ⭐ เขียนทับค่าเดิม
          cognitionMastery: newMasteryScores.cognitionMastery, // ⭐ เขียนทับค่าเดิม
          digitalMastery: newMasteryScores.digitalMastery, // ⭐ เขียนทับค่าเดิม
          financeMastery: newMasteryScores.financeMastery, // ⭐ เขียนทับค่าเดิม
        },
      });
    });

    // ⭐ ดึงข้อมูล Profile ที่อัพเดทแล้ว
    const updatedProfile = await prisma.profile.findUnique({
      where: { userId },
      select: {
        totalScore: true,
        gamesPlayed: true,
        healthMastery: true,
        cognitionMastery: true,
        digitalMastery: true,
        financeMastery: true,
        totalHintsUsed: true,
        displayName: true,
      },
    });

    console.log("✅ Game saved successfully!");
    console.log("📊 Updated Profile:", updatedProfile);

    res.json({
      ok: true,
      message: "บันทึกคะแนนสำเร็จ",
      savedScore: finalScore,
      savedCorrect: finalCorrect,
      categoryStats,
      currentGameMastery: newMasteryScores,
      isAnonymous: false,
      // ⭐ ส่งข้อมูล Profile ที่อัพเดทแล้วกลับไป
      updatedProfile: {
        totalScore: updatedProfile?.totalScore || 0,
        gamesPlayed: updatedProfile?.gamesPlayed || 0,
        healthMastery: updatedProfile?.healthMastery || 0,
        cognitionMastery: updatedProfile?.cognitionMastery || 0,
        digitalMastery: updatedProfile?.digitalMastery || 0,
        financeMastery: updatedProfile?.financeMastery || 0,
      },
    });
  } catch (error) {
    console.error("❌ Complete game error:", error);
    res.status(500).json({
      error: "เกิดข้อผิดพลาดในการบันทึกคะแนน",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// ดึงข้อมูล Profile ของผู้เล่น (สำหรับ Dashboard)
router.get("/profile", requireAuth, async (req, res) => {
  try {
    const userId = req.auth!.userId;

    // 🔥 FIX: Anonymous ไม่มี profile
    if (isAnonymous(userId)) {
      return res.json({
        ok: true,
        profile: {
          totalScore: 0,
          gamesPlayed: 0,
          totalHintsUsed: 0,
          healthMastery: 0,
          cognitionMastery: 0,
          digitalMastery: 0,
          financeMastery: 0,
          displayName: "Anonymous",
          avatar: null,
        },
        isAnonymous: true,
      });
    }

    const profile = await prisma.profile.findUnique({
      where: { userId },
      select: {
        totalScore: true,
        gamesPlayed: true,
        totalHintsUsed: true,
        healthMastery: true,
        cognitionMastery: true,
        digitalMastery: true,
        financeMastery: true,
        displayName: true,
        avatar: true,
      },
    });

    if (!profile) {
      return res.status(404).json({ error: "Profile not found" });
    }

    res.json({
      ok: true,
      profile,
      isAnonymous: false,
    });
  } catch (error) {
    console.error("Get profile error:", error);
    res.status(500).json({ error: "Failed to get profile" });
  }
});

// ดึงข้อมูล session เพื่อดูผลการเล่น
router.get("/session/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.auth!.userId;

    // 🔥 FIX: Anonymous ไม่มี session
    if (isAnonymous(userId)) {
      return res.status(404).json({
        ok: false,
        error: "Anonymous users don't have saved sessions",
      });
    }

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

    if (!gr || gr.userId !== userId) {
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
        userAnswer: gq.userAnswer,
        category: gq.question.category,
      };
    });

    // คำนวณสถิติแต่ละหมวด
    const categoryStats: Record<string, { correct: number; total: number }> = {
      HEALTH: { correct: 0, total: 0 },
      COGNITION: { correct: 0, total: 0 },
      DIGITAL: { correct: 0, total: 0 },
      FINANCE: { correct: 0, total: 0 },
    };

    questions.forEach((q) => {
      const cat = q.category;
      if (categoryStats[cat]) {
        categoryStats[cat].total++;
        if (q.isCorrect) {
          categoryStats[cat].correct++;
        }
      }
    });

    res.json({
      sessionId: gr.id,
      score: gr.score,
      correctAnswers: gr.correctAnswers,
      totalQuestions: gr.totalQuestions,
      category: "MIXED",
      masteryPercent: gr.totalQuestions ? (gr.correctAnswers / gr.totalQuestions) * 100 : 0,
      questions,
      categoryStats,
    });
  } catch (error) {
    console.error("Get session error:", error);
    res.status(500).json({ error: "Failed to get session" });
  }
});

export default router;

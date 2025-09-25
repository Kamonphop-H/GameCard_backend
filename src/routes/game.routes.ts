/** @format */
import { Router } from "express";
import { prisma } from "../prisma";
import { requireAuth } from "../middlewares/security";
import { Category, Lang } from "@prisma/client";

const router = Router();

const CATEGORY_LIST: Category[] = ["HEALTH", "COGNITION", "DIGITAL", "FINANCE"];
const diffLabel = (n: number) => (n >= 3 ? "HARD" : n === 2 ? "MEDIUM" : "EASY");

// สุ่ม n ตัวจากอาร์เรย์ (Fisher–Yates)
function sampleArray<T>(arr: T[], n: number) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, Math.max(0, Math.min(n, a.length)));
}

// *** แก้ไขฟังก์ชันนี้ให้ส่ง image URL ที่ถูกต้อง ***
async function fetchQuestionsOfCategory(cat: Category, count: number, lang: Lang) {
  const qs = await prisma.question.findMany({
    where: { category: cat, isActive: true },
    select: {
      id: true,
      category: true,
      difficulty: true,
      inputType: true, // เพิ่ม inputType
      type: true, // เพิ่ม type
      translations: {
        where: { lang },
        select: {
          questionText: true,
          options: true,
          correctAnswers: true,
          explanation: true,
          imageUrl: true,
          targetValue: true, // เพิ่ม targetValue
        },
      },
    },
  });

  // แปลงและสร้าง full image URL
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
      correctAnswers: t?.correctAnswers || [], // เพิ่มสำหรับคำตอบหลายตัว
      targetValue: t?.targetValue || null,
      explanation: t?.explanation || "",
      // สร้าง full URL สำหรับรูปภาพ - สำคัญ!
      imageUrl: t?.imageUrl ? `/api/admin/images/${t.imageUrl}` : "",
      difficulty: diffLabel(q.difficulty),
    };
  });

  return sampleArray(normalized, count);
}

/** POST /api/game/start
 * body: { category: "HEALTH"|"COGNITION"|"DIGITAL"|"FINANCE"|"MIXED", questionCount?: number }
 * - ถ้า "MIXED" → สุ่ม "หมวดละ 10 ข้อ" รวม 40 ข้อ (สลับลำดับ)
 */
router.post("/start", requireAuth, async (req, res) => {
  const { category = "MIXED", questionCount = 10 } = req.body || {};
  const lang = (req.auth!.lang || "th") as Lang;
  const userId = req.auth!.userId;

  let questionList: any[] = [];

  if (category === "MIXED") {
    for (const c of CATEGORY_LIST) {
      const part = await fetchQuestionsOfCategory(c, 10, lang);
      questionList.push(...part);
    }
    // ผสมลำดับ
    questionList = sampleArray(questionList, questionList.length);
  } else {
    if (!CATEGORY_LIST.includes(category)) {
      return res.status(400).json({ ok: false, error: "INVALID_CATEGORY" });
    }
    questionList = await fetchQuestionsOfCategory(category, Number(questionCount) || 10, lang);
  }

  // สร้าง GameResult (ยังไม่บันทึกคำตอบจนกว่าจะ complete)
  const result = await prisma.gameResult.create({
    data: {
      userId,
      category: CATEGORY_LIST.includes(category) ? category : "HEALTH",
      score: 0,
      totalQuestions: questionList.length,
      correctAnswers: 0,
      timeSpent: 0,
    },
  });

  res.json({ sessionId: result.id, category, questions: questionList });
});

/** POST /api/game/complete
 * body: { sessionId, answers: [{ id, chosen }], category: "MIXED"|Category }
 * - ตรวจคำตอบกับ DB จริง
 * - คำนวณคะแนนฝั่ง server: base คะแนนตาม difficulty (10/20/30) + โบนัสเวลารวม (optional: ถ้าอยากส่งมาด้วย)
 * - บันทึก GameQuestion + อัปเดต GameResult + Profile + mastery + achievement "MIXED_UNLOCK"
 */
router.post("/complete", requireAuth, async (req, res) => {
  const { sessionId, answers = [], category } = req.body || {};
  const userId = req.auth!.userId;

  const result = await prisma.gameResult.findUnique({ where: { id: sessionId } });
  if (!result || result.userId !== userId) {
    return res.status(404).json({ ok: false, error: "SESSION_NOT_FOUND" });
  }

  // ดึงคำถามทั้งหมดที่มีในคำตอบนี้
  const qIds = answers.map((a: any) => a.id).filter(Boolean);
  const questions = await prisma.question.findMany({
    where: { id: { in: qIds } },
    select: {
      id: true,
      category: true,
      difficulty: true,
      translations: { select: { lang: true, correctAnswers: true } },
    },
  });
  const qMap = new Map(questions.map((q) => [q.id, q]));

  // ประมวลผลคำตอบ
  let correct = 0;
  let serverScore = 0;
  const perCatCount: Record<Category, { correct: number; total: number }> = {
    HEALTH: { correct: 0, total: 0 },
    COGNITION: { correct: 0, total: 0 },
    DIGITAL: { correct: 0, total: 0 },
    FINANCE: { correct: 0, total: 0 },
  };

  const makeBase = (d: number) => (d >= 3 ? 30 : d === 2 ? 20 : 10);

  // บันทึก GameQuestion ทั้งหมด
  const toCreateGQ: any[] = [];

  for (const a of answers) {
    const q = qMap.get(a.id);
    if (!q) continue;
    const corrList = (q.translations?.[0]?.correctAnswers || []).map((s: any) =>
      String(s).trim().toLowerCase()
    );
    const chosen = String(a.chosen ?? "")
      .trim()
      .toLowerCase();
    const isCorrect = chosen && corrList.includes(chosen);

    if (isCorrect) {
      correct += 1;
      serverScore += makeBase(q.difficulty);
    }

    perCatCount[q.category].total += 1;
    if (isCorrect) perCatCount[q.category].correct += 1;

    toCreateGQ.push({
      gameResultId: result.id,
      questionId: q.id,
      userAnswer: a.chosen ?? "",
      isCorrect,
      timeSpent: Number(a.timeSpent ?? 0),
    });
  }

  await prisma.$transaction([
    prisma.gameQuestion.createMany({ data: toCreateGQ }),
    prisma.gameResult.update({
      where: { id: result.id },
      data: {
        score: serverScore,
        correctAnswers: correct,
        totalQuestions: answers.length,
        isCompleted: true,
        completedAt: new Date(),
      },
    }),
    prisma.profile.update({
      where: { userId },
      data: {
        totalScore: { increment: serverScore },
        gamesPlayed: { increment: 1 },
      },
    }),
  ]);

  // Re-calc mastery จากคำตอบทั้งหมด (อิง GameQuestion join Question.category)
  const allAnswers = await prisma.gameQuestion.findMany({
    where: { gameResult: { userId } },
    select: { isCorrect: true, question: { select: { category: true } } },
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

  // ถ้าเล่นโหมดผสม → ตั้ง achievement ปลดล็อค
  if (category === "MIXED") {
    await prisma.achievement.upsert({
      where: { userId_type_category: { userId, type: "MIXED_UNLOCK", category: null } },
      update: { isCompleted: true, unlockedAt: new Date() },
      create: { userId, type: "MIXED_UNLOCK", isCompleted: true },
    });
  }

  res.json({ ok: true, serverScore, correct });
});

/** GET /api/game/session/:id → รายละเอียดผลรอบนั้น */
router.get("/session/:id", requireAuth, async (req, res) => {
  const { id } = req.params;
  const gr = await prisma.gameResult.findUnique({
    where: { id },
    include: {
      gameQuestions: {
        include: { question: { select: { category: true, difficulty: true, translations: true } } },
      },
    },
  });
  if (!gr || gr.userId !== req.auth!.userId) return res.status(404).json({ ok: false });

  // แปลงกลับให้ UI พร้อมสร้าง image URL ที่ถูกต้อง
  const questions = gr.gameQuestions.map((gq) => {
    const t = gq.question.translations[0];
    return {
      id: gq.questionId,
      question: t?.questionText || "—",
      correctAnswer: (t?.correctAnswers?.[0] ?? "").toString(),
      explanation: t?.explanation || "",
      // สร้าง full URL สำหรับรูปภาพ
      imageUrl: t?.imageUrl ? `/api/admin/images/${t.imageUrl}` : "",
      isCorrect: gq.isCorrect,
    };
  });

  // ถ้าในรอบนี้มีหลายหมวด → ถือเป็น "MIXED"
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
});

export default router;

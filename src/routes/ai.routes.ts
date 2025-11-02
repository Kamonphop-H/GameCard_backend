/** @format */
// src/routes/ai.routes.ts - ตัวอย่างการใช้งาน Gemini AI

import { Router } from "express";
import { prisma } from "../prisma";
import { requireAuth } from "../middlewares/security";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { Category } from "@prisma/client";

const router = Router();

// ⭐ Initialize Gemini AI
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

const MODEL_NAME = process.env.GEMINI_MODEL || "gemini-2.0-flash-exp";

// ⭐ Middleware: ตรวจสอบว่า Gemini พร้อมใช้งาน
const requireGemini = (req: any, res: any, next: any) => {
  if (!genAI) {
    return res.status(503).json({
      error: "AI service not available",
      message: "GEMINI_API_KEY not configured. Please set it in .env file",
      docs: "https://aistudio.google.com/app/apikey",
    });
  }
  next();
};

// ⭐ 1. วิเคราะห์จุดอ่อนของผู้เล่น
router.post("/analyze-weakness", requireAuth, requireGemini, async (req, res) => {
  try {
    const userId = req.auth!.userId;
    const { category } = req.body;

    // ดึงประวัติการเล่นล่าสุด 10 เกม
    const recentGames = await prisma.gameResult.findMany({
      where: {
        userId,
        isCompleted: true,
        ...(category && { category: category as Category }),
      },
      orderBy: { completedAt: "desc" },
      take: 10,
      include: {
        gameQuestions: {
          where: { isCorrect: false }, // เฉพาะข้อที่ตอบผิด
          include: {
            question: {
              select: {
                category: true,
                type: true,
                difficulty: true,
                translations: {
                  select: {
                    questionText: true,
                    correctAnswers: true,
                    explanation: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    // สรุปข้อมูล
    const wrongAnswers = recentGames.flatMap((game) =>
      game.gameQuestions.map((gq) => ({
        category: gq.question.category,
        type: gq.question.type,
        difficulty: gq.question.difficulty,
        question: gq.question.translations[0]?.questionText || "",
        correctAnswer: gq.question.translations[0]?.correctAnswers[0] || "",
        userAnswer: gq.userAnswer,
        explanation: gq.question.translations[0]?.explanation || "",
      }))
    );

    if (wrongAnswers.length === 0) {
      return res.json({
        analysis: "ยังไม่มีข้อมูลเพียงพอในการวิเคราะห์",
        suggestion: "ลองเล่นเกมอีกสักครั้งเพื่อให้ระบบวิเคราะห์จุดอ่อนได้",
        weakCategories: [],
      });
    }

    // สร้าง prompt สำหรับ Gemini
    const prompt = `
คุณเป็นที่ปรึกษาด้านการศึกษาสำหรับเกมตอบคำถาม ผู้เล่นตอบคำถามผิดดังนี้:

${wrongAnswers
  .slice(0, 20) // จำกัดไม่เกิน 20 ข้อ
  .map(
    (item, idx) => `
${idx + 1}. หมวด: ${item.category}
   คำถาม: ${item.question}
   คำตอบที่ถูก: ${item.correctAnswer}
   คำตอบของผู้เล่น: ${item.userAnswer}
   คำอธิบาย: ${item.explanation}
`
  )
  .join("\n")}

กรุณาวิเคราะห์และให้คำแนะนำดังนี้:
1. จุดอ่อนหลักของผู้เล่น (2-3 ข้อ)
2. แนวทางในการพัฒนา (3-5 ข้อ)
3. หมวดหมู่ที่ควรฝึกซ้อม

ตอบเป็นภาษาไทยในรูปแบบ JSON:
{
  "weaknesses": ["จุดอ่อน 1", "จุดอ่อน 2"],
  "improvements": ["แนวทาง 1", "แนวทาง 2"],
  "weakCategories": ["HEALTH", "DIGITAL"],
  "summary": "สรุปโดยรวม"
}
`;

    // เรียก Gemini
    const model = genAI!.getGenerativeModel({ model: MODEL_NAME });
    const result = await model.generateContent(prompt);
    const response = result.response;
    const text = response.text();

    // Parse JSON response
    let analysis;
    try {
      // ลบ markdown code block ถ้ามี
      const cleanedText = text
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
      analysis = JSON.parse(cleanedText);
    } catch (parseError) {
      console.error("Failed to parse Gemini response:", text);
      analysis = {
        weaknesses: ["ไม่สามารถวิเคราะห์ได้ในขณะนี้"],
        improvements: ["ลองเล่นเกมอีกครั้งเพื่อให้ข้อมูลมากขึ้น"],
        weakCategories: [],
        summary: text,
      };
    }

    // สถิติเพิ่มเติม
    const categoryStats: Record<string, { wrong: number; total: number }> = {
      HEALTH: { wrong: 0, total: 0 },
      COGNITION: { wrong: 0, total: 0 },
      DIGITAL: { wrong: 0, total: 0 },
      FINANCE: { wrong: 0, total: 0 },
    };

    wrongAnswers.forEach((item) => {
      if (categoryStats[item.category]) {
        categoryStats[item.category].wrong++;
      }
    });

    recentGames.forEach((game) => {
      game.gameQuestions.forEach((gq) => {
        const cat = gq.question.category;
        if (categoryStats[cat]) {
          categoryStats[cat].total++;
        }
      });
    });

    res.json({
      ...analysis,
      stats: {
        totalWrong: wrongAnswers.length,
        gamesAnalyzed: recentGames.length,
        categoryStats,
      },
    });
  } catch (error) {
    console.error("AI analysis error:", error);
    res.status(500).json({
      error: "Failed to analyze weakness",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// ⭐ 2. สร้างโจทย์ฝึกซ้อมตามจุดอ่อน
router.post("/generate-practice", requireAuth, requireGemini, async (req, res) => {
  try {
    const { category, difficulty = "MEDIUM", count = 5, lang = "th" } = req.body;

    if (!category || !["HEALTH", "COGNITION", "DIGITAL", "FINANCE"].includes(category)) {
      return res.status(400).json({ error: "Invalid category" });
    }

    // ดึงตัวอย่างคำถามในหมวดนั้น
    const sampleQuestions = await prisma.question.findMany({
      where: {
        category: category as Category,
        isActive: true,
      },
      take: 3,
      include: {
        translations: {
          where: { lang },
        },
      },
    });

    const examples = sampleQuestions
      .map(
        (q, idx) => `
ตัวอย่าง ${idx + 1}:
คำถาม: ${q.translations[0]?.questionText || ""}
ตัวเลือก: ${(q.translations[0]?.options || []).join(", ")}
คำตอบที่ถูก: ${q.translations[0]?.correctAnswers[0] || ""}
คำอธิบาย: ${q.translations[0]?.explanation || ""}
`
      )
      .join("\n");

    const categoryDesc = {
      HEALTH: "สุขภาพ (โภชนาการ, การออกกำลังกาย, โรคภัยไข้เจ็บ)",
      COGNITION: "ทักษะการคิด (ตรรกะ, คณิตศาสตร์, การแก้ปัญหา)",
      DIGITAL: "ดิจิทัล (ความปลอดภัยออนไลน์, การใช้เทคโนโลยี)",
      FINANCE: "การเงิน (การจัดการเงิน, การออม, การลงทุน)",
    };

    const prompt = `
คุณเป็นผู้เชี่ยวชาญในการสร้างโจทย์สำหรับเกมตอบคำถามหมวด ${categoryDesc[category as keyof typeof categoryDesc]}

ตัวอย่างคำถามในหมวดนี้:
${examples}

กรุณาสร้างคำถามใหม่ ${count} ข้อ ระดับความยาก: ${difficulty}
ให้ตอบเป็นภาษาไทยในรูปแบบ JSON array:
[
  {
    "question": "คำถาม",
    "options": ["ตัวเลือก 1", "ตัวเลือก 2", "ตัวเลือก 3", "ตัวเลือก 4"],
    "correctAnswer": "คำตอบที่ถูก",
    "explanation": "คำอธิบาย"
  }
]

หมายเหตุ:
- คำถามต้องเกี่ยวข้องกับหมวด ${category} เท่านั้น
- มีตัวเลือก 4 ข้อ
- คำตอบต้องชัดเจนและถูกต้อง
- คำอธิบายต้องให้ความรู้เพิ่มเติม
`;

    const model = genAI!.getGenerativeModel({ model: MODEL_NAME });
    const result = await model.generateContent(prompt);
    const response = result.response;
    const text = response.text();

    let questions;
    try {
      const cleanedText = text
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
      questions = JSON.parse(cleanedText);
    } catch (parseError) {
      console.error("Failed to parse Gemini response:", text);
      return res.status(500).json({
        error: "Failed to parse AI response",
        rawResponse: text,
      });
    }

    res.json({
      category,
      difficulty,
      count: questions.length,
      questions,
      note: "คำถามเหล่านี้สร้างโดย AI เพื่อการฝึกซ้อม ไม่ได้บันทึกในระบบ",
    });
  } catch (error) {
    console.error("Generate practice error:", error);
    res.status(500).json({
      error: "Failed to generate practice questions",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// ⭐ 3. ให้คำแนะนำสำหรับคำถามที่ตอบผิด
router.post("/get-hint", requireAuth, requireGemini, async (req, res) => {
  try {
    const { questionId, previousHints = [], lang = "th" } = req.body;

    const question = await prisma.question.findUnique({
      where: { id: questionId },
      include: {
        translations: {
          where: { lang },
        },
      },
    });

    if (!question || !question.translations[0]) {
      return res.status(404).json({ error: "Question not found" });
    }

    const t = question.translations[0];

    // ใช้ hint ที่มีอยู่แล้วก่อน (ถ้ามี)
    const existingHints = [t.hint1, t.hint2, t.hint3].filter(Boolean);

    if (previousHints.length < existingHints.length) {
      return res.json({
        hint: existingHints[previousHints.length],
        source: "database",
        level: previousHints.length + 1,
      });
    }

    // ถ้าไม่มี hint ในDB แล้ว ให้ AI สร้างใหม่
    const prompt = `
คำถาม: ${t.questionText}
ตัวเลือก: ${(t.options || []).join(", ")}
คำตอบที่ถูก: ${t.correctAnswers[0]}

hint ที่ให้ไปแล้ว:
${previousHints.map((h: string, i: number) => `${i + 1}. ${h}`).join("\n")}

กรุณาให้ hint ใหม่ที่:
- ไม่บอกคำตอบโดยตรง
- ช่วยให้คิดเองได้
- ไม่ซ้ำกับ hint ก่อนหน้า

ตอบเป็นภาษาไทย (เฉพาะ hint ไม่ต้องมีคำอธิบายเพิ่ม):
`;

    const model = genAI!.getGenerativeModel({ model: MODEL_NAME });
    const result = await model.generateContent(prompt);
    const hint = result.response.text().trim();

    res.json({
      hint,
      source: "ai",
      level: previousHints.length + 1,
    });
  } catch (error) {
    console.error("Get hint error:", error);
    res.status(500).json({
      error: "Failed to get hint",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// ⭐ 4. ประเมินความก้าวหน้า
router.get("/progress-report", requireAuth, requireGemini, async (req, res) => {
  try {
    const userId = req.auth!.userId;

    // ดึงข้อมูล profile และประวัติการเล่น
    const profile = await prisma.profile.findUnique({
      where: { userId },
    });

    const games = await prisma.gameResult.findMany({
      where: { userId, isCompleted: true },
      orderBy: { completedAt: "desc" },
      take: 20,
    });

    if (!profile || games.length < 3) {
      return res.json({
        report: "ข้อมูลยังไม่เพียงพอในการประเมิน กรุณาเล่นเกมอย่างน้อย 3 เกม",
        stats: {
          gamesPlayed: games.length,
          totalScore: profile?.totalScore || 0,
        },
      });
    }

    // คำนวณสถิติ
    const avgScore = games.reduce((sum, g) => sum + g.score, 0) / games.length;
    const avgAccuracy =
      games.reduce((sum, g) => sum + (g.correctAnswers / g.totalQuestions) * 100, 0) / games.length;

    const recentAvg = games.slice(0, 5).reduce((sum, g) => sum + g.score, 0) / Math.min(5, games.length);
    const oldAvg = games.slice(5, 10).reduce((sum, g) => sum + g.score, 0) / Math.max(1, games.length - 5);

    const improvement = recentAvg - oldAvg;

    const prompt = `
ข้อมูลผู้เล่น:
- เล่นไปแล้ว: ${profile.gamesPlayed} เกม
- คะแนนรวม: ${profile.totalScore}
- คะแนนเฉลี่ย: ${avgScore.toFixed(1)}
- ความแม่นยำเฉลี่ย: ${avgAccuracy.toFixed(1)}%
- แนวโน้ม: ${improvement > 0 ? "ดีขึ้น" : "คงที่หรือลดลง"} (${
      improvement > 0 ? "+" : ""
    }${improvement.toFixed(1)})

ความชำนาญแต่ละหมวด:
- สุขภาพ: ${profile.healthMastery}%
- ทักษะการคิด: ${profile.cognitionMastery}%
- ดิจิทัล: ${profile.digitalMastery}%
- การเงิน: ${profile.financeMastery}%

กรุณาประเมินความก้าวหน้าและให้กำลังใจผู้เล่นเป็นภาษาไทยในรูปแบบ JSON:
{
  "summary": "สรุปโดยรวม",
  "strengths": ["จุดแข็ง 1", "จุดแข็ง 2"],
  "improvements": ["สิ่งที่ควรพัฒนา 1", "สิ่งที่ควรพัฒนา 2"],
  "motivation": "คำให้กำลังใจ",
  "nextGoals": ["เป้าหมายต่อไป 1", "เป้าหมายต่อไป 2"]
}
`;

    const model = genAI!.getGenerativeModel({ model: MODEL_NAME });
    const result = await model.generateContent(prompt);
    const text = result.response.text();

    let report;
    try {
      const cleanedText = text
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
      report = JSON.parse(cleanedText);
    } catch {
      report = { summary: text };
    }

    res.json({
      ...report,
      stats: {
        gamesPlayed: profile.gamesPlayed,
        totalScore: profile.totalScore,
        avgScore: Math.round(avgScore),
        avgAccuracy: Math.round(avgAccuracy),
        improvement: Math.round(improvement),
        mastery: {
          health: profile.healthMastery,
          cognition: profile.cognitionMastery,
          digital: profile.digitalMastery,
          finance: profile.financeMastery,
        },
      },
    });
  } catch (error) {
    console.error("Progress report error:", error);
    res.status(500).json({
      error: "Failed to generate progress report",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// ⭐ Health check สำหรับ AI service
router.get("/health", (_req, res) => {
  res.json({
    status: genAI ? "enabled" : "disabled",
    model: MODEL_NAME,
    apiKeyConfigured: !!process.env.GEMINI_API_KEY,
    message: genAI ? "AI service is ready" : "Set GEMINI_API_KEY in .env to enable AI features",
  });
});

export default router;

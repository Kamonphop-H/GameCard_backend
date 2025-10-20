/** @format */
import { Router, Request, Response } from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { authenticateToken } from "../middlewares/auth";

const router = Router();

// Initialize Gemini AI
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

/**
 * POST /api/ai/analyze
 * วิเคราะห์ผลคะแนนเกมด้วย Gemini AI
 */
router.post("/analyze", authenticateToken, async (req: Request, res: Response) => {
  try {
    const { prompt, sessionId } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: "Prompt is required" });
    }

    if (!genAI) {
      return res.status(503).json({
        success: false,
        error: "AI service not configured",
        analysis: req.body.prompt.includes("วิเคราะห์")
          ? "ขออภัย ระบบ AI ยังไม่พร้อมใช้งาน กรุณาติดต่อผู้ดูแลระบบ"
          : "Sorry, AI service is not available. Please contact administrator.",
      });
    }

    // Get Gemini model
    const model = genAI.getGenerativeModel({
      model: "gemini-pro",
      generationConfig: {
        temperature: 0.9,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 1024,
      },
    });

    // Generate content
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const analysis = response.text();

    // Optional: บันทึก AI analysis ลงฐานข้อมูล
    if (sessionId) {
      // await saveAIAnalysis(sessionId, analysis);
    }

    res.json({
      success: true,
      analysis: analysis,
      sessionId: sessionId,
    });
  } catch (error: any) {
    console.error("Gemini AI Error:", error);

    // Fallback response ถ้า API ล้มเหลว
    const isThai = req.body.prompt.includes("วิเคราะห์");
    const fallbackMessage = isThai
      ? "ขออภัย ระบบ AI กำลังประมวลผลหนัก กรุณาลองใหม่อีกครั้งในภายหลัง 🙏\n\nในระหว่างนี้ ขอแสดงความยินดีกับผลคะแนนของคุณ! คุณทำได้ดีมาก จงภูมิใจในความพยายามและพัฒนาต่อไป 💪✨\n\nคำแนะนำทั่วไป:\n• ฝึกฝนอย่างสม่ำเสมอเพื่อพัฒนาทักษะ\n• ทบทวนข้อที่ตอบผิดเพื่อเรียนรู้\n• ตั้งเป้าหมายที่ท้าทายแต่เป็นไปได้\n• อย่าลืมพักผ่อนให้เพียงพอ"
      : "Sorry, the AI system is currently busy. Please try again later. 🙏\n\nIn the meantime, congratulations on your score! You did great work. Be proud of your efforts and keep improving! 💪✨\n\nGeneral tips:\n• Practice regularly to develop skills\n• Review incorrect answers to learn\n• Set challenging but achievable goals\n• Remember to get adequate rest";

    res.status(200).json({
      success: false,
      analysis: fallbackMessage,
      error: "AI service temporarily unavailable",
    });
  }
});

/**
 * POST /api/ai/chat
 * Chat with AI about learning topics
 */
router.post("/chat", authenticateToken, async (req: Request, res: Response) => {
  try {
    const { message, context } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    if (!genAI) {
      return res.status(503).json({
        success: false,
        error: "AI service not configured",
      });
    }

    const model = genAI.getGenerativeModel({ model: "gemini-pro" });

    // สร้าง chat session
    const chat = model.startChat({
      history: context || [],
      generationConfig: {
        maxOutputTokens: 500,
        temperature: 0.9,
      },
    });

    const result = await chat.sendMessage(message);
    const response = await result.response;
    const text = response.text();

    res.json({
      success: true,
      response: text,
    });
  } catch (error) {
    console.error("Gemini Chat Error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to process chat message",
    });
  }
});

/**
 * POST /api/ai/suggest-questions
 * แนะนำคำถามตามผลการเล่น
 */
router.post("/suggest-questions", authenticateToken, async (req: Request, res: Response) => {
  try {
    const { weakCategories, userLevel, locale = "th" } = req.body;

    if (!genAI) {
      return res.status(503).json({
        success: false,
        error: "AI service not configured",
      });
    }

    const prompt =
      locale === "th"
        ? `ผู้เล่นมีความอ่อนในหมวดหมู่: ${weakCategories.join(", ")}
ระดับผู้เล่น: ${userLevel}

แนะนำหัวข้อหรือทักษะที่ควรฝึกฝนเพิ่มเติม พร้อมเหตุผล (ตอบสั้นๆ ไม่เกิน 100 คำ)`
        : `Player is weak in categories: ${weakCategories.join(", ")}
Player level: ${userLevel}

Suggest topics or skills to practice, with reasons (keep it brief, max 100 words)`;

    const model = genAI.getGenerativeModel({ model: "gemini-pro" });
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const suggestions = response.text();

    res.json({
      success: true,
      suggestions: suggestions,
    });
  } catch (error) {
    console.error("Gemini Suggestions Error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to generate suggestions",
    });
  }
});

/**
 * POST /api/ai/motivate
 * สร้างข้อความให้กำลังใจตามผลคะแนน
 */
router.post("/motivate", authenticateToken, async (req: Request, res: Response) => {
  try {
    const { score, accuracy, previousScore, locale = "th" } = req.body;

    if (!genAI) {
      const fallback =
        locale === "th"
          ? "ยอดเยี่ยม! คุณทำได้ดีมาก จงภูมิใจในความพยายามของตัวเอง ทุกคะแนนคือก้าวหนึ่งสู่ความสำเร็จ เล่นต่อไปเพื่อพัฒนาตัวเองให้ดียิ่งขึ้น! 💪✨"
          : "Excellent work! Be proud of your efforts. Every point is a step towards success. Keep playing to improve even more! 💪✨";

      return res.json({
        success: true,
        message: fallback,
      });
    }

    const improvement = previousScore ? score - previousScore : 0;

    const prompt =
      locale === "th"
        ? `สร้างข้อความให้กำลังใจผู้เล่นเกมการเรียนรู้:
คะแนนปัจจุบัน: ${score}
ความแม่นยำ: ${accuracy}%
${improvement > 0 ? `พัฒนาขึ้น: +${improvement} คะแนน` : ""}

ให้กำลังใจอย่างจริงใจ สร้างแรงบันดาลใจ และแนะนำให้เล่นต่อ (40-60 คำ)`
        : `Create motivational message for learning game player:
Current score: ${score}
Accuracy: ${accuracy}%
${improvement > 0 ? `Improvement: +${improvement} points` : ""}

Provide genuine encouragement, inspiration, and motivation to keep playing (40-60 words)`;

    const model = genAI.getGenerativeModel({ model: "gemini-pro" });
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const motivation = response.text();

    res.json({
      success: true,
      message: motivation,
    });
  } catch (error) {
    console.error("Gemini Motivation Error:", error);
    const fallback =
      locale === "th"
        ? "ยอดเยี่ยม! คุณทำได้ดีมาก จงภูมิใจในความพยายามของตัวเอง ทุกคะแนนคือก้าวหนึ่งสู่ความสำเร็จ เล่นต่อไปเพื่อพัฒนาตัวเองให้ดียิ่งขึ้น! 💪✨"
        : "Excellent work! Be proud of your efforts. Every point is a step towards success. Keep playing to improve even more! 💪✨";

    res.json({
      success: true,
      message: fallback,
    });
  }
});

/**
 * GET /api/ai/status
 * ตรวจสอบสถานะ AI service
 */
router.get("/status", (_req: Request, res: Response) => {
  res.json({
    success: true,
    available: !!genAI,
    model: genAI ? "gemini-pro" : null,
    features: {
      analysis: !!genAI,
      chat: !!genAI,
      suggestions: !!genAI,
      motivation: !!genAI,
    },
  });
});

export default router;

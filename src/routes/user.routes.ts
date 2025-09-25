/** @format */

// src/routes/question.routes.ts - เพิ่ม endpoint validate-answer

import { Router } from "express";
import { prisma } from "../prisma";
import { authenticateToken } from "../middlewares/security";
import { AnswerValidator } from "../services/answerValidator";
import { questionTypes } from "../config/questionTypes";

const router = Router();
router.post("/validate-answer", authenticateToken, async (req, res) => {
  try {
    const { questionId, userAnswer, lang = "th" } = req.body;

    // ดึงข้อมูลคำถาม
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

    const translation = question.translations[0];
    const questionConfig = questionTypes[question.category]?.find((qt) => qt.id === question.type);

    let isCorrect = false;

    // ตรวจสอบตามประเภท input
    switch (question.inputType) {
      case "TEXT":
        isCorrect = AnswerValidator.validateTextAnswer(
          userAnswer,
          translation.correctAnswers,
          questionConfig?.multipleAnswers || false
        );
        break;

      case "CALCULATION":
        if (translation.targetValue !== null) {
          isCorrect = AnswerValidator.validateCalculation(userAnswer, translation.targetValue);
        }
        break;

      case "MULTIPLE_CHOICE_3":
      case "MULTIPLE_CHOICE_4":
        isCorrect = AnswerValidator.validateMultipleChoice(userAnswer, translation.correctAnswers[0]);
        break;
    }

    res.json({
      isCorrect,
      correctAnswers: translation.correctAnswers,
      explanation: translation.explanation,
    });
  } catch (error) {
    console.error("Validate answer error:", error);
    res.status(500).json({ error: "Failed to validate answer" });
  }
});

export default router;

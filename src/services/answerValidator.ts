/** @format */

// src/services/answerValidator.ts

export class AnswerValidator {
  // ตรวจสอบคำตอบแบบ TEXT (อาจมีหลายคำตอบที่ถูก)
  static validateTextAnswer(userAnswer: string, correctAnswers: string[], multipleAnswers: boolean): boolean {
    const normalizedUserAnswer = this.normalizeText(userAnswer);

    if (multipleAnswers) {
      // ถ้ามีหลายคำตอบที่ถูก ตรวจสอบว่าตรงกับคำตอบใดคำตอบหนึ่ง
      return correctAnswers.some((answer) => this.normalizeText(answer) === normalizedUserAnswer);
    } else {
      // คำตอบเดียว
      return this.normalizeText(correctAnswers[0]) === normalizedUserAnswer;
    }
  }

  // ตรวจสอบคำตอบแบบ CALCULATION
  static validateCalculation(userAnswer: string, targetValue: number): boolean {
    try {
      // แปลง input เป็นสมการและคำนวณ
      // รองรับ +, -, *, / และตัวเลขหลายหลัก
      const sanitized = userAnswer.replace(/[^0-9+\-*/\s()]/g, "");

      // ใช้ Function constructor แทน eval (ปลอดภัยกว่า)
      const result = Function(`"use strict"; return (${sanitized})`)();

      return Math.abs(result - targetValue) < 0.001; // ใช้ tolerance สำหรับ floating point
    } catch (error) {
      return false;
    }
  }

  // ตรวจสอบคำตอบแบบ MULTIPLE_CHOICE
  static validateMultipleChoice(userAnswer: string, correctAnswer: string): boolean {
    return userAnswer === correctAnswer;
  }

  // Normalize text สำหรับเปรียบเทียบ
  private static normalizeText(text: string): string {
    return text
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ") // แทนที่ช่องว่างหลายช่องด้วยช่องเดียว
      .replace(/[.,!?;:]/g, ""); // ลบเครื่องหมายวรรคตอน
  }
}

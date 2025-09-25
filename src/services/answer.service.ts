/** @format */
import { InputType } from "@prisma/client";

export class AnswerValidator {
  /**
   * Main validation method
   */
  validate(
    userAnswer: string,
    correctAnswers: string[],
    inputType: InputType,
    targetValue?: number | null
  ): boolean {
    switch (inputType) {
      case "TEXT":
        return this.validateTextAnswer(userAnswer, correctAnswers);

      case "MULTIPLE_CHOICE_3":
      case "MULTIPLE_CHOICE_4":
        return this.validateMultipleChoice(userAnswer, correctAnswers);

      case "CALCULATION":
        return this.validateCalculation(userAnswer, targetValue);

      default:
        return false;
    }
  }

  /**
   * Validate text answer (supports multiple correct answers)
   */
  private validateTextAnswer(userAnswer: string, correctAnswers: string[]): boolean {
    const normalizedUser = this.normalizeText(userAnswer);

    // Check if user answer matches any correct answer
    return correctAnswers.some((answer) => this.normalizeText(answer) === normalizedUser);
  }

  /**
   * Validate multiple choice answer
   */
  private validateMultipleChoice(userAnswer: string, correctAnswers: string[]): boolean {
    // Direct comparison for multiple choice
    return correctAnswers.includes(userAnswer);
  }

  /**
   * Validate calculation answer
   */
  private validateCalculation(userAnswer: string, targetValue?: number | null): boolean {
    if (targetValue === null || targetValue === undefined) {
      return false;
    }

    try {
      // Parse and evaluate mathematical expression
      const result = this.evaluateExpression(userAnswer);

      // Check if result equals target (with tolerance for floating point)
      return Math.abs(result - targetValue) < 0.001;
    } catch {
      return false;
    }
  }

  /**
   * Safely evaluate mathematical expression
   */
  private evaluateExpression(expression: string): number {
    // Remove all non-mathematical characters
    const sanitized = expression.replace(/[^0-9+\-*/().\s]/g, "");

    // Basic validation
    if (!sanitized || sanitized.length === 0) {
      throw new Error("Invalid expression");
    }

    // Use Function constructor for safe evaluation
    try {
      const result = Function(`"use strict"; return (${sanitized})`)();

      if (typeof result !== "number" || isNaN(result)) {
        throw new Error("Invalid result");
      }

      return result;
    } catch {
      throw new Error("Failed to evaluate expression");
    }
  }

  /**
   * Normalize text for comparison
   */
  private normalizeText(text: string): string {
    return text
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ") // Normalize spaces
      .replace(/[.,!?;:'"]/g, "") // Remove punctuation
      .replace(/[\u0E00-\u0E7F]/g, (match) => {
        // Handle Thai tone marks and vowels
        return match.normalize("NFD");
      });
  }

  /**
   * Batch validate multiple answers
   */
  async batchValidate(
    answers: Array<{
      userAnswer: string;
      correctAnswers: string[];
      inputType: InputType;
      targetValue?: number | null;
    }>
  ): Promise<boolean[]> {
    return answers.map((answer) =>
      this.validate(answer.userAnswer, answer.correctAnswers, answer.inputType, answer.targetValue)
    );
  }
}

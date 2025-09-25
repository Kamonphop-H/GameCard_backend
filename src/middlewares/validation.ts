/** @format */
import { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { ERROR_MESSAGES } from "../config/constants";

// Input sanitization
export const sanitizeInput = (input: any): any => {
  if (typeof input === "string") {
    // Remove HTML tags and trim whitespace
    return input.trim().replace(/<[^>]*>/g, "");
  }

  if (Array.isArray(input)) {
    return input.map(sanitizeInput);
  }

  if (typeof input === "object" && input !== null) {
    const sanitized: any = {};
    for (const key in input) {
      if (input.hasOwnProperty(key)) {
        sanitized[key] = sanitizeInput(input[key]);
      }
    }
    return sanitized;
  }

  return input;
};

// Validation middleware factory
export const validateInput = (schema: z.ZodSchema) => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      // Sanitize input first
      req.body = sanitizeInput(req.body);

      // Validate with schema
      const validated = schema.parse(req.body);
      req.body = validated;

      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          error: ERROR_MESSAGES.VALIDATION_FAILED,
          details: error.errors.map((err) => ({
            field: err.path.join("."),
            message: err.message,
          })),
        });
      }

      return res.status(400).json({
        error: ERROR_MESSAGES.INVALID_INPUT,
      });
    }
  };
};

// Common validation schemas
export const schemas = {
  // Auth schemas
  signUp: z.object({
    username: z
      .string()
      .min(3, "Username must be at least 3 characters")
      .max(20, "Username must be at most 20 characters")
      .regex(/^[a-zA-Z0-9_-]+$/, "Username can only contain letters, numbers, underscore and hyphen"),
    password: z
      .string()
      .min(8, "Password must be at least 8 characters")
      .regex(
        /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*#?&])/,
        "Password must contain uppercase, lowercase, number and special character"
      ),
    lang: z.enum(["th", "en"]).optional().default("th"),
  }),

  signIn: z.object({
    username: z.string().min(1, "Username is required"),
    password: z.string().min(1, "Password is required"),
  }),

  // Game schemas
  startGame: z.object({
    category: z.enum(["HEALTH", "COGNITION", "DIGITAL", "FINANCE", "MIXED"]),
    questionCount: z.number().min(1).max(40).optional().default(10),
  }),

  submitAnswer: z.object({
    sessionId: z.string().min(1),
    questionId: z.string().min(1),
    answer: z.string(),
    timeSpent: z.number().min(0).optional().default(0),
  }),

  completeGame: z.object({
    sessionId: z.string().min(1),
    answers: z.array(
      z.object({
        questionId: z.string(),
        answer: z.string(),
        timeSpent: z.number().min(0).optional(),
      })
    ),
    totalTimeSpent: z.number().min(0).optional().default(0),
  }),

  // Admin schemas
  createQuestion: z.object({
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
        options: z.array(z.string()).default([]),
        correctAnswers: z.array(z.string()).min(1),
        targetValue: z.number().nullable().optional(),
        explanation: z.string().optional().default(""),
      }),
      en: z.object({
        questionText: z.string().min(1),
        options: z.array(z.string()).default([]),
        correctAnswers: z.array(z.string()).min(1),
        targetValue: z.number().nullable().optional(),
        explanation: z.string().optional().default(""),
      }),
    }),
  }),

  updateQuestion: z.object({
    category: z.enum(["HEALTH", "COGNITION", "DIGITAL", "FINANCE"]).optional(),
    type: z
      .enum([
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
      ])
      .optional(),
    inputType: z.enum(["TEXT", "MULTIPLE_CHOICE_4", "MULTIPLE_CHOICE_3", "CALCULATION"]).optional(),
    difficulty: z.number().min(1).max(5).optional(),
    translations: z
      .object({
        th: z
          .object({
            questionText: z.string().min(1).optional(),
            options: z.array(z.string()).optional(),
            correctAnswers: z.array(z.string()).min(1).optional(),
            targetValue: z.number().nullable().optional(),
            explanation: z.string().optional(),
          })
          .optional(),
        en: z
          .object({
            questionText: z.string().min(1).optional(),
            options: z.array(z.string()).optional(),
            correctAnswers: z.array(z.string()).min(1).optional(),
            targetValue: z.number().nullable().optional(),
            explanation: z.string().optional(),
          })
          .optional(),
      })
      .optional(),
  }),

  // Query schemas
  pagination: z.object({
    page: z.coerce.number().min(1).optional().default(1),
    limit: z.coerce.number().min(1).max(100).optional().default(20),
    search: z.string().optional(),
    category: z.enum(["HEALTH", "COGNITION", "DIGITAL", "FINANCE"]).optional(),
  }),

  leaderboard: z.object({
    period: z.enum(["daily", "weekly", "monthly", "all"]).optional().default("weekly"),
    category: z.enum(["HEALTH", "COGNITION", "DIGITAL", "FINANCE", "ALL"]).optional().default("ALL"),
    limit: z.coerce.number().min(1).max(100).optional().default(10),
  }),
};

// ID validation helper
export const isValidObjectId = (id: string): boolean => {
  return /^[0-9a-fA-F]{24}$/.test(id);
};

// Validate MongoDB ObjectId parameter
export const validateObjectId = (paramName: string = "id") => {
  return (req: Request, res: Response, next: NextFunction) => {
    const id = req.params[paramName];

    if (!id || !isValidObjectId(id)) {
      return res.status(400).json({
        error: ERROR_MESSAGES.INVALID_INPUT,
        details: `Invalid ${paramName} format`,
      });
    }

    next();
  };
};

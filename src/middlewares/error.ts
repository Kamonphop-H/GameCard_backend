/** @format */
import { Request, Response, NextFunction } from "express";
import { ERROR_MESSAGES, IS_PROD } from "../config/constants";

// Custom error class
export class AppError extends Error {
  statusCode: number;
  isOperational: boolean;
  details?: any;

  constructor(message: string, statusCode: number = 500, details?: any) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
    this.details = details;

    Error.captureStackTrace(this, this.constructor);
  }
}

// 404 Not Found handler
export const notFoundHandler = (req: Request, res: Response) => {
  res.status(404).json({
    error: ERROR_MESSAGES.NOT_FOUND,
    path: req.originalUrl,
    method: req.method,
    timestamp: new Date().toISOString(),
  });
};

// Global error handler
export const errorHandler = (err: Error | AppError, req: Request, res: Response, _next: NextFunction) => {
  // Log error
  console.error("❌ Error:", {
    message: err.message,
    stack: IS_PROD ? undefined : err.stack,
    path: req.originalUrl,
    method: req.method,
    body: IS_PROD ? undefined : req.body,
  });

  // Default error values
  let statusCode = 500;
  let message = ERROR_MESSAGES.INTERNAL_ERROR;
  let details = undefined;

  // Handle AppError
  if (err instanceof AppError) {
    statusCode = err.statusCode;
    message = err.message;
    details = err.details;
  }

  // Handle specific error types
  else if (err.name === "ValidationError") {
    statusCode = 400;
    message = ERROR_MESSAGES.VALIDATION_FAILED;
    details = err.message;
  } else if (err.name === "JsonWebTokenError") {
    statusCode = 401;
    message = ERROR_MESSAGES.TOKEN_INVALID;
  } else if (err.name === "TokenExpiredError") {
    statusCode = 401;
    message = ERROR_MESSAGES.TOKEN_EXPIRED;
  } else if (err.name === "CastError") {
    statusCode = 400;
    message = ERROR_MESSAGES.INVALID_INPUT;
  }

  // Send error response
  res.status(statusCode).json({
    error: message,
    ...(details && { details }),
    ...(!IS_PROD && {
      stack: err.stack,
      originalError: err.message,
    }),
    timestamp: new Date().toISOString(),
  });
};

// Async handler wrapper to catch promise rejections
export const asyncHandler = (fn: Function) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

/**
 * Global error-handling middleware for Express.
 */
import type { Request, Response, NextFunction } from "express";

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  console.error("[error-handler]", err.message, err.stack);

  const status = (err as { status?: number }).status ?? 500;

  res.status(status).json({
    error: {
      message: err.message || "Internal server error",
      type: "server_error",
      code: status,
    },
  });
}

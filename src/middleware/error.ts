import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { HttpError } from "../utils/httpError.js";

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof ZodError) {
    res
      .status(400)
      .json({ error: "Validation failed", details: error.flatten() });
    return;
  }

  if (error instanceof HttpError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }

  console.error(
    "Unhandled error:",
    error instanceof Error ? error.message : String(error),
  );
  if (error instanceof Error) {
    console.error(error.stack);
  }
  res.status(500).json({ error: "Internal server error" });
};

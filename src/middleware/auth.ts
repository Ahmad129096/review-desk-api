import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { HttpError } from "../utils/httpError.js";

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        role: string;
      };
    }
  }
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;

    console.log(`Auth check: ${req.method} ${req.path}`, {
      hasAuthHeader: !!header,
      headerStart: header?.substring(0, 20) + "...",
      userAgent: req.headers["user-agent"]?.substring(0, 50) + "..."
    });

    if (!token) {
      throw new HttpError(401, "Authentication required");
    }

    let payload;
    try {
      payload = jwt.verify(token, env.JWT_SECRET) as { sub: string };
    } catch (jwtError) {
      if (jwtError instanceof jwt.JsonWebTokenError) {
        throw new HttpError(401, "Invalid authentication token");
      }
      if (jwtError instanceof jwt.TokenExpiredError) {
        throw new HttpError(401, "Authentication token expired");
      }
      throw jwtError;
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, role: true }
    });

    if (!user) {
      throw new HttpError(401, "Invalid session");
    }

    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}


import { Router } from "express";
import crypto, { hash } from "node:crypto";
import jwt from "jsonwebtoken";
import type { SignOptions } from "jsonwebtoken";
import { z } from "zod";
import { env } from "../config/env.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { HttpError } from "../utils/httpError.js";
import {
  sendEmail,
  createPasswordResetEmailHtml,
  createEmailVerificationEmailHtml,
} from "../services/email.js";

export const authRoutes = Router();

const registerSchema = z.object({
  name: z.string().min(2),
  email: z
    .string()
    .email()
    .transform((value) => value.toLowerCase()),
  password: z.string().min(8),
});

const loginSchema = z.object({
  email: z
    .string()
    .email()
    .transform((value) => value.toLowerCase()),
  password: z.string().min(1),
});

const forgotPasswordSchema = z.object({
  email: z
    .string()
    .email()
    .transform((value) => value.toLowerCase()),
});

const resetPasswordSchema = z.object({
  token: z.string().length(64),
  password: z.string().min(8),
});

const forgotPasswordResponseMessage =
  "If an account exists for this email, a password reset link has been sent.";

function createToken(userId: string) {
  const options: SignOptions = {
    subject: userId,
    expiresIn: env.JWT_EXPIRES_IN as SignOptions["expiresIn"],
  };

  return jwt.sign({}, env.JWT_SECRET, options);
}

function createPasswordResetToken() {
  return crypto.randomBytes(32).toString("hex");
}

function hashPasswordResetToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function createPasswordResetUrl(token: string) {
  const resetUrl = new URL("/reset-password", env.WEB_APP_URL);
  resetUrl.searchParams.set("token", token);
  return resetUrl.toString();
}

function createEmailVerificationUrl(token: string) {
  const verificationUrl = new URL("/verify-email", env.WEB_APP_URL);
  verificationUrl.searchParams.set("token", token);
  return verificationUrl.toString();
}

authRoutes.post(
  "/register",
  asyncHandler(async (req, res) => {
    const input = registerSchema.parse(req.body);
    const existing = await prisma.user.findUnique({
      where: { email: input.email },
    });

    if (existing) {
      throw new HttpError(409, "Email is already registered");
    }

    const user = await prisma.user.create({
      data: {
        name: input.name,
        email: input.email,
        passwordHash: await hashPassword(input.password),
        subscriptions: {
          create: {
            plan: "FREE",
            status: "ACTIVE",
          },
        },
      },
      select: { id: true, name: true, email: true },
    });

    // Create email verification token
    const verificationToken = createPasswordResetToken(); // Reuse the token generation logic
    const verificationUrl = createEmailVerificationUrl(verificationToken);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    await prisma.emailVerificationToken.create({
      data: {
        userId: user.id,
        tokenHash: hashPasswordResetToken(verificationToken),
        expiresAt,
      },
    });

    // Send verification email
    try {
      const emailHtml = createEmailVerificationEmailHtml(
        verificationUrl,
        user.name,
      );
      await sendEmail({
        to: user.email,
        subject: "Verify your ReviewDesk email",
        html: emailHtml,
      });
    } catch (error) {
      console.error("Failed to send verification email:", error);
      // Continue anyway, user can request resend
    }

    if (env.NODE_ENV !== "production") {
      console.log(
        `Email verification link for ${user.email}: ${verificationUrl}`,
      );
    }

    res.status(201).json({
      message:
        "Account created successfully. Please check your email to verify your account.",
      user: { id: user.id, name: user.name, email: user.email },
    });
  }),
);

authRoutes.post(
  "/login",
  asyncHandler(async (req, res) => {
    const input = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({
      where: { email: input.email },
    });

    if (!user || !(await verifyPassword(input.password, user.passwordHash))) {
      throw new HttpError(401, "Invalid email or password");
    }

    if (!user.emailVerified) {
      throw new HttpError(
        403,
        "Please verify your email address to login. Check your inbox for the verification link.",
      );
    }

    res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
      token: createToken(user.id),
    });
  }),
);

authRoutes.post(
  "/forgot-password",
  asyncHandler(async (req, res) => {
    const input = forgotPasswordSchema.parse(req.body);
    const user = await prisma.user.findUnique({
      where: { email: input.email },
    });
    const response: { message: string; resetUrl?: string } = {
      message: forgotPasswordResponseMessage,
    };

    if (user) {
      const token = createPasswordResetToken();
      const resetUrl = createPasswordResetUrl(token);
      const expiresAt = new Date(
        Date.now() + env.PASSWORD_RESET_EXPIRES_MINUTES * 60_000,
      );

      await prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: hashPasswordResetToken(token),
          expiresAt,
        },
      });

      // Send email with reset link
      try {
        const emailHtml = createPasswordResetEmailHtml(resetUrl, user.name);
        await sendEmail({
          to: user.email,
          subject: "Reset your ReviewDesk password",
          html: emailHtml,
        });
      } catch (error) {
        console.error("Failed to send password reset email:", error);
        // Don't throw error, still return success response for security
      }

      if (env.NODE_ENV !== "production") {
        response.resetUrl = resetUrl;
        console.log(`Password reset link for ${user.email}: ${resetUrl}`);
      }
    }

    res.json(response);
  }),
);

authRoutes.post(
  "/reset-password",
  asyncHandler(async (req, res) => {
    const input = resetPasswordSchema.parse(req.body);
    const tokenHash = hashPasswordResetToken(input.token);
    const resetToken = await prisma.passwordResetToken.findFirst({
      where: {
        tokenHash,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true, userId: true },
    });

    if (!resetToken) {
      throw new HttpError(400, "Password reset token is invalid or expired");
    }

    const passwordHash = await hashPassword(input.password);
    const usedAt = new Date();

    await prisma.$transaction([
      prisma.user.update({
        where: { id: resetToken.userId },
        data: { passwordHash },
      }),
      prisma.passwordResetToken.update({
        where: { id: resetToken.id },
        data: { usedAt },
      }),
      prisma.passwordResetToken.updateMany({
        where: {
          userId: resetToken.userId,
          usedAt: null,
          id: { not: resetToken.id },
        },
        data: { usedAt },
      }),
    ]);

    res.json({ message: "Password has been reset successfully" });
  }),
);

authRoutes.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
      },
    });

    res.json({ user });
  }),
);

authRoutes.get(
  "/verify-reset-token/:token",
  asyncHandler(async (req, res) => {
    const { token } = req.params;
    const tokenHash = hashPasswordResetToken(token);
    const resetToken = await prisma.passwordResetToken.findFirst({
      where: {
        tokenHash,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
    });

    if (!resetToken) {
      throw new HttpError(400, "Password reset token is invalid or expired");
    }

    res.json({ valid: true, message: "Token is valid" });
  }),
);

authRoutes.get(
  "/verify-email/:token",
  asyncHandler(async (req, res) => {
    const { token } = req.params;
    const tokenHash = hashPasswordResetToken(token);
    const verificationToken = await prisma.emailVerificationToken.findFirst({
      where: {
        tokenHash,
        verifiedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true, userId: true },
    });
    console.log({ verificationToken, hash: tokenHash });

    if (!verificationToken) {
      throw new HttpError(
        400,
        "Email verification token is invalid or expired",
      );
    }

    // Mark email as verified and mark token as used
    await prisma.$transaction([
      prisma.user.update({
        where: { id: verificationToken.userId },
        data: { emailVerified: true },
      }),
      prisma.emailVerificationToken.update({
        where: { id: verificationToken.id },
        data: { verifiedAt: new Date() },
      }),
    ]);

    res.json({
      message: "Email verified successfully! You can now login.",
    });
  }),
);

authRoutes.post("/logout", requireAuth, (_req, res) => {
  res.status(204).send();
});

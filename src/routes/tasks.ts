import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { HttpError } from "../utils/httpError.js";

export const taskRoutes = Router();

taskRoutes.use(requireAuth);

const taskSchema = z.object({
  businessId: z.string().min(1),
  reviewId: z.string().optional(),
  title: z.string().min(3),
  description: z.string().optional(),
  status: z.enum(["OPEN", "IN_PROGRESS", "DONE"]).optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH"]).default("MEDIUM"),
  dueDate: z.string().datetime().optional()
});

taskRoutes.get(
  "/",
  asyncHandler(async (req, res) => {
    const tasks = await prisma.task.findMany({
      where: { business: { ownerId: req.user!.id } },
      include: {
        business: { select: { name: true } },
        review: { select: { rating: true, content: true, reviewerName: true } }
      },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }]
    });

    res.json({ tasks });
  })
);

taskRoutes.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = taskSchema.parse(req.body);
    const business = await prisma.business.findFirst({
      where: { id: input.businessId, ownerId: req.user!.id }
    });

    if (!business) {
      throw new HttpError(404, "Business not found");
    }

    if (input.reviewId) {
      const review = await prisma.review.findFirst({
        where: { id: input.reviewId, businessId: business.id }
      });

      if (!review) {
        throw new HttpError(404, "Review not found");
      }
    }

    const task = await prisma.task.create({
      data: {
        businessId: business.id,
        reviewId: input.reviewId,
        title: input.title,
        description: input.description,
        status: input.status,
        priority: input.priority,
        dueDate: input.dueDate ? new Date(input.dueDate) : undefined
      }
    });

    res.status(201).json({ task });
  })
);

taskRoutes.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        status: z.enum(["OPEN", "IN_PROGRESS", "DONE"]).optional(),
        priority: z.enum(["LOW", "MEDIUM", "HIGH"]).optional()
      })
      .parse(req.body);
    const id = z.string().parse(req.params.id);

    const task = await prisma.task.findFirst({
      where: {
        id,
        business: { ownerId: req.user!.id }
      }
    });

    if (!task) {
      throw new HttpError(404, "Task not found");
    }

    const updated = await prisma.task.update({
      where: { id: task.id },
      data: input
    });

    res.json({ task: updated });
  })
);

taskRoutes.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = z.string().parse(req.params.id);
    const task = await prisma.task.findFirst({
      where: {
        id,
        business: { ownerId: req.user!.id }
      }
    });

    if (!task) {
      throw new HttpError(404, "Task not found");
    }

    await prisma.task.delete({ where: { id: task.id } });
    res.status(204).send();
  })
);

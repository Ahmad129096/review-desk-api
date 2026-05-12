import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { HttpError } from "../utils/httpError.js";

export const businessRoutes = Router();

businessRoutes.use(requireAuth);

const businessSchema = z.object({
  name: z.string().min(2),
  industry: z.string().min(2),
  website: z.string().url().optional().or(z.literal("")),
  phone: z.string().optional(),
  address: z.string().optional(),
  defaultTone: z.enum(["FRIENDLY", "PROFESSIONAL", "APOLOGETIC"]).default("PROFESSIONAL")
});

businessRoutes.get(
  "/",
  asyncHandler(async (req, res) => {
    const businesses = await prisma.business.findMany({
      where: { ownerId: req.user!.id },
      orderBy: { createdAt: "desc" }
    });

    res.json({ businesses });
  })
);

businessRoutes.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = z.string().parse(req.params.id);
    const business = await prisma.business.findFirst({
      where: { id, ownerId: req.user!.id }
    });

    if (!business) {
      throw new HttpError(404, "Business not found");
    }

    res.json({ business });
  })
);

businessRoutes.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = businessSchema.parse(req.body);
    const business = await prisma.business.create({
      data: {
        ownerId: req.user!.id,
        name: input.name,
        industry: input.industry,
        website: input.website || null,
        phone: input.phone,
        address: input.address,
        defaultTone: input.defaultTone
      }
    });

    res.status(201).json({ business });
  })
);

businessRoutes.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const input = businessSchema.partial().parse(req.body);
    const id = z.string().parse(req.params.id);
    const existing = await prisma.business.findFirst({
      where: { id, ownerId: req.user!.id }
    });

    if (!existing) {
      throw new HttpError(404, "Business not found");
    }

    const business = await prisma.business.update({
      where: { id: existing.id },
      data: {
        ...input,
        website: input.website === "" ? null : input.website
      }
    });

    res.json({ business });
  })
);

import { z } from "zod";

/**
 * Bounds mirror the DB CHECK constraints added in migration
 * 1791300000000_circle-size-contribution-constraints.ts (issue #226 / #426).
 *
 * maxMembers:          2 – 50   (DB: circles_max_members_min / _max)
 * contributionAmount:  500 – 1,000,000 NGN  (DB: contribution_ngn_min / _max)
 *
 * Validating here before the DB call means clients receive a structured 422
 * with field-level messages instead of a raw PostgreSQL constraint error.
 */
export const createCircleSchema = z.object({
  name: z.string().min(3, "Circle name must be at least 3 characters").max(60),
  contributionAmount: z
    .number()
    .int("Contribution amount must be a whole number")
    .min(500, "Minimum contribution is 500 NGN")
    .max(1_000_000, "Maximum contribution is 1,000,000 NGN"),
  contributionCurrency: z.enum(["NGN", "GBP", "USD", "EUR"], {
    errorMap: () => ({ message: "Currency must be NGN, GBP, USD, or EUR" }),
  }),
  maxMembers: z.number().int().min(2, "Minimum 2 members").max(50, "Maximum 50 members"),
  cycleFrequency: z.enum(["weekly", "biweekly", "monthly"]),
  circleType: z.enum(["public", "private"]).default("public"),
  gracePeriodHours: z.number().int().min(0).max(168).default(24),
  payoutMethod: z.enum(["fixed", "randomized"]).default("fixed"),
  yieldStrategy: z.enum(["none", "blend"]).default("none"),
  penaltyPercent: z.number().int().min(0).max(100).default(10),
  templateId: z.string().max(60).optional(),
});

export const joinCircleSchema = z.object({
  circleId: z.string().uuid(),
  stellarPublicKey: z.string().length(56, "Invalid Stellar public key"),
  token: z.string().optional(),
});

export const verifyOtpSchema = z.object({
  phone: z.string().regex(/^\+?[1-9]\d{9,14}$/),
  otp: z.string().length(6),
});

export const sendOtpSchema = z.object({
  phone: z.string().regex(/^\+?[1-9]\d{9,14}$/, "Invalid phone number"),
});

export const smsPreferencesSchema = z.object({
  enabled: z.boolean({ invalid_type_error: "enabled must be a boolean" }),
});

export type CreateCircleInput = z.infer<typeof createCircleSchema>;
export type JoinCircleInput = z.infer<typeof joinCircleSchema>;
export type VerifyOtpInput = z.infer<typeof verifyOtpSchema>;
export type SendOtpInput = z.infer<typeof sendOtpSchema>;
export type SmsPreferencesInput = z.infer<typeof smsPreferencesSchema>;

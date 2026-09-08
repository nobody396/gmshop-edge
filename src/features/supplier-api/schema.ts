import { z } from "zod";
import { sensitiveProofSchema } from "#/features/auth/reauthentication-schema";

export const supplierApiKeyCreateSchema = sensitiveProofSchema.extend({
	name: z.string().trim().min(1).max(100),
});

export const supplierApiKeyIdSchema = z.object({ id: z.uuid() });

export const supplierExportListingSchema = z.object({
	sellableItemId: z.uuid(),
	enabled: z.boolean(),
	price: z
		.string()
		.trim()
		.regex(/^(0|[1-9]\d*)(\.\d{1,8})?$/),
});

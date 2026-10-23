import { z } from 'zod';

export const AutonomousScopeSchema = z.object({
  milestone: z.string().trim().min(1).optional(),
}).optional();
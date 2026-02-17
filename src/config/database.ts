import { PrismaClient } from "@prisma/client";

// Instância singleton do Prisma — usada por todos os services
// Em development loga apenas erros e warns (query é muito verboso)
export const prisma = new PrismaClient({
    log: ["error", "warn"],
});

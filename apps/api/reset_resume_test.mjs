import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is not loaded");
}

const pool = new pg.Pool({
  connectionString,
});

const adapter = new PrismaPg(pool);

const prisma = new PrismaClient({
  adapter,
});

const resumeId = "d48fd964-e361-41bd-bf68-d019da40a9ba";

try {
  const resume = await prisma.resumeImport.update({
    where: {
      id: resumeId,
    },
    data: {
      status: "PROCESSING",
      errorMessage: null,
    },
  });

  console.log("Resume reset successfully:");
  console.log({
    id: resume.id,
    status: resume.status,
    fileName: resume.fileName,
  });
} finally {
  await prisma.$disconnect();
  await pool.end();
}

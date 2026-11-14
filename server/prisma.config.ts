// Prisma 7 config. `datasource.url` falls back to "" so `prisma generate` works with no
// database; `prisma migrate deploy` gets DIRECT_URL from the Start_Script's child env (Req 20.16).

import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DIRECT_URL ?? "",
  },
});

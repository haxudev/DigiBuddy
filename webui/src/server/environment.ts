import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

export function loadLocalEnvironment(directory = process.cwd()) {
  if (process.env.NODE_ENV === "production") return;
  for (const name of [".env.local", ".env"]) {
    try {
      loadEnvFile(resolve(directory, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

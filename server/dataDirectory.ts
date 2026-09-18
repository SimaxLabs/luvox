import path from "node:path";

export function getLuvoxDataDirectory(): string {
  const configured = process.env.LUVOX_DATA_DIR?.trim();
  if (configured && !path.isAbsolute(configured)) {
    throw new Error("LUVOX_DATA_DIR must be an absolute path.");
  }
  return configured || path.resolve(process.cwd(), ".luvox");
}

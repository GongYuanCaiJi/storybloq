import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface LatestHandoverInfo {
  filename: string;
  date: string | null;
  heading: string | null;
}

export async function findLatestHandover(handoversDir: string): Promise<LatestHandoverInfo | null> {
  const files = await readdir(handoversDir);
  const mdFiles = files.filter((f) => f.endsWith(".md"));
  if (mdFiles.length === 0) return null;

  const latest = mdFiles.reduce((a, b) => (a > b ? a : b));
  const dateMatch = latest.match(/^(\d{4}-\d{2}-\d{2})/);
  const date = dateMatch ? dateMatch[1]! : null;

  let heading: string | null = null;
  try {
    const content = await readFile(join(handoversDir, latest), "utf-8");
    const headingMatch = content.match(/^#\s+(.+)/m);
    if (headingMatch) {
      heading = headingMatch[1]!.trim();
      if (heading.length > 120) {
        heading = heading.slice(0, 117) + "...";
      }
    }
  } catch {
    // read error, skip heading
  }

  return { filename: latest, date, heading };
}

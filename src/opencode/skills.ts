import { access, cp, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const GLOBAL_SKILLS_DIR = join(homedir(), ".config", "opencode", "skills");
const GLOBAL_CRON_SKILL_DIR = join(GLOBAL_SKILLS_DIR, "cron");
const GLOBAL_CRON_SKILL_FILE = join(GLOBAL_CRON_SKILL_DIR, "SKILL.md");

function repoRootFromModule(): string {
  const current = dirname(fileURLToPath(import.meta.url));
  return resolve(current, "..", "..");
}

export function globalCronSkillPath(): string {
  return GLOBAL_CRON_SKILL_FILE;
}

export async function hasGlobalCronSkill(): Promise<boolean> {
  try {
    await access(GLOBAL_CRON_SKILL_FILE);
    return true;
  } catch {
    return false;
  }
}

export async function syncCronSkillToGlobal(): Promise<void> {
  const source = join(repoRootFromModule(), "skills", "cron");
  await access(join(source, "SKILL.md"));
  if (await hasGlobalCronSkill()) {
    console.log(`[opencodebot] cron skill already exists, skip sync -> ${GLOBAL_CRON_SKILL_DIR}`);
    return;
  }
  await mkdir(dirname(GLOBAL_CRON_SKILL_DIR), { recursive: true });
  await cp(source, GLOBAL_CRON_SKILL_DIR, { recursive: true, force: true });
  console.log(`[opencodebot] synced cron skill -> ${GLOBAL_CRON_SKILL_DIR}`);
}

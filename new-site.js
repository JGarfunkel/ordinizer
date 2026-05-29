#!/usr/bin/env node
/**
 * Scaffold a new Ordinizer-powered website.
 *
 * Usage:
 *   node new-site.js <project-name> [--local]
 *
 * --local  Install ordinizer packages from the local monorepo instead of npm.
 */

import { execSync } from "child_process";
import { readdirSync, statSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import readline from "readline";

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const localFlag = args.includes("--local");
const nameArg = args.find((a) => !a.startsWith("--"));

function ask(question, defaultVal) {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const prompt = defaultVal ? `${question} (${defaultVal}): ` : `${question}: `;
    rl.question(prompt, (answer) => {
      rl.close();
      res(answer.trim() || defaultVal || "");
    });
  });
}

function toDisplayName(name) {
  return name
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function copyDir(src, dest, vars) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    // "gitignore" in sample → ".gitignore" in destination
    const destName = entry === "gitignore" ? ".gitignore" : entry;
    const destPath = join(dest, destName);
    if (statSync(srcPath).isDirectory()) {
      copyDir(srcPath, destPath, vars);
    } else {
      let content = readFileSync(srcPath, "utf-8");
      content = content
        .replace(/\{\{name\}\}/g, vars.name)
        .replace(/\{\{displayName\}\}/g, vars.displayName)
        .replace(/\{\{description\}\}/g, vars.description);
      writeFileSync(destPath, content, "utf-8");
    }
  }
}

async function main() {
  const name = nameArg || (await ask("Project name (kebab-case)"));
  if (!name) {
    console.error("Project name is required.");
    process.exit(1);
  }

  const defaultDisplay = toDisplayName(name);
  const displayName = await ask("Display name", defaultDisplay);
  const description = await ask(
    "Short description",
    `${displayName} — powered by Ordinizer`
  );

  const targetDir = resolve(__dirname, "..", name);

  if (existsSync(targetDir)) {
    console.error(`\nDirectory already exists: ${targetDir}`);
    process.exit(1);
  }

  console.log(`\nCreating project at ${targetDir}...`);
  const sampleDir = join(__dirname, "sample");
  copyDir(sampleDir, targetDir, { name, displayName, description });
  console.log("Files created.");

  console.log("\nInstalling base dependencies...");
  execSync("npm install", { cwd: targetDir, stdio: "inherit" });

  if (localFlag) {
    console.log("\nInstalling ordinizer from local repo...");
    const clientPath = join(__dirname, "app/client");
    const serverPath = join(__dirname, "app/server");
    const analyzerPath = join(__dirname, "app/analyzer");
    execSync(
      `npm install "${clientPath}" "${serverPath}" "${analyzerPath}"`,
      { cwd: targetDir, stdio: "inherit" }
    );
  } else {
    console.log("\nInstalling latest ordinizer packages...");
    execSync(
      "npm install @civillyengaged/ordinizer-client@latest @civillyengaged/ordinizer-server@latest",
      { cwd: targetDir, stdio: "inherit" }
    );
  }

  console.log(`
Done! Next steps:
  cd ../${name}
  cp .env.example .env
  # Edit .env with your API keys
  npm run dev
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

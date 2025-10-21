import fs from "fs";
import { execSync } from "child_process";
import { tmpdir } from "os";
import path from "path";
import crypto from "crypto";

const HISTORY_DIR = "script";
const MAIN_FILE = path.join(HISTORY_DIR, "commit-history-main.json");

const HISTORY_EXCLUDE_GLOB = `${HISTORY_DIR}/commit-history*.json`;

function sh(cmd) {
  return execSync(cmd, { stdio: "pipe" }).toString().trim();
}

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}

function sanitizeBranchName(name) {
  return (name || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function getRemoteHttpUrl() {
  try {
    const raw = sh("git config --get remote.origin.url").replace(/\.git$/, "");
    if (raw.startsWith("http")) return raw;
    const m = raw.match(/^git@([^:]+):(.+)$/);
    if (m) return `https://${m[1]}/${m[2]}`;
  } catch {
  }
  return "";
}

function getCommitInfo(sha) {
  let commitMessage = "";
  let commitDateIso = "";
  let author = "";
  try {
    commitMessage = sh(`git log -1 --pretty=%B ${sha}`);
    commitDateIso = sh(`git log -1 --pretty=%cI ${sha}`);
    author = sh(`git log -1 --pretty=%an ${sha}`);
  } catch (error) {
    console.error(`Error leyendo metadatos del commit ${sha}:`, error.message);
    return null;
  }

  const repoUrl = getRemoteHttpUrl();
  const commitUrl = repoUrl ? `${repoUrl}/commit/${sha}` : "";

  let additions = 0;
  let deletions = 0;
  try {
    let parentRef = `${sha}~1`;
    try {
      const parents = sh(`git log -1 --pretty=%P ${sha}`);
      if (parents) {
        const firstParent = parents.split(" ")[0];
        if (firstParent) parentRef = firstParent;
      }
    } catch {
    }

    try {
      const diffStats = sh(
        `git diff --stat ${parentRef} ${sha} -- ":!${HISTORY_EXCLUDE_GLOB}"`
      );
      const addM = diffStats.match(/(\d+)\s+insertion/);
      const delM = diffStats.match(/(\d+)\s+deletion/);
      additions = addM ? parseInt(addM[1], 10) : 0;
      deletions = delM ? parseInt(delM[1], 10) : 0;
    } catch {

      const showStats = sh(
        `git show --stat ${sha} -- ":!${HISTORY_EXCLUDE_GLOB}"`
      );
      const addM = showStats.match(/(\d+)\s+insertion/);
      const delM = showStats.match(/(\d+)\s+deletion/);
      additions = addM ? parseInt(addM[1], 10) : 0;
      deletions = delM ? parseInt(delM[1], 10) : 0;
    }
  } catch (e) {
    console.warn(`No se pudieron calcular stats para ${sha}:`, e.message);
  }

  let testCount = 0;
  let coverage = 0;
  let failedTests = 0;
  let conclusion = "neutral";

  if (fs.existsSync("package.json")) {
    const tempDir = tmpdir();
    const randomId = crypto.randomBytes(8).toString("hex");
    const outputPath = path.join(tempDir, `jest-results-${randomId}.json`);
    try {
      try {
        sh(
          `npx jest --coverage --json --outputFile=${outputPath} --passWithNoTests`
        );
      } catch {
      }

      if (fs.existsSync(outputPath)) {
        const jestResults = JSON.parse(fs.readFileSync(outputPath, "utf8"));
        testCount = jestResults.numTotalTests || 0;
        failedTests = jestResults.numFailedTests || 0;

        if (jestResults.coverageMap) {
          const coverageMap = jestResults.coverageMap;
          let covered = 0;
          let total = 0;
          for (const file of Object.values(coverageMap)) {
            const s = file.s;
            const fileTotal = Object.keys(s).length;
            const fileCovered = Object.values(s).filter((v) => v > 0).length;
            total += fileTotal;
            covered += fileCovered;
          }
          if (total > 0) {
            coverage = Math.round((covered / total) * 10000) / 100; // 2 decimales
          }
        }

        conclusion =
          testCount > 0 ? (failedTests > 0 ? "failure" : "success") : "neutral";

        try {
          fs.unlinkSync(outputPath);
        } catch {}
      } else {
        console.warn("Advertencia: Jest no generó el archivo JSON de resultados.");
      }
    } catch (err) {
      console.warn("Error al procesar resultados de pruebas:", err.message);
    }
  }

  let branch = "";
  try {
    branch = sh("git rev-parse --abbrev-ref HEAD");
  } catch {}

  const dateYmd = (commitDateIso || "").split("T")[0] || "";

  return {
    sha,
    author,
    branch,
    commit: {
      date: commitDateIso,
      message: commitMessage,
      url: commitUrl,
    },
    stats: {
      total: additions + deletions,
      additions,
      deletions,
      date: dateYmd,
    },
    coverage,
    test_count: testCount,
    failed_tests: failedTests,
    conclusion,
  };
}

function loadHistory(filePath) {
  if (fs.existsSync(filePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }
  return [];
}

function saveHistory(filePath, commits) {
  commits.sort((a, b) => new Date(a.commit.date) - new Date(b.commit.date));
  fs.writeFileSync(filePath, JSON.stringify(commits, null, 2));
}

function appendEntry(filePath, entry) {
  let commits = loadHistory(filePath);
  commits.push(entry);
  saveHistory(filePath, commits);
}

function validateEntry(entry) {
  if (entry.sha === "HEAD") {
    throw new Error('Entrada inválida: sha="HEAD" está prohibido.');
  }
  if (entry.commit?.url && /\/commit\/HEAD$/.test(entry.commit.url)) {
    throw new Error("Entrada inválida: la URL del commit termina en /commit/HEAD.");
  }
  if (entry.commit?.url && !entry.commit.url.endsWith(entry.sha)) {
    throw new Error("Entrada inválida: la URL del commit no termina en el SHA.");
  }
  if (!entry.branch) {
    throw new Error('Entrada inválida: falta el campo "branch".');
  }
}

try {
  ensureDir(HISTORY_DIR);

  // SHA real del commit recién creado (post-commit)
  const sha = sh("git rev-parse HEAD");
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    throw new Error(`SHA inválido: ${sha}`);
  }

  const entry = getCommitInfo(sha);
  if (!entry) throw new Error("No se pudo construir la entrada del commit.");

  validateEntry(entry);

  // Archivo de rama
  const safeBranch = sanitizeBranchName(entry.branch);
  const BRANCH_FILE = path.join(
    HISTORY_DIR,
    `commit-history-${safeBranch}.json`
  );
  if (!fs.existsSync(BRANCH_FILE)) {
    fs.writeFileSync(BRANCH_FILE, JSON.stringify([], null, 2));
  }
  appendEntry(BRANCH_FILE, entry);

  if (entry.branch === "main") {
    if (!fs.existsSync(MAIN_FILE)) {
      fs.writeFileSync(MAIN_FILE, JSON.stringify([], null, 2));
    }
    appendEntry(MAIN_FILE, entry);
  }
} catch (error) {
  console.error("Error en el tracker:", error.message);
  process.exit(1);
}

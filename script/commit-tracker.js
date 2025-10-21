import fs from "fs";
import { execSync } from "child_process";
import { tmpdir } from "os";
import path from "path";
import crypto from "crypto";

const DATA_FILE = "script/commit-history.json";

function sh(cmd) {
  return execSync(cmd, { stdio: "pipe" }).toString().trim();
}

function getRemoteHttpUrl() {
  try {
    const raw = sh("git config --get remote.origin.url").replace(/\.git$/, "");
    if (raw.startsWith("http")) return raw;
    const m = raw.match(/^git@([^:]+):(.+)$/);
    if (m) return `https://${m[1]}/${m[2]}`;
  } catch {}
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
    } catch {}

    try {
      const diffStats = sh(
        `git diff --stat ${parentRef} ${sha} -- ":!${DATA_FILE}" ":!script/commit-history-*.json"`
      );
      const addM = diffStats.match(/(\d+)\s+insertion/);
      const delM = diffStats.match(/(\d+)\s+deletion/);
      additions = addM ? parseInt(addM[1], 10) : 0;
      deletions = delM ? parseInt(delM[1], 10) : 0;
    } catch {
      const showStats = sh(
        `git show --stat ${sha} -- ":!${DATA_FILE}" ":!script/commit-history-*.json"`
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
        sh(`npx jest --coverage --json --outputFile=${outputPath} --passWithNoTests`);
      } catch {}

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
            coverage = Math.round(((covered / total) * 100) * 100) / 100;
          }
        }

        conclusion = testCount > 0 ? (failedTests > 0 ? "failure" : "success") : "neutral";
        try { fs.unlinkSync(outputPath); } catch {}
      }
    } catch (err) {
      console.warn("Error al procesar resultados de pruebas:", err.message);
    }
  }

  let branch = "";
  try { branch = sh("git rev-parse --abbrev-ref HEAD"); } catch {}

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

function saveCommitData(entry) {
  // --- Guardar en el archivo general (igual que antes) ---
  let commits = [];
  if (fs.existsSync(DATA_FILE)) {
    try {
      commits = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      if (!Array.isArray(commits)) commits = [];
    } catch {
      commits = [];
    }
  }
  commits.push(entry);
  commits.sort((a, b) => new Date(a.commit.date) - new Date(b.commit.date));
  fs.writeFileSync(DATA_FILE, JSON.stringify(commits, null, 2));

  // --- NUEVO: Guardar también en el archivo por rama ---
  if (entry.branch && entry.branch !== "HEAD") {
    const branchFile = `script/commit-history-${entry.branch}.json`;
    let branchCommits = [];
    if (fs.existsSync(branchFile)) {
      try {
        branchCommits = JSON.parse(fs.readFileSync(branchFile, "utf8"));
        if (!Array.isArray(branchCommits)) branchCommits = [];
      } catch {
        branchCommits = [];
      }
    }
    branchCommits.push(entry);
    branchCommits.sort((a, b) => new Date(a.commit.date) - new Date(b.commit.date));
    fs.writeFileSync(branchFile, JSON.stringify(branchCommits, null, 2));
  }
}

try {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify([], null, 2));
  }

  const sha = sh("git rev-parse HEAD");
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    throw new Error(`SHA inválido: ${sha}`);
  }

  const entry = getCommitInfo(sha);
  if (!entry) throw new Error("No se pudo construir la entrada del commit.");
  saveCommitData(entry);
} catch (error) {
  console.error("Error en el tracker:", error.message);
  process.exit(1);
}

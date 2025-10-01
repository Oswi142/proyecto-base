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
  } catch {
    // sin remoto: OK, dejamos URL vacía
  }
  return "";
}

function getCommitInfo(sha) {
  // --- Metadatos del commit ---
  let commitMessage = "";
  let commitDateIso = "";
  let author = "";
  try {
    commitMessage = sh(`git log -1 --pretty=%B ${sha}`);
    // %cI = fecha ISO 8601 del committer
    commitDateIso = sh(`git log -1 --pretty=%cI ${sha}`);
    author = sh(`git log -1 --pretty=%an ${sha}`);
  } catch (error) {
    console.error(`Error leyendo metadatos del commit ${sha}:`, error.message);
    return null;
  }

  // --- URL del repo normalizada ---
  const repoUrl = getRemoteHttpUrl();
  const commitUrl = repoUrl ? `${repoUrl}/commit/${sha}` : "";

  // --- Stats del diff (excluyendo el archivo de historial) ---
  let additions = 0;
  let deletions = 0;
  try {
    // parent por defecto: sha~1; si es el primer commit, caerá en el catch interno
    let parentRef = `${sha}~1`;

    try {
      // detectar merge: usamos el primer parent real si existe
      const parents = sh(`git log -1 --pretty=%P ${sha}`);
      if (parents) {
        const firstParent = parents.split(" ")[0];
        if (firstParent) parentRef = firstParent;
      }
    } catch {
      // si no hay parents, seguimos con sha~1 y caemos abajo si falla el diff
    }

    try {
      const diffStats = sh(
        `git diff --stat ${parentRef} ${sha} -- ":!${DATA_FILE}"`
      );
      const addM = diffStats.match(/(\d+)\s+insertion/);
      const delM = diffStats.match(/(\d+)\s+deletion/);
      additions = addM ? parseInt(addM[1], 10) : 0;
      deletions = delM ? parseInt(delM[1], 10) : 0;
    } catch {
      // Primer commit: no hay parent comparable
      const showStats = sh(`git show --stat ${sha} -- ":!${DATA_FILE}"`);
      const addM = showStats.match(/(\d+)\s+insertion/);
      additions = addM ? parseInt(addM[1], 10) : 0;
      deletions = 0;
    }
  } catch (e) {
    console.warn(`No se pudieron calcular stats para ${sha}:`, e.message);
  }

  // --- Pruebas (Jest) ---
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
      } catch {
      }

      if (fs.existsSync(outputPath)) {
        const jestResults = JSON.parse(fs.readFileSync(outputPath, "utf8"));
        testCount = jestResults.numTotalTests || 0;
        failedTests = jestResults.numFailedTests || 0;

        // Cobertura (si coverageMap está presente)
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

        // limpieza
        try { fs.unlinkSync(outputPath); } catch {}
      } else {
        console.warn("Advertencia: Jest no generó el archivo JSON de resultados.");
      }
    } catch (err) {
      console.warn("Error al procesar resultados de pruebas:", err.message);
    }
  }

  let branch = "";
  try { branch = sh("git rev-parse --abbrev-ref HEAD"); } catch {}

  const dateYmd = (commitDateIso || "").split("T")[0] || "";

  return {
    sha,//SIEMPRE el SHA real
    author,
    branch,
    commit: {
      date: commitDateIso,
      message: commitMessage,
      url: commitUrl//termina en /commit/<sha>
    },
    stats: {
      total: additions + deletions,
      additions,
      deletions,
      date: dateYmd
    },
    coverage,
    test_count: testCount,
    failed_tests: failedTests,
    conclusion
  };
}

function saveCommitData(entry) {
  // Validaciones duras anti-HEAD
  if (entry.sha === "HEAD") {
    throw new Error('Entrada inválida: sha="HEAD" está prohibido.');
  }
  if (entry.commit?.url && /\/commit\/HEAD$/.test(entry.commit.url)) {
    throw new Error("Entrada inválida: la URL del commit termina en /commit/HEAD.");
  }
  if (entry.commit?.url && !entry.commit.url.endsWith(entry.sha)) {
    throw new Error("Entrada inválida: la URL del commit no termina en el SHA.");
  }

  // Leer/crear historial
  let commits = [];
  if (fs.existsSync(DATA_FILE)) {
    try {
      commits = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      if (!Array.isArray(commits)) commits = [];
    } catch {
      commits = [];
    }
  }

  // Append del commit actual
  commits.push(entry);

  // Orden por fecha de commit (ISO)
  commits.sort((a, b) => new Date(a.commit.date) - new Date(b.commit.date));

  fs.writeFileSync(DATA_FILE, JSON.stringify(commits, null, 2));
}

try {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify([], null, 2));
  }

  // SHA real del commit recién creado (post-commit)
  const sha = sh("git rev-parse HEAD");
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    throw new Error(`SHA inválido: ${sha}`);
  }

  const entry = getCommitInfo(sha);
  if (!entry) {
    throw new Error("No se pudo construir la entrada del commit.");
  }

  saveCommitData(entry);
} catch (error) {
  console.error("Error en el tracker:", error.message);
  process.exit(1);
}

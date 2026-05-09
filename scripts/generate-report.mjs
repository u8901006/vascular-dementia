#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = join(__dirname, "..", "docs");

const API_BASE = "https://open.bigmodel.cn/api/coding/paas/v4";
const MODEL_PRIORITY = ["glm-5-turbo", "glm-4.7", "glm-4.7-flash"];

const SYSTEM_PROMPT = `你是血管型失智症與腦血管認知障礙領域的專業摘要與分析專家。你的任務是：
1. 從提供的學術論文中，擷取出最新的趨勢與研究價值的要點
2. 每篇論文請以中文提供簡明摘要、重點、PICO 分析
3. 評估其臨床實用性（高/中/低）
4. 用專業、準確、適合醫療人員閱讀的語氣

輸出格式要求：
- 語言：中文（台灣用語）
- 專業術語保留原文
- 每篇論文包含：中文標題、一句話摘要、PICO 分析、臨床實用性、關鍵標籤
- 最後提供今日 TOP 3（最有趣/最影響臨床的論文）
嚴格使用 JSON 格式回傳，不要用 markdown code block 包裝。`;

function loadPapers(inputPath) {
  return JSON.parse(readFileSync(inputPath, "utf-8"));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function robustJsonParse(text) {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    const firstNewline = cleaned.indexOf("\n");
    cleaned = firstNewline >= 0 ? cleaned.slice(firstNewline + 1) : cleaned.slice(3);
    cleaned = cleaned.replace(/```+\s*$/g, "").trim();
  }
  try {
    return JSON.parse(cleaned);
  } catch (e1) {
    console.error(`[WARN] Initial JSON parse failed: ${e1.message}`);
  }

  const jsonStart = cleaned.indexOf("{");
  const jsonEnd = cleaned.lastIndexOf("}");
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    const candidate = cleaned.slice(jsonStart, jsonEnd + 1);
    try {
      return JSON.parse(candidate);
    } catch (e2) {
      console.error(`[WARN] Extracted JSON parse failed: ${e2.message}`);
    }
  }

  const fixed = cleaned
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/\\n/g, " ")
    .replace(/[\x00-\x1f]/g, (c) => (c === "\n" || c === "\r" || c === "\t" ? " " : ""));
  try {
    return JSON.parse(fixed);
  } catch (e3) {
    console.error(`[WARN] Fixed JSON parse failed: ${e3.message}`);
  }

  return null;
}

async function callZhipuAPI(apiKey, model, payload, timeout = 480000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(`${API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (resp.status === 429) {
      throw { retryAfter: 60, isRateLimit: true };
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
    }
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

async function analyzePapers(apiKey, papersData) {
  const dateStr = papersData.date;
  const paperCount = papersData.count;
  const papersText = JSON.stringify(papersData.papers, null, 2);

  const prompt = `以下是 ${dateStr} 從 PubMed 與 Europe PMC 抓取的最新血管型失智症相關論文（共 ${paperCount} 篇）。

請進行以下分析，並以 JSON 格式回傳（不要用 markdown code block）：

{
  "date": "${dateStr}",
  "market_summary": "1-2句話總結今日論文的整體態勢與焦點",
  "top_picks": [
    {
      "rank": 1,
      "title_zh": "中文標題",
      "title_en": "English Title",
      "journal": "期刊名",
      "summary": "一句話摘要（中文，點出核心發現與臨床趨勢）",
      "pico": {
        "population": "研究對象",
        "intervention": "介入措施",
        "comparison": "對照組",
        "outcome": "主要結果"
      },
      "clinical_utility": "高/中/低",
      "utility_reason": "說明實用性的原因（一句話）",
      "tags": ["標籤1", "標籤2"],
      "url": "論文連結",
      "emoji": "合適emoji"
    }
  ],
  "all_papers": [
    {
      "title_zh": "中文標題",
      "title_en": "English Title",
      "journal": "期刊名",
      "summary": "一句話摘要",
      "clinical_utility": "高/中/低",
      "tags": ["標籤1"],
      "url": "連結",
      "emoji": "emoji"
    }
  ],
  "keywords": ["關鍵字1", "關鍵字2"],
  "topic_distribution": {
    "血管型失智症": 3,
    "腦血管小血管疾病": 2
  }
}

原始論文資料：
${papersText}

請挑出最重要的 TOP 5-8 篇論文放入 top_picks（按重要性排序），其餘放入 all_papers。
每篇 paper 的 tags 列請從以下選：血管型失智症、腦血管認知障礙、中風後認知障礙、腦小血管疾病、腦白質病變、混合型失智症、高血壓、糖尿病、心血管風險、神經影像、神經發炎、神經心理學、憂鬱症、冷漠、日常生活功能、照護者負擔、長期照護、營養與飲食、運動與復健、社會決定因素、診斷標準、生物標記、預防策略、藥物治療、認知訓練、CADASIL、腦類澱粉血管病變、睡眠、老年醫學。
注意：嚴格 JSON，不要用 \`\`\`json\`\`\` 包裝`;

  const payload = {
    model: MODEL_PRIORITY[0],
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    temperature: 0.3,
    top_p: 0.9,
    max_tokens: 50000,
  };

  for (const model of MODEL_PRIORITY) {
    payload.model = model;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        console.error(`[INFO] Trying ${model} (attempt ${attempt + 1})...`);
        const data = await callZhipuAPI(apiKey, model, payload, 480000);
        const text = data.choices?.[0]?.message?.content?.trim() || "";
        if (!text) {
          console.error(`[WARN] Empty response from ${model}`);
          continue;
        }
        const result = robustJsonParse(text);
        if (!result) {
          console.error(`[WARN] Could not parse JSON from ${model}`);
          if (attempt < 2) await sleep(5000);
          continue;
        }
        console.error(
          `[INFO] Analysis complete: ${result.top_picks?.length || 0} top picks, ${result.all_papers?.length || 0} total`
        );
        return result;
      } catch (e) {
        if (e.isRateLimit) {
          const wait = e.retryAfter * (attempt + 1);
          console.error(`[WARN] Rate limited, waiting ${wait}s...`);
          await sleep(wait * 1000);
          continue;
        }
        console.error(`[ERROR] ${model} failed: ${e.message}`);
        break;
      }
    }
  }

  console.error("[ERROR] All models and attempts failed");
  return null;
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function generateHtml(analysis) {
  const dateStr = analysis.date || new Date().toISOString().split("T")[0];
  const dateParts = dateStr.split("-");
  const dateDisplay =
    dateParts.length === 3
      ? `${dateParts[0]}年${parseInt(dateParts[1])}月${parseInt(dateParts[2])}日`
      : dateStr;
  const summary = analysis.market_summary || "";
  const topPicks = analysis.top_picks || [];
  const allPapers = analysis.all_papers || [];
  const keywords = analysis.keywords || [];
  const topicDist = analysis.topic_distribution || {};
  const totalCount = topPicks.length + allPapers.length;

  const topicEntries = Object.entries(topicDist).sort((a, b) => b[1] - a[1]);
  const maxTopicCount = topicEntries.length ? topicEntries[0][1] : 1;

  const utilityColor = (u) => {
    const v = String(u || "").toLowerCase();
    if (v.includes("高")) return "#5a7a3a";
    if (v.includes("中")) return "#9f7a2e";
    return "#766453";
  };

  const utilityLabel = (u) => {
    const v = String(u || "").toLowerCase();
    if (v.includes("高")) return "高實用性";
    if (v.includes("中")) return "中實用性";
    return "低實用性";
  };

  const topPicksHtml = topPicks
    .map(
      (p, i) => `
    <div class="card featured" style="animation-delay:${0.08 * (i + 1)}s">
      <div class="card-header">
        <span class="rank-badge">TOP ${p.rank || i + 1}</span>
        <span class="emoji">${escapeHtml(p.emoji)}</span>
        <span class="utility-badge" style="background:${utilityColor(p.clinical_utility)}">${utilityLabel(p.clinical_utility)}</span>
      </div>
      <h3 class="card-title">${escapeHtml(p.title_zh)}</h3>
      <p class="card-title-en">${escapeHtml(p.title_en)}</p>
      <p class="card-journal">${escapeHtml(p.journal)}</p>
      <p class="card-summary">${escapeHtml(p.summary)}</p>
      ${
        p.pico
          ? `<div class="pico-grid">
        <div class="pico-item"><span class="pico-label">P</span><span class="pico-text">${escapeHtml(p.pico.population)}</span></div>
        <div class="pico-item"><span class="pico-label">I</span><span class="pico-text">${escapeHtml(p.pico.intervention)}</span></div>
        <div class="pico-item"><span class="pico-label">C</span><span class="pico-text">${escapeHtml(p.pico.comparison)}</span></div>
        <div class="pico-item"><span class="pico-label">O</span><span class="pico-text">${escapeHtml(p.pico.outcome)}</span></div>
      </div>`
          : ""
      }
      ${p.utility_reason ? `<p class="utility-reason">💡 ${escapeHtml(p.utility_reason)}</p>` : ""}
      <div class="card-tags">${(p.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("")}</div>
      ${p.url ? `<a class="card-link" href="${escapeHtml(p.url)}" target="_blank" rel="noopener noreferrer">查看原文 →</a>` : ""}
    </div>`
    )
    .join("\n");

  const allPapersHtml = allPapers
    .map(
      (p, i) => `
    <div class="card" style="animation-delay:${0.04 * (i + 1)}s">
      <div class="card-header">
        <span class="emoji">${escapeHtml(p.emoji)}</span>
        <span class="utility-badge small" style="background:${utilityColor(p.clinical_utility)}">${utilityLabel(p.clinical_utility)}</span>
      </div>
      <h3 class="card-title">${escapeHtml(p.title_zh)}</h3>
      <p class="card-title-en">${escapeHtml(p.title_en)}</p>
      <p class="card-journal">${escapeHtml(p.journal)}</p>
      <p class="card-summary">${escapeHtml(p.summary)}</p>
      <div class="card-tags">${(p.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("")}</div>
      ${p.url ? `<a class="card-link" href="${escapeHtml(p.url)}" target="_blank" rel="noopener noreferrer">查看原文 →</a>` : ""}
    </div>`
    )
    .join("\n");

  const topicBarsHtml = topicEntries
    .slice(0, 10)
    .map(
      ([name, count]) => `
    <div class="topic-bar-row">
      <span class="topic-name">${escapeHtml(name)}</span>
      <div class="topic-bar-track">
        <div class="topic-bar-fill" style="width:${Math.max(8, (count / maxTopicCount) * 100)}%"></div>
      </div>
      <span class="topic-count">${count}</span>
    </div>`
    )
    .join("\n");

  const keywordsHtml = keywords
    .map((k) => `<span class="keyword-chip">${escapeHtml(k)}</span>`)
    .join(" ");

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>血管型失智症每日研究報告 ${escapeHtml(dateDisplay)}</title>
<meta name="description" content="${escapeHtml(dateDisplay)} 血管型失智症與腦血管認知障礙最新研究文獻摘要">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;700&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#f6f1e8;--surface:#fffaf2;--line:#d8c5ab;--text:#2b2118;
  --muted:#766453;--accent:#8c4f2b;--accent-soft:#ead2bf;
  --card-bg:color-mix(in srgb,var(--surface) 92%,white);
}
*{margin:0;padding:0;box-sizing:border-box}
body{
  font-family:"Noto Sans TC","PingFang TC","Helvetica Neue",Arial,sans-serif;
  background:radial-gradient(circle at top,#fff6ea 0,var(--bg) 55%,#ead8c6 100%);
  color:var(--text);line-height:1.7;min-height:100vh;
}
.wrap{max-width:900px;margin:0 auto;padding:24px 20px 60px}
header{text-align:center;padding:40px 0 32px;animation:fadeDown .6s ease-out both}
header h1{font-size:1.65rem;font-weight:700;color:var(--accent);margin-bottom:4px}
header .subtitle{font-size:.95rem;color:var(--muted)}
header .date{font-size:1.25rem;font-weight:700;margin-top:6px;color:var(--text)}
.summary-bar{
  background:var(--card-bg);border:1px solid var(--line);border-radius:16px;
  padding:20px 24px;margin:20px 0 28px;font-size:.95rem;color:var(--muted);
  animation:fadeUp .5s .15s ease-out both;
  box-shadow:0 8px 30px rgba(61,36,15,.04);
}
.summary-bar strong{color:var(--accent)}
.stats-row{
  display:flex;gap:12px;margin:20px 0 28px;flex-wrap:wrap;
  animation:fadeUp .5s .2s ease-out both;
}
.stat-card{
  flex:1;min-width:120px;background:var(--card-bg);border:1px solid var(--line);
  border-radius:14px;padding:16px 18px;text-align:center;
  box-shadow:0 4px 16px rgba(61,36,15,.03);
}
.stat-card .num{font-size:1.6rem;font-weight:700;color:var(--accent)}
.stat-card .label{font-size:.78rem;color:var(--muted);margin-top:2px}
.section-title{
  font-size:1.15rem;font-weight:700;color:var(--accent);margin:32px 0 16px;
  padding-left:14px;border-left:3px solid var(--accent);
}
.card{
  background:var(--card-bg);border:1px solid var(--line);border-radius:24px;
  padding:24px 26px;margin-bottom:20px;
  box-shadow:0 8px 30px rgba(61,36,15,.04);
  animation:fadeUp .45s ease-out both;
  transition:box-shadow .25s,transform .25s;
}
.card:hover{box-shadow:0 12px 40px rgba(61,36,15,.08);transform:translateY(-2px)}
.card.featured{border-left:3px solid var(--accent)}
.card-header{display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap}
.rank-badge{
  background:var(--accent);color:#fff;font-size:.72rem;font-weight:700;
  padding:3px 10px;border-radius:20px;letter-spacing:.5px;
}
.emoji{font-size:1.1rem}
.utility-badge{
  font-size:.68rem;font-weight:600;color:#fff;padding:3px 10px;
  border-radius:20px;margin-left:auto;
}
.utility-badge.small{font-size:.62rem;padding:2px 8px}
.card-title{font-size:1.05rem;font-weight:700;line-height:1.5;margin-bottom:4px}
.card-title-en{font-size:.82rem;color:var(--muted);font-style:italic;margin-bottom:6px}
.card-journal{font-size:.78rem;color:var(--accent);font-weight:500;margin-bottom:8px}
.card-summary{font-size:.9rem;line-height:1.7;margin-bottom:12px;color:var(--text)}
.pico-grid{
  display:grid;grid-template-columns:1fr 1fr;gap:8px;
  background:var(--surface);border:1px solid var(--line);border-radius:12px;
  padding:14px 16px;margin-bottom:12px;
}
.pico-item{display:flex;align-items:flex-start;gap:8px}
.pico-label{
  display:inline-flex;align-items:center;justify-content:center;
  width:24px;height:24px;border-radius:50%;background:var(--accent);color:#fff;
  font-size:.72rem;font-weight:700;flex-shrink:0;
}
.pico-text{font-size:.82rem;color:var(--muted);line-height:1.5}
.utility-reason{font-size:.82rem;color:var(--muted);margin-bottom:10px}
.card-tags{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.tag{
  font-size:.7rem;background:var(--accent-soft);color:var(--accent);
  padding:3px 10px;border-radius:20px;font-weight:500;
}
.card-link{
  display:inline-block;font-size:.82rem;color:var(--accent);text-decoration:none;
  font-weight:500;transition:color .2s;
}
.card-link:hover{color:var(--text)}
.topic-section{
  background:var(--card-bg);border:1px solid var(--line);border-radius:20px;
  padding:24px 26px;margin:20px 0;
  box-shadow:0 6px 24px rgba(61,36,15,.03);
  animation:fadeUp .5s .3s ease-out both;
}
.topic-bar-row{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.topic-name{font-size:.82rem;color:var(--text);min-width:120px;text-align:right}
.topic-bar-track{flex:1;height:10px;background:var(--surface);border-radius:6px;border:1px solid var(--line);overflow:hidden}
.topic-bar-fill{height:100%;border-radius:6px;background:linear-gradient(90deg,var(--accent),#c47a4a);transition:width .8s ease-out}
.topic-count{font-size:.78rem;color:var(--muted);min-width:24px;text-align:center}
.keywords-section{margin:20px 0;animation:fadeUp .5s .35s ease-out both}
.keyword-chip{
  display:inline-block;font-size:.75rem;background:var(--surface);
  border:1px solid var(--line);color:var(--muted);padding:4px 12px;
  border-radius:16px;margin:4px 4px 4px 0;
}
.footer{
  text-align:center;margin-top:48px;padding:32px 20px;
  border-top:1px solid var(--line);color:var(--muted);font-size:.82rem;
  animation:fadeUp .5s .4s ease-out both;
}
.footer a{color:var(--accent);text-decoration:none;font-weight:500}
.footer a:hover{text-decoration:underline}
.footer-links{display:flex;flex-wrap:wrap;justify-content:center;gap:12px 20px;margin:16px 0}
.footer-links a{font-size:.85rem}
@keyframes fadeUp{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:translateY(0)}}
@keyframes fadeDown{from{opacity:0;transform:translateY(-18px)}to{opacity:1;transform:translateY(0)}}
@media(max-width:600px){
  .wrap{padding:16px 12px 40px}
  header h1{font-size:1.3rem}
  .pico-grid{grid-template-columns:1fr}
  .card{padding:18px 16px;border-radius:18px}
  .topic-name{min-width:80px;font-size:.75rem}
}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>🧠 血管型失智症每日研究報告</h1>
    <p class="subtitle">Vascular Dementia Daily Research Report</p>
    <p class="date">${escapeHtml(dateDisplay)}</p>
  </header>

  <div class="summary-bar">
    <strong>📋 今日總覽：</strong> ${escapeHtml(summary || "暫無更新")}
  </div>

  <div class="stats-row">
    <div class="stat-card"><div class="num">${totalCount}</div><div class="label">篇論文</div></div>
    <div class="stat-card"><div class="num">${topPicks.length}</div><div class="label">精選重點</div></div>
    <div class="stat-card"><div class="num">${keywords.length}</div><div class="label">關鍵字</div></div>
    <div class="stat-card"><div class="num">${topicEntries.length}</div><div class="label">研究主題</div></div>
  </div>

  ${
    topPicks.length
      ? `<div class="section-title">🏆 精選重點論文</div>${topPicksHtml}`
      : ""
  }

  ${
    allPapers.length
      ? `<div class="section-title">📄 所有論文</div>${allPapersHtml}`
      : ""
  }

  ${
    topicEntries.length
      ? `<div class="section-title">📊 主題分布</div>
  <div class="topic-section">${topicBarsHtml}</div>`
      : ""
  }

  ${
    keywords.length
      ? `<div class="section-title">🏷️ 關鍵字</div>
  <div class="keywords-section">${keywordsHtml}</div>`
      : ""
  }

  <div class="footer">
    <p>由 AI 自動生成 · 資料來源：PubMed · Europe PMC</p>
    <div class="footer-links">
      <a href="https://www.leepsyclinic.com/" target="_blank" rel="noopener noreferrer">🏥 李政洋身心診所首頁</a>
      <a href="https://blog.leepsyclinic.com/" target="_blank" rel="noopener noreferrer">📬 訂閱電子報</a>
      <a href="https://buymeacoffee.com/CYlee" target="_blank" rel="noopener noreferrer">☕ Buy me a coffee</a>
    </div>
    <p style="margin-top:8px;font-size:.75rem">© ${escapeHtml(dateParts[0] || new Date().getFullYear())} Vascular Dementia Research Daily</p>
  </div>
</div>
</body>
</html>`;
}

async function main() {
  const args = process.argv.slice(2);
  let inputPath = join(DOCS_DIR, "papers.json");
  let outputDir = DOCS_DIR;
  const apiKey = process.env.ZHIPU_API_KEY || "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--input" && args[i + 1]) inputPath = args[++i];
    if (args[i] === "--output-dir" && args[i + 1]) outputDir = args[++i];
  }

  if (!apiKey) {
    console.error("[ERROR] ZHIPU_API_KEY environment variable is required");
    process.exit(1);
  }

  if (!existsSync(inputPath)) {
    console.error(`[ERROR] Input file not found: ${inputPath}`);
    process.exit(1);
  }

  const papersData = loadPapers(inputPath);
  const dateStr = papersData.date || new Date().toISOString().split("T")[0];

  if (!papersData.papers || papersData.papers.length === 0) {
    console.error("[INFO] No papers to analyze, generating empty report");
    const emptyAnalysis = {
      date: dateStr,
      market_summary: "今日 PubMed 與 Europe PMC 暫無新的血管型失智症相關論文更新。",
      top_picks: [],
      all_papers: [],
      keywords: [],
      topic_distribution: {},
    };
    const html = generateHtml(emptyAnalysis);
    if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
    const outputPath = join(outputDir, `report-${dateStr}.html`);
    writeFileSync(outputPath, html, "utf-8");
    console.error(`[INFO] Empty report saved to ${outputPath}`);
    return;
  }

  const result = await analyzePapers(apiKey, papersData);
  if (!result) {
    console.error("[ERROR] AI analysis failed");
    process.exit(1);
  }

  const html = generateHtml(result);
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  const outputPath = join(outputDir, `report-${dateStr}.html`);
  writeFileSync(outputPath, html, "utf-8");
  console.error(`[INFO] Report saved to ${outputPath}`);
}

main().catch((e) => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
});

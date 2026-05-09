#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = join(__dirname, "..", "docs");
const PROCESSED_FILE = join(__dirname, "..", ".processed-pmids.json");

const EUROPE_PMC = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";
const PUBMED_SEARCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const PUBMED_FETCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";

function getTargetDate() {
  const d = new Date();
  d.setHours(d.getHours() + 8);
  return d.toISOString().split("T")[0];
}

function getDateDaysAgoISO(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split("T")[0];
}

function loadProcessedPmids() {
  if (!existsSync(PROCESSED_FILE)) return new Set();
  try {
    const data = JSON.parse(readFileSync(PROCESSED_FILE, "utf-8"));
    return new Set(data.pmids || []);
  } catch {
    return new Set();
  }
}

function saveProcessedPmids(pmids) {
  const allPmids = [...loadProcessedPmids(), ...pmids];
  const recent = allPmids.slice(-5000);
  writeFileSync(PROCESSED_FILE, JSON.stringify({ pmids: recent }), "utf-8");
}

const EPMC_QUERIES = [
  { name: "VaD core", q: '"vascular dementia" OR "vascular cognitive impairment" OR "post-stroke dementia"' },
  { name: "PSCI", q: '"post-stroke cognitive impairment" OR PSCI' },
  { name: "CSVD", q: '"cerebral small vessel disease" AND (cognition OR dementia OR "cognitive impairment")' },
  { name: "WMH", q: '"white matter hyperintensities" AND (cognition OR dementia)' },
  { name: "subtypes", q: '("Binswanger" OR CADASIL OR "subcortical ischemic vascular") AND (dementia OR cognition)' },
  { name: "mixed", q: '"mixed dementia" OR ("vascular dementia" AND Alzheimer)' },
  { name: "post-stroke", q: '("post-stroke" OR poststroke) AND (dementia OR "cognitive impairment")' },
  { name: "vascular neurocognitive", q: '"vascular neurocognitive disorder" OR "vascular mild cognitive impairment"' },
];

const RELEVANCE_TERMS = [
  "vascular dementia", "vascular cognitive impairment", "post-stroke cognitive",
  "post-stroke dementia", "poststroke cognitive", "poststroke dementia", "PSCI",
  "cerebral small vessel disease", "white matter hyperintensit", "subcortical ischemic vascular",
  "Binswanger", "CADASIL", "strategic infarct", "vascular neurocognitive",
  "vascular MCI", "vascular mild cognitive", "mixed dementia",
  "white matter lesion", "lacunar stroke", "lacune", "microbleed",
  "leukoaraiosis", "cerebrovascular disease AND cognition", "stroke AND dementia",
  "vascular contribution", "vascular depression", "arteriolosclerosis AND cognition",
  "blood-brain barrier AND cognition", "cerebral hypoperfusion",
  "vascular risk factor AND dementia", "vascular risk factor AND cognition",
];

async function httpGet(url, timeout = 45000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "VascularDementiaBot/1.0 (research)" },
    });
    clearTimeout(timer);
    return resp;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

async function searchEuropePMC() {
  const since = getDateDaysAgoISO(14);
  const allResults = new Map();

  for (const { name, q } of EPMC_QUERIES) {
    const dateFilter = `FIRST_PDATE:[${since} TO 2099-12-31]`;
    const fullQuery = `(${q}) AND ${dateFilter}`;
    const url = `${EUROPE_PMC}?query=${encodeURIComponent(fullQuery)}&format=json&pageSize=25`;

    console.error(`[INFO] EPMC query: ${name}`);
    try {
      const resp = await httpGet(url);
      const text = await resp.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        console.error(`[WARN] EPMC non-JSON response for "${name}"`);
        continue;
      }
      const results = data?.resultList?.result || [];
      let newCount = 0;
      for (const r of results) {
        const id = r.pmid || r.doi || r.title;
        if (!id || allResults.has(id)) continue;
        allResults.set(id, {
          pmid: r.pmid || "",
          title: r.title || "",
          journal: r.journalTitle || "",
          date: r.firstPublicationDate || "",
          abstract: (r.abstractText || "").slice(0, 2000),
          url: r.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${r.pmid}/` : r.doi ? `https://doi.org/${r.doi}` : "",
          doi: r.doi || "",
          keywords: [],
        });
        newCount++;
      }
      console.error(`[INFO]   → ${results.length} results, ${newCount} new (total: ${allResults.size})`);
    } catch (e) {
      console.error(`[WARN] EPMC "${name}" failed: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  console.error(`[INFO] EPMC total unique papers: ${allResults.size}`);
  return [...allResults.values()];
}

function isRelevant(paper) {
  const text = `${paper.title} ${paper.abstract}`.toLowerCase();
  return RELEVANCE_TERMS.some((term) => text.includes(term.toLowerCase()));
}

async function searchCrossref() {
  return [];
}

async function tryPubMed() {
  const since = getDateDaysAgoISO(7).replace(/-/g, "/");
  const query = '"Dementia, Vascular"[MeSH Terms] AND "2025"[pdat]:"3000"[pdat]';
  const params = new URLSearchParams({
    db: "pubmed",
    term: query,
    retmax: "30",
    sort: "date",
    retmode: "json",
    tool: "VascularDementiaBot",
    email: "bot@vascular-dementia.example.com",
  });

  console.error(`[INFO] Trying PubMed...`);
  try {
    const resp = await httpGet(`${PUBMED_SEARCH}?${params}`, 15000);
    const text = await resp.text();
    if (text.includes("<!DOCTYPE") || text.includes("Error Blocked")) {
      console.error(`[INFO] PubMed blocked (expected on GitHub Actions)`);
      return [];
    }
    const data = JSON.parse(text);
    const pmids = data?.esearchresult?.idlist || [];
    console.error(`[INFO] PubMed found ${pmids.length} PMIDs`);

    if (!pmids.length) return [];

    const fetchParams = new URLSearchParams({
      db: "pubmed",
      id: pmids.join(","),
      retmode: "xml",
      tool: "VascularDementiaBot",
      email: "bot@vascular-dementia.example.com",
    });
    const fetchResp = await httpGet(`${PUBMED_FETCH}?${fetchParams}`, 60000);
    const xml = await fetchResp.text();
    if (xml.includes("<!DOCTYPE") || xml.includes("Error Blocked")) {
      console.error(`[INFO] PubMed fetch blocked`);
      return [];
    }
    return parsePubMedXml(xml);
  } catch (e) {
    console.error(`[INFO] PubMed unavailable: ${e.message}`);
    return [];
  }
}

function parsePubMedXml(xml) {
  const papers = [];
  const articleRegex = /<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g;
  let match;
  while ((match = articleRegex.exec(xml)) !== null) {
    const block = match[1];
    const titleMatch = block.match(/<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/);
    let title = "";
    if (titleMatch) {
      title = titleMatch[1].replace(/<[^>]+>/g, "").trim();
    }

    const abstractParts = [];
    const absRegex = /<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g;
    let absMatch;
    while ((absMatch = absRegex.exec(block)) !== null) {
      const labelMatch = absMatch[0].match(/Label="([^"]*)"/);
      const label = labelMatch ? labelMatch[1] : "";
      const text = absMatch[1].replace(/<[^>]+>/g, "").trim();
      if (label && text) abstractParts.push(`${label}: ${text}`);
      else if (text) abstractParts.push(text);
    }
    const abstract = abstractParts.join(" ").slice(0, 2000);

    const journalMatch = block.match(/<Title>([\s\S]*?)<\/Title>/);
    const journal = journalMatch ? journalMatch[1].trim() : "";

    const yearMatch = block.match(/<Year>(\d+)<\/Year>/);
    const monthMatch = block.match(/<Month>([^<]+)<\/Month>/);
    const dayMatch = block.match(/<Day>(\d+)<\/Day>/);
    const dateStr = [yearMatch?.[1], monthMatch?.[1], dayMatch?.[1]]
      .filter(Boolean)
      .join(" ");

    const pmidMatch = block.match(/<PMID[^>]*>(\d+)<\/PMID>/);
    const pmid = pmidMatch ? pmidMatch[1] : "";

    const keywords = [];
    const kwRegex = /<Keyword>([\s\S]*?)<\/Keyword>/g;
    let kwMatch;
    while ((kwMatch = kwRegex.exec(block)) !== null) {
      if (kwMatch[1].trim()) keywords.push(kwMatch[1].trim());
    }

    papers.push({
      pmid, title, journal, date: dateStr, abstract,
      url: pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : "",
      doi: "", keywords,
    });
  }
  return papers;
}

function mergeAndDedup(allSources, processedPmids) {
  const seen = new Set();
  const result = [];
  for (const p of allSources) {
    const id = p.pmid || p.doi || p.title;
    if (!id || id.trim() === "") continue;
    if (!isRelevant(p)) continue;
    if (processedPmids.has(p.pmid) && p.pmid) continue;
    const key = id.toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(p);
  }
  return result;
}

async function main() {
  const targetDate = getTargetDate();
  console.error(`[INFO] Target date: ${targetDate}`);

  const processedPmids = loadProcessedPmids();
  console.error(`[INFO] Previously processed PMIDs: ${processedPmids.size}`);

  const epmcPapers = await searchEuropePMC();
  const crossrefPapers = await searchCrossref();
  const pubmedPapers = await tryPubMed();

  const allSources = [...epmcPapers, ...crossrefPapers, ...pubmedPapers];
  console.error(`[INFO] Total from all sources (before relevance filter): ${allSources.length}`);

  const allPapers = mergeAndDedup(allSources, processedPmids);
  console.error(`[INFO] After relevance filter + dedup: ${allPapers.length} new papers`);

  const output = {
    date: targetDate,
    count: allPapers.length,
    papers: allPapers,
  };

  if (!existsSync(DOCS_DIR)) mkdirSync(DOCS_DIR, { recursive: true });
  writeFileSync(join(DOCS_DIR, "papers.json"), JSON.stringify(output, null, 2), "utf-8");
  console.error(`[INFO] Saved papers.json`);

  const newPmids = allPapers.filter((p) => p.pmid).map((p) => p.pmid);
  saveProcessedPmids(newPmids);
  console.error(`[INFO] Saved ${newPmids.length} processed PMIDs`);
}

main().catch((e) => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
});

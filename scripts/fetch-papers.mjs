#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = join(__dirname, "..", "docs");
const PROCESSED_FILE = join(__dirname, "..", ".processed-pmids.json");

const PUBMED_SEARCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const PUBMED_FETCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";
const EUROPE_PMC_SEARCH = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";
const NCBI_TOOL = "VascularDementiaBot";
const NCBI_EMAIL = "github-actions[bot]@users.noreply.github.com";

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

function getDateDaysAgoSlashed(days) {
  return getDateDaysAgoISO(days).replace(/-/g, "/");
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

async function fetchGet(url, timeout = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": `${NCBI_TOOL}/1.0 (${NCBI_EMAIL})` },
    });
    clearTimeout(timer);
    return resp;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

async function safeJson(resp) {
  const ct = resp.headers.get("content-type") || "";
  const text = await resp.text();
  if (text.trim().startsWith("<!DOCTYPE") || text.trim().startsWith("<html")) {
    console.error(`[WARN] HTML error page (${resp.status}): ${text.slice(0, 300)}`);
    throw new Error(`NCBI returned HTML error page`);
  }
  try {
    return JSON.parse(text);
  } catch {
    console.error(`[WARN] JSON parse failed, response starts with: ${text.slice(0, 200)}`);
    throw new Error("Response is not valid JSON");
  }
}

const SEARCH_QUERIES = [
  {
    name: "MeSH core",
    term: '"Dementia, Vascular"[MeSH Terms] AND "2024"[pdat] : "3000"[pdat]',
  },
  {
    name: "VCI + post-stroke",
    term: '("vascular cognitive impairment"[tiab] OR "post-stroke cognitive impairment"[tiab] OR PSCI[tiab]) AND "2025"[pdat] : "3000"[pdat]',
  },
  {
    name: "VaD broad",
    term: '("vascular dementia"[tiab] OR "post-stroke dementia"[tiab] OR "poststroke dementia"[tiab]) AND "2025"[pdat] : "3000"[pdat]',
  },
  {
    name: "CSVD + cognition",
    term: '("cerebral small vessel disease"[tiab] OR "white matter hyperintensities"[tiab]) AND (cognition[tiab] OR dementia[tiab] OR "cognitive impairment"[tiab]) AND "2025"[pdat] : "3000"[pdat]',
  },
  {
    name: "CADASIL + Binswanger",
    term: '(CADASIL[tiab] OR "Binswanger disease"[tiab] OR "subcortical ischemic vascular dementia"[tiab]) AND "2020"[pdat] : "3000"[pdat]',
  },
];

async function searchPubMedQuery(queryTerm) {
  const params = new URLSearchParams({
    db: "pubmed",
    term: queryTerm,
    retmax: "40",
    sort: "date",
    retmode: "json",
    tool: NCBI_TOOL,
    email: NCBI_EMAIL,
  });
  const url = `${PUBMED_SEARCH}?${params.toString()}`;

  try {
    const resp = await fetchGet(url, 30000);
    const data = await safeJson(resp);
    return data?.esearchresult?.idlist || [];
  } catch (e) {
    console.error(`[WARN] PubMed query failed: ${e.message}`);
    return [];
  }
}

async function searchPubMed() {
  const allPmids = new Set();
  for (const q of SEARCH_QUERIES) {
    console.error(`[INFO] PubMed query: ${q.name}`);
    const ids = await searchPubMedQuery(q.term);
    ids.forEach((id) => allPmids.add(id));
    console.error(`[INFO]   → ${ids.length} PMIDs (total unique: ${allPmids.size})`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.error(`[INFO] PubMed total unique PMIDs: ${allPmids.size}`);
  return [...allPmids];
}

async function searchEuropePMC() {
  const since = getDateDaysAgoISO(7);
  const query = '("vascular dementia" OR "vascular cognitive impairment" OR "post-stroke cognitive impairment" OR "cerebral small vessel disease" OR "white matter hyperintensities" OR "post-stroke dementia")';
  const fullQuery = `${query} AND FIRST_PDATE:[${since} TO 2099-12-31]`;
  const url = `${EUROPE_PMC_SEARCH}?query=${encodeURIComponent(fullQuery)}&format=json&pageSize=30`;

  console.error(`[INFO] Searching Europe PMC...`);
  try {
    const resp = await fetchGet(url, 30000);
    const text = await resp.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      console.error(`[ERROR] Europe PMC non-JSON: ${text.slice(0, 200)}`);
      return [];
    }
    const results = data?.resultList?.result || [];
    console.error(`[INFO] Europe PMC found ${results.length} papers`);
    return results
      .filter((r) => r.pmid)
      .map((r) => ({
        pmid: r.pmid,
        title: r.title || "",
        journal: r.journalTitle || "",
        date: r.firstPublicationDate || "",
        abstract: r.abstractText || "",
        url: r.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${r.pmid}/` : "",
        doi: r.doi || "",
        keywords: [],
      }));
  } catch (e) {
    console.error(`[ERROR] Europe PMC search failed: ${e.message}`);
    return [];
  }
}

async function fetchPubMedDetails(pmids) {
  if (!pmids.length) return [];
  const allPapers = [];
  const chunks = [];
  for (let i = 0; i < pmids.length; i += 50) {
    chunks.push(pmids.slice(i, i + 50));
  }

  for (const chunk of chunks) {
    const params = new URLSearchParams({
      db: "pubmed",
      id: chunk.join(","),
      retmode: "xml",
      tool: NCBI_TOOL,
      email: NCBI_EMAIL,
    });
    const url = `${PUBMED_FETCH}?${params.toString()}`;
    console.error(`[INFO] Fetching details for ${chunk.length} papers...`);
    try {
      const resp = await fetchGet(url, 90000);
      const xml = await resp.text();
      if (xml.trim().startsWith("<!DOCTYPE") || xml.trim().startsWith("<html")) {
        console.error(`[WARN] PubMed fetch returned HTML error`);
        continue;
      }
      allPapers.push(...parsePubMedXml(xml));
    } catch (e) {
      console.error(`[ERROR] PubMed fetch failed: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return allPapers;
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
      pmid,
      title,
      journal,
      date: dateStr,
      abstract,
      url: pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : "",
      doi: "",
      keywords,
    });
  }
  return papers;
}

function dedupPapers(pubmedPapers, epmcPapers, processedPmids) {
  const seen = new Set();
  const result = [];
  for (const p of [...pubmedPapers, ...epmcPapers]) {
    const id = p.pmid || p.doi || p.title;
    if (processedPmids.has(p.pmid)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(p);
  }
  return result;
}

async function main() {
  const targetDate = getTargetDate();
  console.error(`[INFO] Target date: ${targetDate}`);

  const processedPmids = loadProcessedPmids();

  const pmids = await searchPubMed();
  const pubmedPapers = await fetchPubMedDetails(pmids);
  const epmcPapers = await searchEuropePMC();

  const allPapers = dedupPapers(pubmedPapers, epmcPapers, processedPmids);
  console.error(`[INFO] After dedup: ${allPapers.length} new papers`);

  const output = {
    date: targetDate,
    count: allPapers.length,
    papers: allPapers,
  };

  if (!existsSync(DOCS_DIR)) mkdirSync(DOCS_DIR, { recursive: true });
  const outputPath = join(DOCS_DIR, "papers.json");
  writeFileSync(outputPath, JSON.stringify(output, null, 2), "utf-8");
  console.error(`[INFO] Saved to ${outputPath}`);

  const newPmids = allPapers.filter((p) => p.pmid).map((p) => p.pmid);
  saveProcessedPmids(newPmids);
  console.error(`[INFO] Saved ${newPmids.length} processed PMIDs`);
}

main().catch((e) => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
});

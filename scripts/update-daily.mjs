import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const topicOrder = ["economy", "technology", "biology", "philosophy", "cosmos"];
const rssSources = [
  { id: "nist", topic: "technology", name: "NIST", url: "https://www.nist.gov/news-events/news/rss.xml" },
  { id: "sep", topic: "philosophy", name: "Stanford Encyclopedia of Philosophy", url: "https://plato.stanford.edu/rss/sep.xml" },
];
const worldBankIndicators = [
  { code: "NY.GDP.MKTP.CD", label: "全球 GDP（现价美元）", unit: "美元" },
  { code: "SP.POP.TOTL", label: "全球人口", unit: "人" },
  { code: "IT.NET.USER.ZS", label: "全球互联网使用率", unit: "%" },
  { code: "EN.ATM.CO2E.PC", label: "全球人均二氧化碳排放", unit: "吨" },
  { code: "EG.ELC.ACCS.ZS", label: "全球通电人口比例", unit: "%" },
];
const fallbackSummary = {
  technology: "来自美国国家标准与技术研究院的最新技术信号。标准和测量往往决定一项技术能否真正落地。",
  philosophy: "斯坦福哲学百科最近新增或修订的词条。哲学的更新不是追热点，而是让一个问题变得更精确。",
  biology: "来自 NIH PubMed 的最新生命科学文献索引。这里只展示论文题目与官方入口，不把论文标题夸大成已经确定的结论。",
  cosmos: "来自 NASA 每日天文图的最新宇宙信号。点击官方原文查看完整解释、署名与图像信息。",
};

function beijingDay(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function daySerial(dayKey) {
  const [year, month, day] = dayKey.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function itemId(namespace, value) {
  return createHash("sha1").update(`${namespace}:${value}`).digest("hex").slice(0, 16);
}


function isoDate(value) {
  if (!value) return "";
  const timestamp = Date.parse(String(value).replace(/\//g, "-"));
  if (Number.isNaN(timestamp) || timestamp > Date.now() + 172_800_000) return "";
  return new Date(timestamp).toISOString();
}
function decodeXml(value = "") {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/&#x([\da-f]+);/gi, (_, number) => String.fromCodePoint(Number.parseInt(number, 16)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'");
}

function cleanText(value = "", limit = 360) {
  const text = decodeXml(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).replace(/\s+\S*$/, "")}…`;
}

function tagValue(block, names) {
  for (const name of names) {
    const escaped = name.replace(":", "\\:");
    const match = block.match(new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, "i"));
    if (match) return match[1];
  }
  return "";
}

function entryLink(block) {
  const atom = block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*\/?\s*>/i);
  if (atom) return decodeXml(atom[1]).trim();
  return cleanText(tagValue(block, ["link"]), 1200);
}

function parseFeed(xml, source) {
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>|<entry\b[\s\S]*?<\/entry>/gi) ?? [];
  return blocks.slice(0, 12).map((block) => {
    const title = cleanText(tagValue(block, ["title"]), 220);
    const sourceUrl = entryLink(block);
    const description = cleanText(tagValue(block, ["description", "content:encoded", "summary", "content"]), 360);
    const publishedRaw = cleanText(tagValue(block, ["pubDate", "published", "updated", "dc:date"]), 120);
    const timestamp = Date.parse(publishedRaw);
    if (!title || !/^https?:\/\//i.test(sourceUrl)) return null;
    return {
      id: itemId(source.id, sourceUrl), topic: source.topic, title,
      summary: description && description.toLowerCase() !== title.toLowerCase() ? description : fallbackSummary[source.topic],
      sourceName: source.name, sourceUrl,
      publishedAt: Number.isNaN(timestamp) ? "" : new Date(timestamp).toISOString(),
    };
  }).filter(Boolean);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { accept: "application/json", "user-agent": "DailyCurioBot/1.0 (+https://github.com/zhangwenzhi384-spec/daily-curio-data)", ...(options.headers ?? {}) },
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${new URL(url).hostname}`);
  return response.json();
}

async function fetchRss(source) {
  const response = await fetch(source.url, {
    headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.2", "user-agent": "DailyCurioBot/1.0 (+https://github.com/zhangwenzhi384-spec/daily-curio-data)" },
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`${source.id}: HTTP ${response.status}`);
  const items = parseFeed(await response.text(), source);
  if (!items.length) throw new Error(`${source.id}: no readable entries`);
  return { source, items };
}

function formatIndicatorValue(value, unit) {
  if (unit === "美元") return `${(value / 1_000_000_000_000).toFixed(2)} 万亿美元`;
  if (unit === "人") return `${(value / 100_000_000).toFixed(2)} 亿人`;
  if (unit === "%") return `${Number(value).toFixed(1)}%`;
  return `${Number(value).toFixed(2)} ${unit}`;
}

async function fetchWorldBank(date) {
  const indicator = worldBankIndicators[daySerial(date) % worldBankIndicators.length];
  const url = `https://api.worldbank.org/v2/country/WLD/indicator/${indicator.code}?format=json&per_page=12`;
  const payload = await fetchJson(url);
  const record = payload?.[1]?.find((item) => item.value !== null);
  if (!record) throw new Error("world-bank: no recent indicator value");
  const formatted = formatIndicatorValue(record.value, indicator.unit);
  const sourceUrl = `https://data.worldbank.org/indicator/${indicator.code}`;
  return {
    source: { id: "world-bank", topic: "economy", name: "World Bank Open Data" },
    items: [{
      id: itemId("world-bank", `${indicator.code}:${record.date}:${record.value}`), topic: "economy",
      title: `${indicator.label}的最新记录：${record.date} 年 ${formatted}`,
      summary: `这是世界银行全球指标（代码 ${indicator.code}）目前返回的最近一个非空年度值。指标会随各国补报与统计修订而更新，点击原始数据页可核验定义与时间序列。`,
      sourceName: "World Bank Open Data", sourceUrl, publishedAt: `${record.date}-12-31T00:00:00.000Z`,
    }],
  };
}

async function fetchPubMed() {
  const query = encodeURIComponent("(biology[MeSH Terms] OR life sciences[MeSH Terms]) AND hasabstract[text]");
  const search = await fetchJson(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=6&sort=pub+date&term=${query}`);
  const ids = search?.esearchresult?.idlist ?? [];
  if (!ids.length) throw new Error("pubmed: no recent records");
  const summary = await fetchJson(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(",")}`);
  const items = ids.map((id) => summary?.result?.[id]).filter(Boolean).map((entry) => ({
    id: itemId("pubmed", entry.uid), topic: "biology", title: cleanText(entry.title, 220),
    summary: fallbackSummary.biology, sourceName: "NIH · PubMed", sourceUrl: `https://pubmed.ncbi.nlm.nih.gov/${entry.uid}/`,
    publishedAt: isoDate(entry.sortpubdate || entry.pubdate),
  }));
  return { source: { id: "pubmed", topic: "biology", name: "NIH · PubMed" }, items };
}

async function fetchNasaApod() {
  const data = await fetchJson("https://api.nasa.gov/planetary/apod?api_key=DEMO_KEY");
  if (!data?.title || !data?.date) throw new Error("nasa-apod: invalid response");
  const [year, month, day] = data.date.split("-");
  const sourceUrl = `https://apod.nasa.gov/apod/ap${year.slice(2)}${month}${day}.html`;
  return {
    source: { id: "nasa-apod", topic: "cosmos", name: "NASA · Astronomy Picture of the Day" },
    items: [{
      id: itemId("nasa-apod", data.date), topic: "cosmos", title: cleanText(data.title, 220),
      summary: cleanText(data.explanation, 360) || fallbackSummary.cosmos,
      sourceName: "NASA · Astronomy Picture of the Day", sourceUrl, publishedAt: `${data.date}T05:00:00.000Z`,
    }],
  };
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}

const now = new Date();
const date = beijingDay(now);
const previous = await readJson("daily.json", { digest: [] });
const history = await readJson("history.json", { seen: [], days: [] });
const jobs = [...rssSources.map(fetchRss), fetchWorldBank(date), fetchPubMed(), fetchNasaApod()];
const results = await Promise.allSettled(jobs);
const successes = results.filter((result) => result.status === "fulfilled").map((result) => result.value);
for (const result of results) if (result.status === "rejected") console.warn(result.reason?.message ?? result.reason);
if (!successes.length) throw new Error("All official sources failed; keeping the previous daily.json unchanged.");

const candidates = successes.flatMap((result) => result.items).sort((left, right) => Date.parse(right.publishedAt || 0) - Date.parse(left.publishedAt || 0));
const seen = new Set(history.seen ?? []);
const preferredTopic = topicOrder[daySerial(date) % topicOrder.length];
const spotlight = candidates.find((item) => item.topic === preferredTopic && !seen.has(item.id)) ?? candidates.find((item) => !seen.has(item.id)) ?? candidates[0];
const previousByTopic = new Map((previous.digest ?? []).map((item) => [item.topic, item]));
const digest = topicOrder.map((topic) => candidates.find((item) => item.topic === topic) ?? previousByTopic.get(topic)).filter(Boolean);
const daily = { version: 1, date, generatedAt: now.toISOString(), mode: "official-sources-no-paid-api-no-ai", spotlight, digest, sourcesOnline: successes.map((result) => result.source.id) };
const nextHistory = {
  seen: [...new Set([spotlight.id, ...(history.seen ?? [])])].slice(0, 500),
  days: [{ date, id: spotlight.id, sourceUrl: spotlight.sourceUrl }, ...(history.days ?? []).filter((day) => day.date !== date)].slice(0, 365),
};
await writeFile("daily.json", `${JSON.stringify(daily, null, 2)}\n`, "utf8");
await writeFile("history.json", `${JSON.stringify(nextHistory, null, 2)}\n`, "utf8");
console.log(`Daily Curio updated for ${date}: ${spotlight.sourceName} / ${spotlight.title}`);
console.log(`Sources online: ${successes.map((result) => result.source.id).join(", ")}`);

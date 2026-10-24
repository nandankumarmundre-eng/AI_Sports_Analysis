// Run from .github: node --env-file=.env dashboard/fetchLive.js
const fs = require("fs");
const path = require("path");

const API_KEY = process.env.CRICAPI_KEY;
const URL = "https://api.cricapi.com/v1/cricScore";
const RAW_DIR = path.join(__dirname, "..", "data", "raw");

async function fetchCricScore() {
  if (!API_KEY) throw new Error("CRICAPI_KEY is not set.");
  const res = await fetch(`${URL}?apikey=${API_KEY}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} on cricScore`);
  const body = await res.json();
  if (body.status !== "success") throw new Error(`API error: ${body.reason ?? "unknown"}`);
  return body.data ?? [];
}

fetchCricScore()
  .then((matches) => {
    fs.mkdirSync(RAW_DIR, { recursive: true });
    fs.writeFileSync(path.join(RAW_DIR, "cric_score.json"), JSON.stringify(matches, null, 2));
    const live = matches.filter((m) => (m.ms ?? "").toLowerCase() === "live");
    console.log(`cricScore: ${matches.length} total, ${live.length} live`);
    for (const m of live) {
      console.log(`- [${m.matchType}] ${m.t1} vs ${m.t2} | ${m.status}`);
    }
    const target = matches.filter((m) => {
      const names = `${m.t1 ?? ""} ${m.t2 ?? ""}`.toLowerCase();
      return names.includes("india") && names.includes("new zealand");
    });
    console.log("India vs New Zealand:", target.length ? JSON.stringify(target, null, 2) : "not listed");
  })
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });

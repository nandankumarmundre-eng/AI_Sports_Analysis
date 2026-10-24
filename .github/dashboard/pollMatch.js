"use strict";

const fs = require("node:fs");
const path = require("node:path");

const API_KEY = process.env.CRICAPI_KEY;
const API_URL = "https://api.cricapi.com/v1/cricScore";
const RAW_DIR = path.join(__dirname, "..", "data", "raw");

function parseArgs() {
  const args = process.argv.slice(2);
  const options = { interval: 30 };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--id" && args[i + 1]) {
      options.id = args[++i];
    } else if (args[i] === "--interval" && args[i + 1]) {
      options.interval = Number(args[++i]);
    } else if (args[i] === "--list") {
      options.list = true;
    } else {
      throw new Error(`Unknown or incomplete argument: ${args[i]}`);
    }
  }

  if (!Number.isInteger(options.interval) || options.interval < 1) {
    throw new Error("--interval must be a positive number of seconds.");
  }
  if (options.list && options.id) {
    throw new Error("Use --list or --id, not both.");
  }

  return options;
}

async function fetchMatches() {
  if (!API_KEY) throw new Error("CRICAPI_KEY is not set in .github/.env.");

  const url = new URL(API_URL);
  url.searchParams.set("apikey", API_KEY);

  const response = await fetch(url);
  if (!response.ok) throw new Error(`CricAPI returned HTTP ${response.status}.`);

  const body = await response.json();
  if (body.status !== "success") {
    throw new Error(`CricAPI error: ${body.reason ?? "unknown error"}`);
  }
  if (!Array.isArray(body.data)) {
    throw new Error("CricAPI response did not contain a match list.");
  }

  return body.data;
}

function isIndiaVsNewZealand(match) {
  if ((match.matchType ?? "").toLowerCase() !== "t20") return false;

  const teams = `${match.t1 ?? ""} ${match.t2 ?? ""}`.toLowerCase();
  return (
    teams.includes("india") &&
    (teams.includes("new zealand") || teams.includes("[nz]"))
  );
}

function isLive(match) {
  return (match.ms ?? "").toLowerCase() === "live";
}

function isFinished(match) {
  const state = (match.ms ?? "").toLowerCase();
  const status = (match.status ?? "").toLowerCase();

  return (
    ["result", "completed", "finished", "abandoned", "cancelled"].includes(state) ||
    /\b(won|tied|drawn|no result|abandoned|cancelled)\b/.test(status)
  );
}

function chooseMatch(matches, matchId) {
  if (matchId) return matches.find((match) => match.id === matchId);

  const relevant = matches.filter(isIndiaVsNewZealand);
  const live = relevant.find(isLive);
  if (live) return live;

  const now = Date.now();
  return relevant
    .filter((match) => {
      const start = Date.parse(match.dateTimeGMT ?? "");
      return !isFinished(match) && Number.isFinite(start) && start >= now;
    })
    .sort(
      (a, b) =>
        Date.parse(a.dateTimeGMT) - Date.parse(b.dateTimeGMT)
    )[0];
}

function parseScore(scoreText) {
  if (typeof scoreText !== "string") return null;

  const match = scoreText.match(/(\d+)\s*\/\s*(\d+)\s*\((\d+)(?:\.(\d+))?/);
  if (!match) return null;

  const overs = Number(match[3]);
  const ballsInOver = Number(match[4] ?? 0);
  if (ballsInOver > 5) return null;

  return {
    runs: Number(match[1]),
    wickets: Number(match[2]),
    overs: `${overs}.${ballsInOver}`,
    balls: overs * 6 + ballsInOver,
  };
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${filePath}: ${error.message}`);
  }
}

function saveMatch(match) {
  fs.mkdirSync(RAW_DIR, { recursive: true });

  const outputPath = path.join(RAW_DIR, `match_${match.id}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(match, null, 2));
  return outputPath;
}

function saveChangedSnapshot(match, benchmarkSamples) {
  const historyPath = path.join(RAW_DIR, `match_${match.id}_history.json`);
  const history = readJson(historyPath, []);
  if (!Array.isArray(history)) {
    throw new Error(`Match history is not an array: ${historyPath}`);
  }
  const signature = JSON.stringify([match.t1s, match.t2s, match.status, match.ms]);
  const last = history.at(-1);

  if (last?.signature !== signature) {
    history.push({
      fetchedAt: new Date().toISOString(),
      signature,
      t1: match.t1,
      t1s: match.t1s ?? "",
      t2: match.t2,
      t2s: match.t2s ?? "",
      status: match.status ?? "",
      ms: match.ms ?? "",
      benchmarkSamples,
    });
    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
  }

  return historyPath;
}

function loadBenchmarkSamples(matchId) {
  const historyPath = path.join(RAW_DIR, `match_${matchId}_history.json`);
  const history = readJson(historyPath, []);
  if (!Array.isArray(history)) {
    throw new Error(`Match history is not an array: ${historyPath}`);
  }

  const samples = {};
  for (const snapshot of history) {
    const saved = snapshot?.benchmarkSamples;
    if (saved && typeof saved === "object" && !Array.isArray(saved)) {
      Object.assign(samples, saved);
    }
  }
  return samples;
}

function captureBenchmarkSamples(match, samples) {
  const captured = [];

  for (const side of ["t1", "t2"]) {
    const score = parseScore(match[`${side}s`]);
    if (!score) continue;

    for (const targetOvers of [10, 15]) {
      const key = `${targetOvers}:${side}`;
      const targetBalls = targetOvers * 6;

      // Record only samples observed from the target to one over beyond it.
      if (
        !samples[key] &&
        score.balls >= targetBalls &&
        score.balls <= targetBalls + 6
      ) {
        samples[key] = {
          team: match[side] ?? side,
          requestedOvers: targetOvers,
          observedOvers: score.overs,
          runs: score.runs,
          wickets: score.wickets,
        };
        captured.push(samples[key]);
      }
    }
  }

  return captured;
}

function printFixtures(matches) {
  const fixtures = matches
    .filter(isIndiaVsNewZealand)
    .sort(
      (a, b) =>
        Date.parse(a.dateTimeGMT ?? "") - Date.parse(b.dateTimeGMT ?? "")
    );

  if (!fixtures.length) {
    console.log("No IND vs NZ T20 fixtures were returned by CricAPI.");
    return;
  }

  for (const match of fixtures) {
    console.log(
      `${match.dateTimeGMT ?? "Date unknown"} | ${match.ms ?? "unknown"} | ` +
        `${match.t1} vs ${match.t2} | ID: ${match.id}`
    );
    console.log(`  ${match.status ?? "Status unavailable"}`);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main() {
  const options = parseArgs();

  if (options.list) {
    const matches = await fetchMatches();
    fs.mkdirSync(RAW_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(RAW_DIR, "cric_score.json"),
      JSON.stringify(matches, null, 2)
    );
    printFixtures(matches);
    return;
  }

  let matchId = options.id;
  let benchmarkSamples = {};
  let benchmarkMatchId;
  let announced = false;

  console.log(
    matchId
      ? `Watching match ${matchId}.`
      : "Looking for the next live or upcoming IND vs NZ T20 match."
  );

  while (true) {
    try {
      const matches = await fetchMatches();

      fs.mkdirSync(RAW_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(RAW_DIR, "cric_score.json"),
        JSON.stringify(matches, null, 2)
      );

      const match = chooseMatch(matches, matchId);

      if (!match) {
        console.log(
          matchId
            ? `Match ${matchId} is not currently listed; retrying.`
            : "No live or upcoming IND vs NZ T20 fixture found; retrying."
        );
      } else {
        if (benchmarkMatchId !== match.id) {
          benchmarkSamples = loadBenchmarkSamples(match.id);
          benchmarkMatchId = match.id;
        }
        matchId = match.id;

        if (!announced) {
          console.log(`Selected: ${match.t1} vs ${match.t2}`);
          console.log(`Match ID: ${match.id}`);
          console.log(`Date (GMT): ${match.dateTimeGMT ?? "unknown"}`);
          announced = true;
        }

        const captured = captureBenchmarkSamples(match, benchmarkSamples);
        const outputPath = saveMatch(match);
        const historyPath = saveChangedSnapshot(match, benchmarkSamples);

        console.log(
          `${new Date().toISOString()} | ${match.t1}: ${match.t1s || "-"} | ` +
            `${match.t2}: ${match.t2s || "-"}`
        );
        console.log(`Status: ${match.status ?? "Unknown"}`);
        for (const sample of captured) {
          console.log(
            `Recorded ${sample.requestedOvers}-over sample for ${sample.team} ` +
              `at ${sample.observedOvers}: ${sample.runs}/${sample.wickets}`
          );
        }
        console.log(`Latest match: ${outputPath}`);
        console.log(`Score history: ${historyPath}`);

        if (isFinished(match)) {
          console.log("Match finished; final result saved.");
          console.log(
            "Benchmark samples:",
            JSON.stringify(benchmarkSamples, null, 2)
          );
          return;
        }
      }
    } catch (error) {
      console.error(`Polling error: ${error.message}`);
    }

    await delay(options.interval * 1000);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
import json
import re
from pathlib import Path
from typing import Any, cast

import streamlit as st

Match = dict[str, Any]
Score = dict[str, int]

st.set_page_config(page_title="ChaseEdge AI", page_icon="🏏", layout="wide")

DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "raw"
LOGO = Path(__file__).resolve().parent.parent / "assets" / "logo.png"
SCORE_RE = re.compile(r"(\d+)\s*/\s*(\d+)\s*\((\d+)(?:\.(\d))?")

if LOGO.exists():
    st.image(str(LOGO), width=250)
st.title("ChaseEdge AI")
st.subheader("Same-Stage. Smarter Predictions.")


def parse_score(text: object) -> Score | None:
    if not isinstance(text, str):
        return None
    m = SCORE_RE.search(text)
    if not m:
        return None
    overs = int(m.group(3))
    balls_in_over = int(m.group(4) or 0)
    wickets = int(m.group(2))
    if balls_in_over > 5 or wickets > 10 or overs * 6 + balls_in_over > 120:
        return None
    balls = overs * 6 + balls_in_over
    return {"runs": int(m.group(1)), "wkts": int(m.group(2)), "balls": balls}


def load_matches() -> dict[str, Match]:
    matches: dict[str, Match] = {}
    for f in DATA_DIR.glob("match_*.json"):
        if f.stem.endswith("_history"):
            continue
        try:
            m: Any = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            st.warning(f"Could not read saved match file {f.name}: {error}")
            continue
        if not isinstance(m, dict):
            st.warning(f"Skipping invalid saved match file {f.name}: expected an object.")
            continue
        match_data = cast(Match, m)
        if not all(isinstance(match_data.get(k), str) for k in ("id", "t1", "t2")):
            st.warning(f"Skipping invalid saved match file {f.name}: missing id, t1 or t2.")
            continue
        matches[match_data["id"]] = match_data
    return matches


def load_samples(match_id: str) -> dict[str, Any]:
    f = DATA_DIR / f"match_{match_id}_history.json"
    try:
        history: Any = json.loads(f.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        st.warning(f"Could not read saved match history {f.name}: {error}")
        return {}
    if not isinstance(history, list):
        st.warning(f"Skipping invalid saved match history {f.name}: expected a list.")
        return {}
    samples: dict[str, Any] = {}
    for entry in cast(list[Any], history):
        if not isinstance(entry, dict):
            st.warning(f"Skipping an invalid entry in saved match history {f.name}.")
            continue
        saved: Any = cast(Match, entry).get("benchmarkSamples")
        if saved is not None and not isinstance(saved, dict):
            st.warning(f"Skipping invalid benchmark samples in saved match history {f.name}.")
            continue
        if saved:
            samples.update(cast(dict[str, Any], saved))
    return samples


def momentum_label(score: Score) -> str:
    return "Neutral (no ball-by-ball data)"


def project_total(score: Score, wkts_weight: float = 0.03, total_balls: int = 120) -> float:
    balls_left = max(total_balls - score["balls"], 0)
    crr = score["runs"] * 6 / score["balls"] if score["balls"] else 0
    return score["runs"] + balls_left / 6 * crr * max(1 - wkts_weight * score["wkts"], 0.4)


def edge(first: Score, second: Score, wicket_value: int) -> int:
    return (second["runs"] - first["runs"]) + (first["wkts"] - second["wkts"]) * wicket_value


def band(adj: float) -> str:
    if adj > 15:
        return "Strong Chasing Advantage"
    if adj >= 8:
        return "Moderate Chasing Advantage"
    if adj > -8:
        return "No Clear Edge"
    if adj >= -15:
        return "Moderate Defending Advantage"
    return "Strong Defending Advantage"


def edge_confidence(adj: float) -> int:
    a = abs(adj)
    return 80 if a > 15 else 70 if a >= 8 else 55


def is_finished(match: Match) -> bool:
    status = f'{match.get("ms", "")} {match.get("status", "")}'.lower()
    return bool(
        re.search(
            r"\b(won|result|complete|completed|finished|abandoned|cancelled|tied|drawn|no result)\b",
            status,
        )
    )


def has_no_result(match: Match) -> bool:
    status = f'{match.get("ms", "")} {match.get("status", "")}'.lower()
    return bool(re.search(r"\b(abandoned|cancelled|no result)\b", status))


matches = load_matches()
if not matches:
    st.warning("No saved match data found in .github/data/raw. Run pollMatch.js first.")
    st.stop()

ordered = sorted(matches.values(), key=lambda m: m.get("dateTimeGMT", ""), reverse=True)
labels = {m["id"]: f'{m["t1"]} vs {m["t2"]} ({m.get("dateTimeGMT", "?")})' for m in ordered}
match_id = st.sidebar.selectbox("Match", list(labels), format_func=lambda i: labels[i])
if match_id is None:
    st.stop()
match = matches[match_id]
samples = load_samples(match_id)

s1, s2 = parse_score(match.get("t1s")), parse_score(match.get("t2s"))
st.caption(f'Status: {match.get("status", "unknown")} | Source: saved data only')
c1, c2 = st.columns(2)
c1.metric(match["t1"], match.get("t1s") or "-")
c2.metric(match["t2"], match.get("t2s") or "-")

teams = [match["t1"], match["t2"]]
scores = {match["t1"]: s1, match["t2"]: s2}
default_first = 0
if s1 and s2 and s2["balls"] > s1["balls"]:
    default_first = 0
elif s1 and s2 and s1["balls"] > s2["balls"]:
    default_first = 1
first_team = st.sidebar.selectbox(
    "Team batting first", teams, index=default_first,
    help="The feed does not say who batted first; confirm this.",
)
chase_team = teams[1] if first_team == teams[0] else teams[0]
first, chase = scores[first_team], scores[chase_team]

st.sidebar.markdown("### Benchmark scores (optional override)")
bench: dict[tuple[int, str], Score] = {}
for over in (10, 15):
    for role, team in (("1st", first_team), ("2nd", chase_team)):
        key = f"{match_id}:{over}:{'t1' if team == teams[0] else 't2'}"
        saved: dict[str, Any] = samples.get(key.split(":", 1)[1], {})
        use = st.sidebar.checkbox(
            f"{role} innings @ {over} overs", value=bool(saved), key=f"use{key}"
        )
        if use:
            r = st.sidebar.number_input(f"Runs ({role} @ {over})", 0, 400, int(saved.get("runs", 0)), key=f"r{key}")
            w = st.sidebar.number_input(f"Wkts ({role} @ {over})", 0, 10, int(saved.get("wickets", 0)), key=f"w{key}")
            bench[(over, role)] = {"runs": r, "wkts": w}

st.divider()
st.header("🏏 ChaseEdge AI")

if first and not chase:
    proj = project_total(first)
    st.subheader("First Innings")
    st.metric("Current Score", match.get(("t1s" if first_team == teams[0] else "t2s")))
    st.metric("Projected First Innings Total", round(proj))
    st.write(f"Projection range: {round(proj * 0.94)}-{round(proj * 1.06)}")
    st.write(f"Momentum: {momentum_label(first)}")
    st.write("Confidence: 60% (no momentum, boundary or dot-ball data)")
elif first and chase:
    target = first["runs"] + 1
    st.subheader("Second Innings")
    st.metric("Target", target)

    gateway, adj, conf = "Current Match State", None, 0
    f_bm: Score | None = None
    c_bm: Score | None = None
    for over, wv in ((10, 8), (15, 10)):
        f_b, c_b = bench.get((over, "1st")), bench.get((over, "2nd"))
        if f_b and c_b:
            a = edge(f_b, c_b, wv)
            gateway, adj, f_bm, c_bm = f"{over} Overs", a, f_b, c_b
            conf = edge_confidence(a)
            if conf >= 70:
                break

    balls_left = 120 - chase["balls"]
    proj = project_total(chase)
    if adj is not None:
        proj += adj * 0.3
    finished = is_finished(match)
    if finished:
        proj = chase["runs"]
    conf = conf or (65 if abs(proj - target) > 10 else 55)
    conf = min(conf + (10 if abs(proj - target) > 15 else 0), 85)
    if finished:
        conf = 100

    if finished and has_no_result(match):
        st.info(f'Match ended without a result: {match.get("status") or match.get("ms")}')
        st.stop()

    predicted_total = round(proj)
    st.write(f"Gateway Used: **{gateway}**")
    if adj is not None and f_bm and c_bm:
        st.write(f"1st innings benchmark: {f_bm['runs']}/{f_bm['wkts']}")
        st.write(f"2nd innings benchmark: {c_bm['runs']}/{c_bm['wkts']}")
        st.write(f"Benchmark Edge: **{adj:+.0f}** ({band(adj)})")
    else:
        st.info("No benchmark samples available; using current match state, so confidence is lower.")

    tied = finished and (
        chase["runs"] == first["runs"]
        or re.search(r"\b(tied|drawn)\b", (match.get("status") or "").lower())
    )
    chasing_wins = predicted_total >= target if not finished else chase["runs"] >= target
    winner = "TIED" if tied else "CHASING TEAM" if chasing_wins else "DEFENDING TEAM"
    prediction = (
        "TIED" if tied else "REACHES TARGET" if predicted_total == target
        else "OVER" if chasing_wins else "UNDER"
    )
    st.metric("Predicted Winner", winner)
    st.metric("Predicted 2nd Innings Total", predicted_total)
    prediction_detail = f" {target}" if prediction != "TIED" else ""
    st.write(f"Prediction: **{prediction}{prediction_detail}**")
    margin = predicted_total - target
    st.write(
        f"Expected winning margin: +{margin} runs" if margin >= 0
        else f"Expected shortfall: {-margin} runs"
    )
    st.write(f"Confidence: **{conf}%** ({'Very Strong' if conf >= 85 else 'Strong' if conf >= 75 else 'Moderate' if conf >= 65 else 'Low'})")
    if conf < 65:
        st.warning("No Clear Edge Yet")
    st.write(f"Wickets in hand: {10 - chase['wkts']} | Balls left: {max(balls_left, 0)}")
    if finished:
        st.success(f'Match finished: {match.get("status")}')
else:
    st.info("No parsable scores yet. Predictions start once a score is saved.")

st.caption(
    "Projections use a simple run-rate and wicket-resource heuristic plus the benchmark edge. "
    "Momentum, boundary and dot-ball inputs are unavailable from the score feed."
)
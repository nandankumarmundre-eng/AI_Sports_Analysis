# ChaseEdgeAI

The Streamlit dashboard reads match snapshots saved under `.github/data/raw/`.
It does not fetch data itself.

## Run

1. Install the dashboard dependency with `pip install -r .github/requirements.txt`.
2. Use Node.js 20.6 or newer for the poller commands below.
3. Put the CricAPI key in `.github/.env` as `CRICAPI_KEY=...`.
4. From the repository root, run `node --env-file=.github/.env .github/dashboard/pollMatch.js --list` to list available India vs New Zealand T20 fixtures.
5. Start polling a match with `node --env-file=.github/.env .github/dashboard/pollMatch.js --id <match-id>`. Without `--id`, the poller selects the next live or upcoming India vs New Zealand T20 match.
6. In another terminal, run `streamlit run .github/dashboard/app.py`.

The poller writes ignored API snapshots and benchmark history to `.github/data/raw/`.

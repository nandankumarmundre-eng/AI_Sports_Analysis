from pathlib import Path

import streamlit as st

st.set_page_config(
    page_title="ChaseEdge AI",
    page_icon="🏏",
    layout="wide",
)

logo_path = Path(__file__).resolve().parent.parent / "assets" / "logo.png"
st.image(str(logo_path), width=250)

st.title("ChaseEdge AI")
st.subheader("Same-Stage. Smarter Predictions.")

import os
from dotenv import load_dotenv
from flask import Flask, request, jsonify
import requests

load_dotenv()
BOT_TOKEN       = os.getenv("BOT_TOKEN")
GAME_SHORT_NAME = os.getenv("GAME_SHORT_NAME", "tapclimbjump")
PUBLIC_URL      = os.getenv("PUBLIC_URL", "http://8.222.151.218")

app_api = Flask(__name__)


def safe_int(value, allow_none=False):
    if value is None and allow_none:
        return None
    try:
        return int(value)
    except (ValueError, TypeError):
        return None

@app_api.route("/score", methods=["POST"])
def score_endpoint():
    """
    Body JSON:
    {
      user_id: int,
      user_name: str,
      chat_id: int|null,
      message_id: int|null,
      inline_message_id: str|null,
      score: int
    }
    """
    data = request.get_json(force=True, silent=True) or {}

    print("\n[SCORE] request=", data)
    
    user_name = data.get("user_name")
    user_id = safe_int(data.get("user_id"))
    chat_id = safe_int(data.get("chat_id"), allow_none=True)
    message_id = safe_int(data.get("message_id"), allow_none=True)
    score = safe_int(data.get("score"))
    inline_message_id = data.get("inline_message_id")

    if not isinstance(user_id, int) or not isinstance(score, int):
        return jsonify(ok=False, error="invalid user_id/score"), 400

    payload = {
        "user_id": user_id,
        "score": score,
        "force": False  # allow lowering of highscores to overwrite `while testing; set False in prod
    }
    if inline_message_id:
        payload["inline_message_id"] = inline_message_id
    else:
        if not (isinstance(chat_id, int) and isinstance(message_id, int)):
            return jsonify(ok=False, error="missing message identifiers"), 400
        payload["chat_id"] = chat_id
        payload["message_id"] = message_id

    try:
        r = requests.post(
            f"https://api.telegram.org/bot{BOT_TOKEN}/setGameScore",
            json=payload,
            timeout=10,
        )
        print("[SCORE] result status=", r.status_code, "body=", r.text[:1000], flush=True)
    except requests.RequestException as e:
        print("[SCORE] request failed:", repr(e), flush=True)
        return jsonify(ok=False, error=str(e)), 502

    try:
        body = r.json()
    except ValueError:
        body = {"raw": r.text}

    ok = bool(r.ok and isinstance(body, dict) and body.get("ok"))
    return jsonify(ok=ok, telegram=body), (200 if ok else 502)

def run_api():
    app_api.run(host="0.0.0.0", port=8000)

if __name__ == "__main__":
    run_api()
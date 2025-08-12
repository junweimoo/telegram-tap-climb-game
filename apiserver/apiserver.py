import os
from dotenv import load_dotenv
from flask import Flask, request, jsonify
import requests

load_dotenv()
BOT_TOKEN       = os.getenv("BOT_TOKEN")
GAME_SHORT_NAME = os.getenv("GAME_SHORT_NAME", "tapclimbjump")
PUBLIC_URL      = os.getenv("PUBLIC_URL", "http://8.222.151.218")

app_api = Flask(__name__)

@app_api.route("/score", methods=["POST"])
def score_endpoint():
    """
    Body JSON:
    {
      user_id: int,
      chat_id: int|null,
      message_id: int|null,
      inline_message_id: str|null,
      score: int
    }
    """
    data = request.get_json(force=True, silent=True) or {}

    print("[SCORE]", data)

    user_id = data.get("user_id")
    score = data.get("score")
    chat_id = data.get("chat_id")
    message_id = data.get("message_id")
    inline_message_id = data.get("inline_message_id")

    if not isinstance(user_id, int) or not isinstance(score, int):
        return jsonify(ok=False, error="invalid user_id/score"), 400

    payload = {
        "user_id": user_id,
        "score": score,
        "force": True  # allow lowering to overwrite `while testing; set False in prod
    }
    if inline_message_id:
        payload["inline_message_id"] = inline_message_id
    else:
        if not (isinstance(chat_id, int) and isinstance(message_id, int)):
            return jsonify(ok=False, error="missing message identifiers"), 400
        payload["chat_id"] = chat_id
        payload["message_id"] = message_id

    r = requests.post(f"https://api.telegram.org/bot{BOT_TOKEN}/setGameScore", json=payload, timeout=10)
    ok = r.ok and r.json().get("ok")
    return jsonify(ok=bool(ok), telegram=r.json())

def run_api():
    app_api.run(host="0.0.0.0", port=8000)

if __name__ == "__main__":
    run_api()
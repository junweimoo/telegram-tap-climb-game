import os
from dotenv import load_dotenv
from flask import Flask, request, jsonify
from telegram import Update
from telegram.constants import ParseMode
from telegram.ext import Application, CommandHandler, ContextTypes, CallbackQueryHandler
from urllib.parse import urlencode
import asyncio
import threading
import requests

load_dotenv()
BOT_TOKEN       = os.getenv("BOT_TOKEN")
GAME_SHORT_NAME = os.getenv("GAME_SHORT_NAME", "tapclimbjump")
PUBLIC_URL      = os.getenv("PUBLIC_URL", "http://8.222.151.218")

# ------------------ Telegram Bot (python-telegram-bot) ------------------
app_tg = Application.builder().token(BOT_TOKEN).build()

async def play_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await context.bot.send_game(
        chat_id=update.effective_chat.id,
        game_short_name=GAME_SHORT_NAME,
        message_thread_id=getattr(update.effective_message, "message_thread_id", None)
    )

async def game_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    cq = update.callback_query
    if not cq or not cq.game_short_name:
        return

    user_id = cq.from_user.id
    inline_message_id = cq.inline_message_id  
    message = cq.message

    params = {
        "api_base": PUBLIC_URL,   
        "user_id": user_id,
        "inline_message_id": inline_message_id or ""
    }
    if message:
        params["chat_id"] = message.chat.id
        params["message_id"] = message.message_id

    game_url = f"{PUBLIC_URL}/climbgame/?{urlencode(params)}"

    await context.bot.answer_callback_query(callback_query_id=cq.id, url=game_url)

async def highscores_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    ref = update.effective_message.reply_to_message
    if not ref or not ref.game:
        await update.message.reply_text("Reply to a game message with /highscores.")
        return

    scores = await context.bot.get_game_high_scores(user_id=update.effective_user.id,
                                                    chat_id=ref.chat.id, message_id=ref.message_id)
    if not scores:
        await update.message.reply_text("No scores yet.")
        return

    lines = [f"{i+1}. {s.user.first_name}: {s.score}" for i, s in enumerate(scores)]
    await update.message.reply_text("\n".join(lines))

def run_bot():
    app_tg.add_handler(CommandHandler("play", play_cmd))
    app_tg.add_handler(CallbackQueryHandler(game_callback))
    app_tg.add_handler(CommandHandler("highscores", highscores_cmd))
    
    app_tg.run_polling()

# ------------------ Score API (Flask) ------------------
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
        "force": True  # allow lowering to overwrite while testing; set False in prod
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
    pass

# ------------------ Entrypoint: run both ------------------
if __name__ == "__main__":
    t = threading.Thread(target=run_api, daemon=True)
    t.start()
    # run_api()
    run_bot()

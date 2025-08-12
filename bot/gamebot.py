import os
from dotenv import load_dotenv
from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes, CallbackQueryHandler
from urllib.parse import urlencode

load_dotenv()
BOT_TOKEN       = os.getenv("BOT_TOKEN")
GAME_SHORT_NAME = os.getenv("GAME_SHORT_NAME", "tapclimbjump")
PUBLIC_URL      = os.getenv("PUBLIC_URL", "http://8.222.151.218")

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
        if getattr(message, "message_thread_id", None) is not None:
            params["thread_id"] = message.message_thread_id

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

if __name__ == "__main__":
    run_bot()

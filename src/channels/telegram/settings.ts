export function readTelegramToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error("Set TELEGRAM_BOT_TOKEN to the token supplied by BotFather.");
  }
  return token;
}

export function readTelegramSettings(env: NodeJS.ProcessEnv = process.env) {
  const token = readTelegramToken(env);
  const entries = env.TELEGRAM_ALLOWED_USER_IDS?.split(",").map((id) => id.trim());
  if (!entries?.length || entries.some((id) => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))) {
    throw new Error("Set TELEGRAM_ALLOWED_USER_IDS to your numeric Telegram user ID.");
  }
  return { token, allowedUserIds: new Set(entries.map(Number)) };
}

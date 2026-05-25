const axios = require('axios');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const isTelegramConfigured = !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);

/**
 * Sends a notification message to the configured Telegram chat.
 * @param {string} message The text content to send.
 */
async function sendTelegramAlert(message) {
  if (!isTelegramConfigured) {
    return; // Silent bypass if not configured
  }

  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await axios.post(url, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'Markdown'
    });
  } catch (err) {
    // Log error locally but do not crash the application
    console.error('Failed to send Telegram alert:', err.message);
  }
}

module.exports = {
  sendTelegramAlert,
  isTelegramConfigured
};

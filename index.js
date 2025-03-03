const axios = require('axios');
const { Bot } = require('grammy');
const schedule = require('node-schedule');
const pino = require('pino');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

// Configure logging
const logger = pino({
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard'
    }
  },
  level: 'info'
});

// Write to file
const fileLogger = pino(
  { level: 'info' },
  pino.destination('poller.log')
);

// Log to both console and file
const log = {
  info: (msg) => {
    logger.info(msg);
    fileLogger.info(msg);
  },
  error: (msg) => {
    logger.error(msg);
    fileLogger.error(msg);
  }
};

const config = {
  API_URL: process.env.API_URL,
  REQUEST_INTERVAL: parseInt(process.env.REQUEST_INTERVAL || '300', 10),
  REQUEST_TIMEOUT: parseInt(process.env.REQUEST_TIMEOUT || '30', 10),
  REQUEST_HEADERS: process.env.REQUEST_HEADERS,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  NOTIFY_ON_CHANGE_ONLY: (process.env.NOTIFY_ON_CHANGE_ONLY || 'true').toLowerCase() === 'true'
};

let bot = null;
if (config.TELEGRAM_BOT_TOKEN) {
  bot = new Bot(config.TELEGRAM_BOT_TOKEN);
  log.info('Telegram bot initialized');
} else {
  log.error('Missing Telegram bot token, unable to initialize bot');
}

// Store the previous response ID for comparing changes
let lastResponseId = null;
let lastResponse = null;

/**
 * Send Telegram message
 * @param {string} message - Message to send
 * @returns {Promise<boolean>} - Whether the message was sent successfully
 */
async function sendTelegramMessage(message) {
  if (!bot || !config.TELEGRAM_CHAT_ID) {
    log.error('Telegram configuration missing, cannot send message');
    return false;
  }

  try {
    await bot.api.sendMessage(config.TELEGRAM_CHAT_ID, message, { parse_mode: 'HTML' });
    log.info('Telegram message sent successfully');
    return true;
  } catch (error) {
    log.error(`Failed to send Telegram message: ${error.message}`);
    return false;
  }
}

/**
 * Format response data into readable message in chat
 * @param {any} responseData - Response data
 * @returns {string} - Formatted message
 */
function formatResponse(responseData) {
  try {
    if (typeof responseData === 'object') {
      return JSON.stringify(responseData);
    } else {
      return String(responseData);
    }
  } catch (error) {
    log.error(`Failed to format response data: ${error.message}`);
    return String(responseData);
  }
}

/**
 * Poll HTTP endpoint and process response
 */
async function pollHttpEndpoint() {
  log.info(`Starting to poll ${config.API_URL}`);

  try {
    const response = await axios.get(config.API_URL, {
      headers: config.REQUEST_HEADERS,
      timeout: config.REQUEST_TIMEOUT * 1000
    });

    // Check response status code
    if (response.status !== 200) {
      const errorMsg = `HTTP request failed: Status code ${response.status}`;
      log.error(errorMsg);
      // await sendTelegramMessage(`❌ ${errorMsg}`);
      return;
    }

    // Get response data
    const responseData = response.data.data[0];

    // Compare using ID directly
    const currentId = responseData.id;

    // Check if response has changed
    const hasChanged = currentId !== lastResponseId;

    if (hasChanged) {
      const timestamp = new Date().toLocaleString();
      const status = hasChanged ? '🔄 Data updated' : '✅ Data unchanged';
      const message = `${timestamp} ${status}\n\n${formatResponse(responseData)}`;
      await sendTelegramMessage(message);
    }

    // Update previous response
    lastResponse = responseData;
    lastResponseId = currentId;

    log.info(`Polling completed, data ${hasChanged ? 'updated' : 'unchanged'}`);

  } catch (error) {
    const errorMsg = `HTTP request exception: ${error.message}`;
    log.error(errorMsg);
  }
}

/**
 * Set up bot commands
 */
function setupBotCommands() {
  if (!bot) return;

  // Start command
  bot.command('start', async (ctx) => {
    await ctx.reply('👋 Welcome to HTTP Polling Bot! I will regularly check the API and send update notifications.');
    log.info('User sent /start command');
  });

  // Help command
  bot.command('help', async (ctx) => {
    const helpMessage = `
🤖 <b>HTTP Polling Bot Help</b>

<b>Command List:</b>
/start - Start the bot
/help - Show help information
/status - Check bot status
/check - Run a check immediately
    `;
    await ctx.reply(helpMessage, { parse_mode: 'HTML' });
    log.info('User sent /help command');
  });

  // Status command
  bot.command('status', async (ctx) => {
    const statusMessage = `
🔍 <b>Bot Status</b>

⏱ Polling interval: ${config.REQUEST_INTERVAL} seconds
🔗 API address: ${config.API_URL}
📝 Notify only on data change: ${config.NOTIFY_ON_CHANGE_ONLY ? 'Yes' : 'No'}
🕒 Last update time: ${lastResponse ? new Date().toLocaleString() : 'No data retrieved yet'}
    `;
    await ctx.reply(statusMessage, { parse_mode: 'HTML' });
    log.info('User sent /status command');
  });

  // Manual check command
  bot.command('check', async (ctx) => {
    await ctx.reply('🔍 Running manual check...');
    log.info('User sent /check command, executing manual check');
    await pollHttpEndpoint();
    await ctx.reply('✅ Manual check completed');
  });

  // Handle errors
  bot.catch((err) => {
    log.error(`Bot error: ${err.message}`);
  });
}

/**
 * Main function
 */
async function main() {
  log.info('HTTP polling service started');

  if (bot) {
    // Set up bot commands
    setupBotCommands();
    
    // Start the bot
    bot.start();
    log.info('Telegram bot started');
  }

  // Execute immediately once
  await pollHttpEndpoint();

  // Set up scheduled task
  schedule.scheduleJob(`*/${config.REQUEST_INTERVAL} * * * * *`, async () => {
    await pollHttpEndpoint();
  });

  log.info(`Scheduled task set up, polling every ${config.REQUEST_INTERVAL} seconds`);
}

// Start the program
main().catch(error => {
  log.error(`Program startup failed: ${error.message}`);
}); 
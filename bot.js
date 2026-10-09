const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== MIDDLEWARE ====================
app.use(cors());
app.use(express.json());

// Bypass ngrok warning screen
app.use((req, res, next) => {
    res.setHeader('ngrok-skip-browser-warning', 'true');
    next();
});

// ==================== STATE ====================
let client = null;
let isReady = false;
let isInitializing = false;
let qrCodeBase64 = null;
let qrCodeRaw = null;
let status = 'disconnected';

const SESSION_DIR = './sessions';

// ==================== HELPERS ====================

/**
 * Safely clear a puppeteer lock file left behind after a crash.
 */
function clearSessionLock() {
    try {
        const lockFiles = [
            path.join(SESSION_DIR, 'session', 'SingletonLock'),
            path.join(SESSION_DIR, 'session', 'SingletonCookie'),
            path.join(SESSION_DIR, 'session', 'SingletonSocket'),
        ];
        lockFiles.forEach((f) => {
            if (fs.existsSync(f)) {
                fs.unlinkSync(f);
                console.log(`🧹 Removed stale lock: ${f}`);
            }
        });
    } catch (err) {
        console.error('Failed to clear session lock:', err.message);
    }
}

/**
 * Ensure sessions directory exists.
 */
function ensureSessionDir() {
    if (!fs.existsSync(SESSION_DIR)) {
        fs.mkdirSync(SESSION_DIR, { recursive: true });
        console.log(`📁 Created sessions directory: ${SESSION_DIR}`);
    }
}

/**
 * Destroy any existing client instance cleanly.
 */
async function destroyClient() {
    if (!client) return;
    try {
        console.log('🧨 Destroying existing client...');
        await client.destroy();
    } catch (err) {
        console.error('Error destroying client:', err.message);
    } finally {
        client = null;
        isReady = false;
    }
}

/**
 * Safely fetch chats, falling back to contacts if getChats() fails.
 */
async function safeGetChats() {
    try {
        // Primary method
        const chats = await client.getChats();
        // Filter out any chats that may be broken/undefined
        return chats.filter((c) => c && c.id && c.id._serialized);
    } catch (error) {
        console.warn('⚠️ getChats() failed:', error.message);
        console.log('🔄 Falling back to getContacts()...');

        try {
            const contacts = await client.getContacts();
            // Build minimal chat-like objects for groups
            const groupChats = [];
            for (const contact of contacts) {
                if (contact.isGroup) {
                    try {
                        const chat = await client.getChatById(contact.id._serialized);
                        if (chat && chat.id) groupChats.push(chat);
                    } catch (e) {
                        // Skip broken chats
                        console.warn(`Skipping broken group ${contact.id._serialized}`);
                    }
                }
            }
            return groupChats;
        } catch (fallbackError) {
            console.error('❌ Fallback also failed:', fallbackError.message);
            return [];
        }
    }
}

/**
 * Resolve a chat by ID, converting @lid to @c.us when needed.
 */
async function resolveChat(chatId) {
    try {
        return await client.getChatById(chatId);
    } catch (err) {
        // Try alternate suffix
        if (chatId.endsWith('@lid')) {
            const alt = chatId.replace('@lid', '@c.us');
            console.log(`🔁 Retrying with ${alt}`);
            return await client.getChatById(alt);
        }
        throw err;
    }
}

function getStatusMessage(status) {
    const messages = {
        disconnected: 'Bot is disconnected',
        qr_generated: 'Scan QR code to connect',
        authenticated: 'Authenticated, connecting...',
        ready: 'Bot is ready!',
        error: 'Error occurred',
    };
    return messages[status] || status;
}

// ==================== WHATSAPP CLIENT ====================

async function initializeClient() {
    if (isInitializing) {
        console.log('⏳ Already initializing, skipping...');
        return;
    }
    if (client && isReady) {
        console.log('✅ Client already ready, skipping init.');
        return;
    }

    isInitializing = true;
    console.log('🚀 Initializing WhatsApp client...');

    try {
        ensureSessionDir();

        // Make sure no previous browser instance is holding the session
        await destroyClient();
        clearSessionLock();

        client = new Client({
            authStrategy: new LocalAuth({
                dataPath: SESSION_DIR,
                clientId: 'bot',
            }),
            puppeteer: {
                headless: true,
                executablePath: '/usr/bin/google-chrome',
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--disable-gpu',
                    '--disable-web-security',
                ],
            },
        });

        // ---------- QR ----------
        client.on('qr', async (qr) => {
            console.log('📱 QR Code generated. Scan with WhatsApp:');
            qrcode.generate(qr, { small: true });
            qrCodeRaw = qr;
            status = 'qr_generated';

            try {
                qrCodeBase64 = await QRCode.toDataURL(qr, {
                    type: 'image/png',
                    margin: 2,
                    scale: 8,
                    errorCorrectionLevel: 'H',
                });
                console.log(`✅ QR Code saved as base64 (length: ${qrCodeBase64.length})`);
            } catch (err) {
                console.error('Failed to generate QR image:', err.message);
                try {
                    qrCodeBase64 = await QRCode.toDataURL(qr);
                    console.log('✅ QR Code saved with fallback');
                } catch (err2) {
                    console.error('Fallback also failed:', err2.message);
                }
            }
        });

        // ---------- Authenticated ----------
        client.on('authenticated', () => {
            console.log('✅ WhatsApp authenticated successfully!');
            status = 'authenticated';
            qrCodeBase64 = null;
            qrCodeRaw = null;
        });

        // ---------- Ready ----------
        client.on('ready', () => {
            console.log('🎉 WhatsApp client is ready!');
            isReady = true;
            isInitializing = false;
            status = 'ready';
            console.log('📱 Bot is online and ready to send messages!');
        });

        // ---------- Auth Failure ----------
        client.on('auth_failure', (msg) => {
            console.error('❌ Authentication failed:', msg);
            isReady = false;
            status = 'error';
            isInitializing = false;
        });

        // ---------- Disconnected ----------
        client.on('disconnected', async (reason) => {
            console.log(`⚠️ WhatsApp disconnected: ${reason}`);
            isReady = false;
            status = 'disconnected';
            await destroyClient();
            console.log('🔄 Attempting to reconnect in 30 seconds...');
            setTimeout(() => initializeClient(), 30000);
        });

        // ---------- Incoming Messages ----------
        client.on('message', async (message) => {
            try {
                console.log(`📩 Message from ${message.from}: ${message.body}`);

                if (message.body === '!ping') {
                    await message.reply('🏓 Pong! Bot is alive.');
                }

                if (message.body === '!status') {
                    const chat = await message.getChat();
                    const statusMsg =
                        `🤖 *Bot Status*\n\n` +
                        `✅ Status: Online\n` +
                        `📱 Connected: Yes\n` +
                        `👥 Group: ${chat.name || 'N/A'}\n` +
                        `🕐 ${new Date().toLocaleString()}`;
                    await message.reply(statusMsg);
                }

                if (message.body === '!help') {
                    await message.reply(
                        `📖 *Available Commands*\n\n` +
                            `!ping - Check if bot is alive\n` +
                            `!status - Show bot status\n` +
                            `!help - Show this help\n` +
                            `!about - About this bot\n` +
                            `!groups - List available groups`
                    );
                }

                if (message.body === '!about') {
                    await message.reply(
                        `🤖 *WhatsApp Bot*\n\n` +
                            `Version: 1.0.0\n` +
                            `Type: Notification Bot\n` +
                            `Status: 🟢 Online\n\n` +
                            `📌 Built with whatsapp-web.js`
                    );
                }

                if (message.body === '!groups') {
                    if (!isReady) {
                        await message.reply('❌ Bot is not ready yet. Please wait...');
                        return;
                    }
                    const chats = await safeGetChats();
                    const groups = chats.filter((c) => c.isGroup);

                    let groupMsg = '📋 *Available Groups*\n\n';
                    if (groups.length === 0) {
                        groupMsg = 'No groups found. Make sure you are in at least one group.';
                    } else {
                        groups.forEach((g, i) => {
                            groupMsg += `${i + 1}. ${g.name || 'Unnamed'}\n`;
                            groupMsg += `   ID: ${g.id._serialized}\n`;
                            groupMsg += `   Members: ${
                                g.participants ? g.participants.length : 0
                            }\n\n`;
                        });
                    }
                    await message.reply(groupMsg);
                }
            } catch (error) {
                console.error('Error processing message:', error);
            }
        });

        // ---------- Initialize ----------
        await client.initialize();
        isInitializing = false;
    } catch (err) {
        console.error('❌ Failed to initialize client:', err.message);
        status = 'error';
        isInitializing = false;
        isReady = false;
        await destroyClient();
    }
}

// ==================== EXPRESS ENDPOINTS ====================

// --- Status ---
app.get('/status', (req, res) => {
    res.json({
        status,
        isReady,
        hasQr: !!qrCodeBase64 || !!qrCodeRaw,
        qr: qrCodeBase64 || null,
        uptime: process.uptime(),
        message: getStatusMessage(status),
    });
});

// --- QR ---
app.get('/qr', async (req, res) => {
    try {
        if (qrCodeBase64 && qrCodeBase64.startsWith('data:image')) {
            return res.json({
                success: true,
                qr: qrCodeBase64,
                instructions: 'Scan this QR code with WhatsApp on your phone',
            });
        }

        if (qrCodeRaw) {
            const qrImage = await QRCode.toDataURL(qrCodeRaw, {
                type: 'image/png',
                margin: 2,
                scale: 8,
            });
            qrCodeBase64 = qrImage;
            return res.json({
                success: true,
                qr: qrImage,
                instructions: 'Scan this QR code with WhatsApp on your phone',
            });
        }

        res.status(404).json({
            success: false,
            error: 'QR code not available. Check if bot is initialized.',
        });
    } catch (error) {
        console.error('QR generation error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to generate QR code: ' + error.message,
        });
    }
});

// --- Groups (FIXED) ---
app.get('/groups', async (req, res) => {
    try {
        if (!isReady) {
            return res.status(503).json({
                success: false,
                error: 'WhatsApp client is not ready. Please scan QR code first.',
                data: [],
            });
        }

        const chats = await safeGetChats();
        const groups = chats
            .filter((chat) => chat.isGroup)
            .map((chat) => ({
                id: chat.id._serialized,
                name: chat.name || 'Unnamed Group',
                participants: chat.participants ? chat.participants.length : 0,
                isGroup: true,
            }));

        res.json({ success: true, data: groups });
    } catch (error) {
        console.error('Groups error:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            data: [],
        });
    }
});

// --- Send Message ---
app.post('/send', async (req, res) => {
    try {
        const { groupId, message } = req.body;

        if (!groupId) {
            return res.status(400).json({ success: false, error: 'Group ID is required' });
        }
        if (!message) {
            return res.status(400).json({ success: false, error: 'Message is required' });
        }
        if (!isReady) {
            return res.status(503).json({ success: false, error: 'WhatsApp client is not ready' });
        }

        const chat = await resolveChat(groupId);
        await chat.sendMessage(message);

        res.json({ success: true, message: 'Message sent successfully' });
    } catch (error) {
        console.error('Send error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- Send Entry Notification ---
app.post('/send-entry', async (req, res) => {
    try {
        const { groupId, entryData } = req.body;

        if (!groupId) {
            return res.status(400).json({ success: false, error: 'Group ID is required' });
        }
        if (!entryData) {
            return res.status(400).json({ success: false, error: 'Entry data is required' });
        }
        if (!isReady) {
            return res.status(503).json({ success: false, error: 'WhatsApp client is not ready' });
        }

        const message = formatEntryMessage(entryData);
        const chat = await resolveChat(groupId);
        await chat.sendMessage(message);

        res.json({ success: true, message: 'Entry notification sent successfully' });
    } catch (error) {
        console.error('Send entry error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- Send Daily Summary ---
app.post('/send-summary', async (req, res) => {
    try {
        const { groupId, summaryData } = req.body;

        if (!groupId) {
            return res.status(400).json({ success: false, error: 'Group ID is required' });
        }
        if (!summaryData) {
            return res.status(400).json({ success: false, error: 'Summary data is required' });
        }
        if (!isReady) {
            return res.status(503).json({ success: false, error: 'WhatsApp client is not ready' });
        }

        const message = formatSummaryMessage(summaryData);
        const chat = await resolveChat(groupId);
        await chat.sendMessage(message);

        res.json({ success: true, message: 'Summary sent successfully' });
    } catch (error) {
        console.error('Send summary error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- Init ---
app.post('/init', async (req, res) => {
    if (client && isReady) {
        return res.json({ success: true, message: 'Bot is already initialized and ready' });
    }
    if (isInitializing) {
        return res.json({ success: true, message: 'Bot initialization already in progress.' });
    }

    initializeClient();
    res.json({
        success: true,
        message: 'Bot initialization started. Check /status for progress.',
    });
});

// --- Disconnect ---
app.post('/disconnect', async (req, res) => {
    try {
        await destroyClient();
        status = 'disconnected';
        qrCodeBase64 = null;
        qrCodeRaw = null;
        res.json({ success: true, message: 'Bot disconnected successfully' });
    } catch (error) {
        console.error('Disconnect error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== MESSAGE FORMATTERS ====================

function formatEntryMessage(entry) {
    let message = `📋 *KIEMS Entry Update*\n\n`;
    message += `📅 *Date:* ${entry.entry_date || new Date().toISOString().split('T')[0]}\n`;
    message += `⏰ *Time:* ${entry.time || new Date().toLocaleTimeString()}\n\n`;
    message += `📦 *Kit:* ${entry.kit_name || 'N/A'}\n`;
    message += `📍 *Ward:* ${entry.ward_name || 'N/A'}\n`;
    message += `🏷️ *Phase:* ${entry.phase_name || 'N/A'}\n`;
    message += `👤 *VRA:* ${entry.vra_name || 'N/A'}\n`;
    message += `🏢 *Venue:* ${entry.venue || 'N/A'}\n\n`;
    message += `👥 *Registrations:*\n`;
    message += `├ ♂️ Male: ${entry.male || 0}\n`;
    message += `├ ♀️ Female: ${entry.female || 0}\n`;
    message += `└ 🧑 Other: ${entry.other || 0}\n\n`;
    message += `📊 *Total Registered:* ${entry.total_registered || 0}\n`;
    message += `🔄 *Transferred:* ${entry.transferred || 0}\n`;
    message += `📝 *Updated:* ${entry.updated || 0}\n\n`;
    message += `✅ *Status:* ${entry.uploaded ? 'Uploaded ✅' : 'Pending ⏳'}`;
    return message;
}

function formatSummaryMessage(summary) {
    const date = new Date().toLocaleDateString();

    let message = `📊 *KIEMS Daily Summary*\n`;
    message += `📅 ${date}\n\n`;
    message += `📈 *Today's Performance:*\n`;
    message += `├ 📝 Total Entries: ${summary.total_entries || 0}\n`;
    message += `├ 📦 Active Kits: ${summary.unique_kits || 0}\n`;
    message += `└ 👥 Total Registered: ${summary.total_registered || 0}\n\n`;
    message += `👤 *Gender Breakdown:*\n`;
    message += `├ ♂️ Male: ${summary.total_male || 0}\n`;
    message += `├ ♀️ Female: ${summary.total_female || 0}\n`;
    message += `└ 🧑 Other: ${summary.total_other || 0}\n\n`;
    message += `🔄 *Transfers:* ${summary.total_transferred || 0}\n`;
    message += `📝 *Updates:* ${summary.total_updated || 0}\n\n`;

    if (summary.top_kit) {
        message += `🏆 *Top Kit:* ${summary.top_kit} - ${summary.top_kit_count || 0} registrations\n\n`;
    }

    if (summary.wards && summary.wards.length > 0) {
        const topWards = summary.wards.slice(0, 5);
        message += `📊 *Ward Summary:*\n`;
        topWards.forEach((ward, index) => {
            const prefix = index < topWards.length - 1 ? '├' : '└';
            message += `${prefix} ${ward.name}: ${ward.count} registrations\n`;
        });
    }

    return message;
}

// ==================== START SERVER ====================

app.listen(PORT, '127.0.0.1', () => {
    console.log(`🚀 WhatsApp Bot Server running on port ${PORT}`);
    console.log(`📍 Health check: http://localhost:${PORT}/status`);
    console.log(`📌 Endpoints:`);
    console.log(`   GET  /status       - Check bot status`);
    console.log(`   GET  /qr           - Get QR code`);
    console.log(`   GET  /groups       - List WhatsApp groups`);
    console.log(`   POST /init         - Initialize bot`);
    console.log(`   POST /send         - Send message to group`);
    console.log(`   POST /send-entry   - Send entry notification`);
    console.log(`   POST /send-summary - Send daily summary`);
    console.log(`   POST /disconnect   - Disconnect bot`);
    console.log('\n🤖 WhatsApp commands: !ping | !status | !help | !about | !groups');
    console.log('\n📱 Starting WhatsApp client...');

    initializeClient();
});

// ==================== GRACEFUL SHUTDOWN ====================

async function shutdown(signal) {
    console.log(`\n🛑 Received ${signal}. Shutting down...`);
    await destroyClient();
    process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
    console.error('💥 Uncaught exception:', err);
});
process.on('unhandledRejection', (reason) => {
    console.error('💥 Unhandled rejection:', reason);
});
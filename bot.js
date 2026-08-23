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

// Middleware
app.use(cors());
app.use(express.json());

// State
let client = null;
let isReady = false;
let qrCodeBase64 = null;
let qrCodeRaw = null;
let status = 'disconnected';

// ==================== WHATSAPP CLIENT ====================

function initializeClient() {
    console.log('🚀 Initializing WhatsApp client...');
    
    // Ensure sessions directory exists
    const sessionDir = './sessions';
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }
    
    client = new Client({
        authStrategy: new LocalAuth({
            dataPath: sessionDir
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
                '--disable-web-security'
            ]
        }
    });

    // QR Code event
    client.on('qr', async (qr) => {
        console.log('📱 QR Code generated. Scan with WhatsApp:');
        qrcode.generate(qr, { small: true });
        qrCodeRaw = qr;
        status = 'qr_generated';
        
        try {
            // Generate QR as base64 data URL
            qrCodeBase64 = await QRCode.toDataURL(qr, {
                type: 'image/png',
                margin: 2,
                scale: 8,
                errorCorrectionLevel: 'H'
            });
            console.log('✅ QR Code saved as base64 (length: ' + qrCodeBase64.length + ')');
        } catch (err) {
            console.error('Failed to generate QR image:', err);
            // Fallback: try without options
            try {
                qrCodeBase64 = await QRCode.toDataURL(qr);
                console.log('✅ QR Code saved with fallback');
            } catch (err2) {
                console.error('Fallback also failed:', err2);
            }
        }
    });

    // Authenticated event
    client.on('authenticated', () => {
        console.log('✅ WhatsApp authenticated successfully!');
        status = 'authenticated';
        qrCodeBase64 = null;
        qrCodeRaw = null;
    });

    // Ready event
    client.on('ready', () => {
        console.log('🎉 WhatsApp client is ready!');
        isReady = true;
        status = 'ready';
        console.log(`📱 Bot is online and ready to send messages!`);
    });

    // Disconnected event
    client.on('disconnected', (reason) => {
        console.log(`⚠️ WhatsApp disconnected: ${reason}`);
        isReady = false;
        status = 'disconnected';
        console.log('🔄 Attempting to reconnect in 30 seconds...');
        setTimeout(() => {
            initializeClient();
        }, 30000);
    });

    // Message event
    client.on('message', async (message) => {
        try {
            console.log(`📩 Message from ${message.from}: ${message.body}`);
            
            if (message.body === '!ping') {
                await message.reply('🏓 Pong! Bot is alive.');
            }
            
            if (message.body === '!status') {
                const chat = await message.getChat();
                const statusMsg = `🤖 *Bot Status*\n\n` +
                    `✅ Status: Online\n` +
                    `📱 Connected: Yes\n` +
                    `👥 Group: ${chat.name || 'N/A'}\n` +
                    `🕐 ${new Date().toLocaleString()}`;
                await message.reply(statusMsg);
            }
            
            if (message.body === '!help') {
                const helpMsg = `📖 *Available Commands*\n\n` +
                    `!ping - Check if bot is alive\n` +
                    `!status - Show bot status\n` +
                    `!help - Show this help\n` +
                    `!about - About this bot\n` +
                    `!groups - List available groups`;
                await message.reply(helpMsg);
            }
            
            if (message.body === '!about') {
                const aboutMsg = `🤖 *WhatsApp Bot*\n\n` +
                    `Version: 1.0.0\n` +
                    `Type: Notification Bot\n` +
                    `Status: 🟢 Online\n\n` +
                    `📌 Built with whatsapp-web.js`;
                await message.reply(aboutMsg);
            }
            
            if (message.body === '!groups') {
                if (!isReady) {
                    await message.reply('❌ Bot is not ready yet. Please wait...');
                    return;
                }
                try {
                    const chats = await client.getChats();
                    const groups = chats.filter(chat => chat.isGroup);
                    let groupMsg = '📋 *Available Groups*\n\n';
                    groups.forEach((g, i) => {
                        groupMsg += `${i+1}. ${g.name}\n`;
                        groupMsg += `   ID: ${g.id._serialized}\n`;
                        groupMsg += `   Members: ${g.participants ? g.participants.length : 0}\n\n`;
                    });
                    if (groups.length === 0) {
                        groupMsg = 'No groups found. Make sure you are in at least one group.';
                    }
                    await message.reply(groupMsg);
                } catch (error) {
                    await message.reply('❌ Failed to get groups: ' + error.message);
                }
            }
        } catch (error) {
            console.error('Error processing message:', error);
        }
    });

    // Start the client
    client.initialize().catch(err => {
        console.error('❌ Failed to initialize client:', err);
        status = 'error';
    });
}

// ==================== EXPRESS API ENDPOINTS ====================

// Get status with QR code
app.get('/status', (req, res) => {
    const hasQr = !!qrCodeBase64 || !!qrCodeRaw;
    const qrData = qrCodeBase64 || null;
    
    res.json({
        status: status,
        isReady: isReady,
        hasQr: hasQr,
        qr: qrData,
        uptime: process.uptime(),
        message: getStatusMessage(status)
    });
});

function getStatusMessage(status) {
    const messages = {
        'disconnected': 'Bot is disconnected',
        'qr_generated': 'Scan QR code to connect',
        'authenticated': 'Authenticated, connecting...',
        'ready': 'Bot is ready!',
        'error': 'Error occurred'
    };
    return messages[status] || status;
}

// Get QR code only
app.get('/qr', async (req, res) => {
    try {
        // If we have base64 QR, return it directly
        if (qrCodeBase64 && qrCodeBase64.startsWith('data:image')) {
            return res.json({ 
                success: true, 
                qr: qrCodeBase64,
                instructions: 'Scan this QR code with WhatsApp on your phone'
            });
        }
        
        // If we have raw QR, generate it
        if (qrCodeRaw) {
            const qrImage = await QRCode.toDataURL(qrCodeRaw, {
                type: 'image/png',
                margin: 2,
                scale: 8
            });
            qrCodeBase64 = qrImage;
            return res.json({ 
                success: true, 
                qr: qrImage,
                instructions: 'Scan this QR code with WhatsApp on your phone'
            });
        }
        
        // No QR available
        res.status(404).json({ 
            success: false, 
            error: 'QR code not available. Check if bot is initialized.' 
        });
    } catch (error) {
        console.error('QR generation error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to generate QR code: ' + error.message 
        });
    }
});

// Get groups
app.get('/groups', async (req, res) => {
    try {
        if (!isReady) {
            return res.status(503).json({ 
                success: false, 
                error: 'WhatsApp client is not ready. Please scan QR code first.',
                data: []
            });
        }
        
        const chats = await client.getChats();
        const groups = chats
            .filter(chat => chat.isGroup)
            .map(chat => ({
                id: chat.id._serialized,
                name: chat.name || 'Unnamed Group',
                participants: chat.participants ? chat.participants.length : 0,
                isGroup: true
            }));
        
        res.json({ success: true, data: groups });
    } catch (error) {
        console.error('Groups error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message,
            data: []
        });
    }
});

// Send message
app.post('/send', async (req, res) => {
    try {
        const { groupId, message } = req.body;
        
        if (!groupId) {
            return res.status(400).json({ 
                success: false, 
                error: 'Group ID is required' 
            });
        }
        
        if (!message) {
            return res.status(400).json({ 
                success: false, 
                error: 'Message is required' 
            });
        }
        
        if (!isReady) {
            return res.status(503).json({ 
                success: false, 
                error: 'WhatsApp client is not ready' 
            });
        }
        
        const chat = await client.getChatById(groupId);
        await chat.sendMessage(message);
        
        res.json({ 
            success: true, 
            message: 'Message sent successfully' 
        });
    } catch (error) {
        console.error('Send error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Send entry notification
app.post('/send-entry', async (req, res) => {
    try {
        const { groupId, entryData } = req.body;
        
        if (!groupId) {
            return res.status(400).json({ 
                success: false, 
                error: 'Group ID is required' 
            });
        }
        
        if (!entryData) {
            return res.status(400).json({ 
                success: false, 
                error: 'Entry data is required' 
            });
        }
        
        if (!isReady) {
            return res.status(503).json({ 
                success: false, 
                error: 'WhatsApp client is not ready' 
            });
        }
        
        const message = formatEntryMessage(entryData);
        const chat = await client.getChatById(groupId);
        await chat.sendMessage(message);
        
        res.json({ 
            success: true, 
            message: 'Entry notification sent successfully' 
        });
    } catch (error) {
        console.error('Send entry error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Send daily summary
app.post('/send-summary', async (req, res) => {
    try {
        const { groupId, summaryData } = req.body;
        
        if (!groupId) {
            return res.status(400).json({ 
                success: false, 
                error: 'Group ID is required' 
            });
        }
        
        if (!summaryData) {
            return res.status(400).json({ 
                success: false, 
                error: 'Summary data is required' 
            });
        }
        
        if (!isReady) {
            return res.status(503).json({ 
                success: false, 
                error: 'WhatsApp client is not ready' 
            });
        }
        
        const message = formatSummaryMessage(summaryData);
        const chat = await client.getChatById(groupId);
        await chat.sendMessage(message);
        
        res.json({ 
            success: true, 
            message: 'Summary sent successfully' 
        });
    } catch (error) {
        console.error('Send summary error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Initialize bot
app.post('/init', (req, res) => {
    if (client && isReady) {
        return res.json({ 
            success: true, 
            message: 'Bot is already initialized and ready' 
        });
    }
    
    initializeClient();
    res.json({ 
        success: true, 
        message: 'Bot initialization started. Check /status for progress.' 
    });
});

// Disconnect bot
app.post('/disconnect', async (req, res) => {
    try {
        if (client) {
            await client.destroy();
        }
        isReady = false;
        status = 'disconnected';
        qrCodeBase64 = null;
        qrCodeRaw = null;
        res.json({ 
            success: true, 
            message: 'Bot disconnected successfully' 
        });
    } catch (error) {
        console.error('Disconnect error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== MESSAGE FORMATTERS ====================

function formatEntryMessage(entry) {
    const timestamp = new Date().toLocaleString();
    
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
        message += `📊 *Ward Summary:*\n`;
        summary.wards.slice(0, 5).forEach((ward, index) => {
            const prefix = index < summary.wards.slice(0, 5).length - 1 ? '├' : '└';
            message += `${prefix} ${ward.name}: ${ward.count} registrations\n`;
        });
    }
    
    return message;
}

// ==================== START SERVER ====================

app.listen(PORT, () => {
    console.log(`🚀 WhatsApp Bot Server running on port ${PORT}`);
    console.log(`📍 Health check: http://localhost:${PORT}/status`);
    console.log(`📌 Endpoints:`);
    console.log(`   GET  /status     - Check bot status`);
    console.log(`   GET  /qr         - Get QR code`);
    console.log(`   GET  /groups     - List WhatsApp groups`);
    console.log(`   POST /init       - Initialize bot`);
    console.log(`   POST /send       - Send message to group`);
    console.log(`   POST /send-entry - Send entry notification`);
    console.log(`   POST /send-summary - Send daily summary`);
    console.log(`   POST /disconnect - Disconnect bot`);
    console.log('\n🤖 Type in WhatsApp:');
    console.log('   !ping    - Check if bot is alive');
    console.log('   !status  - Show bot status');
    console.log('   !help    - Show available commands');
    console.log('   !about   - About this bot');
    console.log('   !groups  - List available groups');
    console.log('\n📱 Starting WhatsApp client...');
    
    // Auto-initialize on start
    initializeClient();
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down...');
    if (client) {
        await client.destroy();
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 Shutting down...');
    if (client) {
        await client.destroy();
    }
    process.exit(0);
});
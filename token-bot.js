const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const express = require('express');

// Configuration
const CONFIG = {
    BOT_TOKEN: process.env.BOT_TOKEN || '',
    GUILD_ID: '1462256387718381621', // Votre serveur Discord ID
    ADMIN_ROLE_ID: '1462258879017648162', // Role Admin qui gère les tokens
    TOKEN_CHANNEL_ID: '1462258313952759848', // Salon #launcher-tokens
    TOKEN_EXPIRY_SECONDS: 120, // 2 minutes
    DB_PATH: path.join(__dirname, 'tokens.db'),
    API_PORT: process.env.PORT || 3002 // Port for SA-MP server validation
};

// Initialize Discord bot
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Initialize SQLite database
const db = new sqlite3.Database(CONFIG.DB_PATH, (err) => {
    if (err) {
        console.error('Database error:', err);
    } else {
        console.log('Connected to token database');
        initDatabase();
    }
});

// Create tables
function initDatabase() {
    db.run(`
        CREATE TABLE IF NOT EXISTS launcher_tokens (
            token TEXT PRIMARY KEY,
            machine_name TEXT,
            user_name TEXT,
            created_at INTEGER NOT NULL,
            used INTEGER DEFAULT 0,
            player_name TEXT DEFAULT NULL,
            player_ip TEXT DEFAULT NULL,
            discord_message_id TEXT DEFAULT NULL
        )
    `);
    
    // Clean expired tokens every minute
    setInterval(cleanExpiredTokens, 60000);
}

// Clean expired tokens
function cleanExpiredTokens() {
    const expiry = Math.floor(Date.now() / 1000) - CONFIG.TOKEN_EXPIRY_SECONDS;
    db.run('DELETE FROM launcher_tokens WHERE created_at < ? AND used = 0', [expiry], function(err) {
        if (err) {
            console.error('Error cleaning tokens:', err);
        } else if (this.changes > 0) {
            console.log(`Cleaned ${this.changes} expired tokens`);
        }
    });
}

// Bot ready
client.once('ready', () => {
    console.log(`✅ Bot logged in as ${client.user.tag}`);
    console.log(`📊 Serving ${client.guilds.cache.size} servers`);
    
    // Set bot status
    client.user.setActivity('Launcher Tokens', { type: 'WATCHING' });
});

// Handle messages (for webhook simulation or direct token registration)
client.on('messageCreate', async (message) => {
    // Process both bot and user messages (webhooks come as bot messages)
    if (!message.content) return;
    
    // Only in token channel
    if (message.channelId !== CONFIG.TOKEN_CHANNEL_ID) return;
    
    // Parse token from message (handle both plain and code-block formats)
    // Format 1: Token: XXXXX (plain)
    // Format 2: ```\nToken: XXXXX\nMachine: YYY\n``` (code block)
    const tokenMatch = message.content.match(/Token:\s*([a-zA-Z0-9]{32})/i);
    if (!tokenMatch) return;
    
    const token = tokenMatch[1];
    
    // Extract machine and user - be flexible with whitespace and newlines
    const contentLines = message.content.split('\n');
    let machineName = 'Unknown';
    let userName = 'Unknown';
    
    for (const line of contentLines) {
        const machineMatch = line.match(/Machine:\s*(.+?)(?:\s|$)/i);
        const userMatch = line.match(/User:\s*(.+?)(?:\s|$)/i);
        
        if (machineMatch) machineName = machineMatch[1].trim();
        if (userMatch) userName = userMatch[1].trim();
    }
    
    // Store token in database
    registerToken(token, machineName, userName, message.id);
});

// Register token
function registerToken(token, machineName, userName, messageId) {
    const now = Math.floor(Date.now() / 1000);
    
    db.run(
        'INSERT OR REPLACE INTO launcher_tokens (token, machine_name, user_name, created_at, discord_message_id) VALUES (?, ?, ?, ?, ?)',
        [token, machineName, userName, now, messageId],
        function(err) {
            if (err) {
                console.error('Error registering token:', err);
            } else {
                console.log(`✅ Token registered: ${token.substring(0, 8)}... (Machine: ${machineName})`);
            }
        }
    );
}

// Slash commands
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    
    const { commandName } = interaction;
    
    // Check admin permissions
    const hasAdminRole = interaction.member.roles.cache.has(CONFIG.ADMIN_ROLE_ID);
    if (!hasAdminRole && commandName !== 'verify') {
        await interaction.reply({ content: '❌ Permission denied', ephemeral: true });
        return;
    }
    
    if (commandName === 'verify') {
        await handleVerify(interaction);
    } else if (commandName === 'tokens') {
        await handleTokenList(interaction);
    } else if (commandName === 'cleartoken') {
        await handleClearToken(interaction);
    } else if (commandName === 'stats') {
        await handleStats(interaction);
    }
});

// /verify TOKEN - Player validates their launcher
async function handleVerify(interaction) {
    const token = interaction.options.getString('token');
    const playerName = interaction.user.username;
    const playerIp = 'Discord'; // Can't get real IP from Discord
    
    // Validate token format
    if (!/^[a-zA-Z0-9]{32}$/.test(token)) {
        await interaction.reply({ content: '❌ Invalid token format', ephemeral: true });
        return;
    }
    
    // Check if token exists and is not used
    db.get(
        'SELECT * FROM launcher_tokens WHERE token = ? AND used = 0',
        [token],
        async (err, row) => {
            if (err) {
                await interaction.reply({ content: '❌ Database error', ephemeral: true });
                return;
            }
            
            if (!row) {
                await interaction.reply({ 
                    content: '❌ Token not found or already used. Please launch the game again.', 
                    ephemeral: true 
                });
                return;
            }
            
            // Check expiry
            const age = Math.floor(Date.now() / 1000) - row.created_at;
            if (age > CONFIG.TOKEN_EXPIRY_SECONDS) {
                db.run('DELETE FROM launcher_tokens WHERE token = ?', [token]);
                await interaction.reply({ 
                    content: '❌ Token expired. Please launch the game again.', 
                    ephemeral: true 
                });
                return;
            }
            
            // Mark token as used
            db.run(
                'UPDATE launcher_tokens SET used = 1, player_name = ?, player_ip = ? WHERE token = ?',
                [playerName, playerIp, token],
                async (err) => {
                    if (err) {
                        await interaction.reply({ content: '❌ Validation error', ephemeral: true });
                        return;
                    }
                    
                    const embed = new EmbedBuilder()
                        .setColor(0x00FF00)
                        .setTitle('✅ Token Validated')
                        .setDescription(`Token verified successfully!`)
                        .addFields(
                            { name: 'Player', value: playerName, inline: true },
                            { name: 'Machine', value: row.machine_name, inline: true },
                            { name: 'Token Age', value: `${age}s`, inline: true }
                        )
                        .setTimestamp();
                    
                    await interaction.reply({ embeds: [embed], ephemeral: true });
                    
                    // Log to token channel
                    const channel = client.channels.cache.get(CONFIG.TOKEN_CHANNEL_ID);
                    if (channel) {
                        channel.send({ embeds: [embed] });
                    }
                }
            );
        }
    );
}

// /tokens - List active tokens
async function handleTokenList(interaction) {
    db.all(
        'SELECT * FROM launcher_tokens WHERE used = 0 ORDER BY created_at DESC LIMIT 10',
        [],
        async (err, rows) => {
            if (err) {
                await interaction.reply({ content: '❌ Database error', ephemeral: true });
                return;
            }
            
            if (rows.length === 0) {
                await interaction.reply({ content: '📭 No active tokens', ephemeral: true });
                return;
            }
            
            const embed = new EmbedBuilder()
                .setColor(0x0099FF)
                .setTitle('🎫 Active Tokens')
                .setDescription(`Found ${rows.length} active token(s)`)
                .setTimestamp();
            
            rows.forEach((row, i) => {
                const age = Math.floor(Date.now() / 1000) - row.created_at;
                embed.addFields({
                    name: `#${i + 1} - ${row.machine_name}`,
                    value: `Token: \`${row.token.substring(0, 16)}...\`\nAge: ${age}s\nUser: ${row.user_name}`,
                    inline: true
                });
            });
            
            await interaction.reply({ embeds: [embed], ephemeral: true });
        }
    );
}

// /cleartoken TOKEN - Clear a specific token
async function handleClearToken(interaction) {
    const token = interaction.options.getString('token');
    
    db.run('DELETE FROM launcher_tokens WHERE token = ?', [token], function(err) {
        if (err) {
            interaction.reply({ content: '❌ Error clearing token', ephemeral: true });
        } else if (this.changes > 0) {
            interaction.reply({ content: `✅ Token cleared: ${token.substring(0, 16)}...`, ephemeral: true });
        } else {
            interaction.reply({ content: '❌ Token not found', ephemeral: true });
        }
    });
}

// /stats - Show token statistics
async function handleStats(interaction) {
    db.all(
        `SELECT 
            COUNT(*) as total,
            SUM(used) as validated,
            COUNT(CASE WHEN created_at > ? THEN 1 END) as today
         FROM launcher_tokens`,
        [Math.floor(Date.now() / 1000) - 86400],
        async (err, rows) => {
            if (err) {
                await interaction.reply({ content: '❌ Database error', ephemeral: true });
                return;
            }
            
            const stats = rows[0];
            const successRate = stats.total > 0 
                ? ((stats.validated / stats.total) * 100).toFixed(1) 
                : 0;
            
            const embed = new EmbedBuilder()
                .setColor(0xFF9900)
                .setTitle('📊 Token Statistics')
                .addFields(
                    { name: 'Total Tokens', value: stats.total.toString(), inline: true },
                    { name: 'Validated', value: stats.validated.toString(), inline: true },
                    { name: 'Success Rate', value: `${successRate}%`, inline: true },
                    { name: 'Last 24h', value: stats.today.toString(), inline: true }
                )
                .setTimestamp();
            
            await interaction.reply({ embeds: [embed], ephemeral: true });
        }
    );
}

// Register slash commands
async function registerCommands() {
    const commands = [
        {
            name: 'verify',
            description: 'Verify your launcher token',
            options: [{
                name: 'token',
                description: 'Your launcher token (32 characters)',
                type: 3, // STRING
                required: true
            }]
        },
        {
            name: 'tokens',
            description: 'List active tokens (Admin only)'
        },
        {
            name: 'cleartoken',
            description: 'Clear a specific token (Admin only)',
            options: [{
                name: 'token',
                description: 'Token to clear',
                type: 3,
                required: true
            }]
        },
        {
            name: 'stats',
            description: 'Show token statistics (Admin only)'
        }
    ];
    
    try {
        console.log('Registering slash commands...');
        await client.application.commands.set(commands, CONFIG.GUILD_ID);
        console.log('✅ Slash commands registered');
    } catch (error) {
        console.error('Error registering commands:', error);
    }
}

// Start bot
client.login(CONFIG.BOT_TOKEN).then(() => {
    registerCommands();
    
    // Start HTTP API server for SA-MP validation
    startApiServer();
});

// HTTP API Server for SA-MP server validation
function startApiServer() {
    const app = express();
    
    // Validate token endpoint - SA-MP server calls this on player connect
    app.get('/validate/:token', (req, res) => {
        const token = req.params.token.toUpperCase();
        
        // Validate token format
        if (!/^[A-Z0-9]{32}$/.test(token)) {
            return res.status(400).json({ valid: false, error: 'Invalid token format' });
        }
        
        // Check if token exists and is valid
        db.get(
            'SELECT * FROM launcher_tokens WHERE token = ? AND used = 0',
            [token],
            (err, row) => {
                if (err) {
                    return res.status(500).json({ valid: false, error: 'Database error' });
                }
                
                if (!row) {
                    return res.status(401).json({ valid: false, error: 'Token not found or already used' });
                }
                
                // Check expiry
                const age = Math.floor(Date.now() / 1000) - row.created_at;
                if (age > CONFIG.TOKEN_EXPIRY_SECONDS) {
                    db.run('DELETE FROM launcher_tokens WHERE token = ?', [token]);
                    return res.status(401).json({ valid: false, error: 'Token expired' });
                }
                
                // Token is valid
                res.json({
                    valid: true,
                    machine_name: row.machine_name,
                    user_name: row.user_name,
                    age_seconds: age
                });
            }
        );
    });
    
    app.listen(CONFIG.API_PORT, '0.0.0.0', () => {
        console.log(`API on http://0.0.0.0:${CONFIG.API_PORT}`);
    });
}

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n👋 Shutting down...');
    db.close();
    client.destroy();
    process.exit(0);
});

if (typeof File === 'undefined') { global.File = require('buffer').File; }

const express = require('express');
const { Client } = require('discord.js-selfbot-v13');
const { createWorker } = require('tesseract.js');
const { exec } = require('child_process');
const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');

console.log('[Startup] Pokétwo Bot Initializing...');

const TOKEN = process.env.TOKEN;
if (!TOKEN) {
  console.error('[Error] TOKEN not set! The bot cannot connect to Discord without it.');
  console.error('[Fix] Please go to your Railway Project -> Variables tab -> Add New Variable -> name it TOKEN and paste your Discord token as the value.');
}

const POKETWO_ID = '716390085896962058';
const SPAM_CHANNEL_ID = '1477260122337185873';

console.log('[Config] SPAM_CHANNEL_ID:', SPAM_CHANNEL_ID || 'NOT SET');

let discordReady = false;
let worker = null;
let messageCount = 0;

const client = new Client({
  partials: ['MESSAGE', 'CHANNEL', 'GUILD_MEMBER', 'USER', 'GUILD'],
  allowWebAssembly: true,
  retryLimit: 5,
  checkUpdate: false
});

client.on('debug', (info) => {
  console.log('[Discord Debug]', info);
});

console.log('[Init] Discord client created');

async function initOCR() {
  try {
    console.log('[OCR] Initializing...');
    worker = await createWorker('eng');
    await worker.setParameters({ tessedit_pageseg_mode: '7' });
    console.log('[OCR] Ready');
  } catch (e) {
    console.error('[OCR] Failed:', e.message);
  }
}

function downloadToTemp(url) {
  return new Promise((resolve, reject) => {
    const tmpPath = `${os.tmpdir()}/pk_${Date.now()}_in.png`;
    const file = fs.createWriteStream(tmpPath);
    const proto = url.startsWith('https') ? https : http;
    proto.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode !== 200) {
        file.close();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(tmpPath); });
    }).on('error', err => { file.close(); fs.unlink(tmpPath, () => {}); reject(err); });
  });
}

function preprocessImage(inputPath) {
  return new Promise((resolve, reject) => {
    const outPath = inputPath.replace('_in.png', '_out.png');
    // Crop left 60% (removes the Pokémon sprite on the right), scale up, greyscale
    const args = `"${inputPath}" -crop 60%x100%+0+0 +repage -resize 800x300 -colorspace Gray "${outPath}"`;
    // Try 'magick' (ImageMagick v7) first, fall back to 'convert' (v6)
    exec(`magick ${args}`, err => {
      if (!err) return resolve(outPath);
      exec(`convert ${args}`, err2 => {
        if (err2) return reject(new Error(`ImageMagick not available: ${err.message}`));
        resolve(outPath);
      });
    });
  });
}

async function ocrImageUrl(url) {
  let inPath = null;
  let outPath = null;
  try {
    console.log('[OCR] Downloading image...');
    inPath = await downloadToTemp(url);
    outPath = await preprocessImage(inPath);
    if (!worker) return null;
    const result = await worker.recognize(outPath);
    const raw = result.data.text.trim();
    console.log('[OCR Raw]', JSON.stringify(raw));
    return raw;
  } catch (e) {
    console.error('[OCR Pipeline Error]', e.message);
    return null;
  } finally {
    if (inPath) fs.unlink(inPath, () => {});
    if (outPath) fs.unlink(outPath, () => {});
  }
}

function extractPokemonName(rawText) {
  if (!rawText || rawText.trim().length === 0) return null;

  console.log('[OCR Raw]', JSON.stringify(rawText.substring(0, 300)));

  // Normalise line endings, drop non-printable chars but keep letters/hyphens/spaces/newlines
  const clean = rawText
    .replace(/\r\n/g, '\n')
    .replace(/[\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\uFF00-\uFFEF\u4E00-\u9FAF\u3400-\u4DBF]/g, '')
    .replace(/[^\x20-\x7E\n]/g, ' ')
    .trim();

  const lines = clean.split('\n').map(l => l.trim()).filter(l => l.length >= 2);
  if (!lines.length) return null;

  console.log('[OCR Lines]', lines);

  for (const line of lines) {
    // Keep only letters, hyphens, spaces (valid in Pokémon names)
    const stripped = line.replace(/[^a-zA-Z\- ]/g, '').trim();
    if (!stripped || stripped.length < 3) continue;

    // Count uppercase vs lowercase letters
    const letters = stripped.replace(/[^a-zA-Z]/g, '');
    if (letters.length === 0) continue;
    const upperCount = letters.replace(/[^A-Z]/g, '').length;
    const upperRatio = upperCount / letters.length;

    // Poké-Name sends English names in ALL CAPS, alt-language names in lowercase.
    // Only accept lines that are mostly uppercase (≥60% uppercase letters).
    if (upperRatio < 0.6) {
      console.log('[OCR] Skipping lowercase/alt-language line:', stripped);
      continue;
    }

    // Convert to lowercase for the catch command
    // (Pokétwo accepts lowercase: "c hakamo-o", "c three-segment dudunsparce")
    const result = stripped.toLowerCase().replace(/\s+/g, ' ').trim();

    if (result.length >= 3 && result.length <= 50) {
      console.log('[OCR] Extracted name:', result);
      return result;
    }
  }

  return null;
}

let spamInterval = null;

function startSpammer() {
  if (!SPAM_CHANNEL_ID) {
    console.log('[Spammer] Disabled - SPAM_CHANNEL_ID not set');
    return;
  }
  
  console.log('[Spammer] Starting on channel:', SPAM_CHANNEL_ID);
  spamInterval = setInterval(async () => {
    try {
      let ch = client.channels.cache.get(SPAM_CHANNEL_ID);
      if (!ch) {
        ch = await client.channels.fetch(SPAM_CHANNEL_ID).catch(() => null);
      }
      
      if (ch) {
        const msg = Math.random().toString(36).substring(2, 8) + ' made by quaxly';
        await ch.send(msg);
        console.log('[Spammer] Sent message');
      } else {
        console.log('[Spammer] Channel not found!');
      }
    } catch (e) {
      console.error('[Spammer Error]', e.message);
    }
  }, 3000);
}

client.once('ready', () => {
  discordReady = true;
  console.log('\n[SUCCESS] BOT LOGGED IN AS:', client.user.tag);
  console.log('[Info] Bot ID:', client.user.id);
  console.log('[Info] Guilds:', client.guilds.cache.size);
  console.log('[Info] Channels:', client.channels.cache.size);
  console.log('[Info] Ready to receive messages\n');
  
  startSpammer();
  initOCR();
});

client.on('error', (e) => {
  console.error('[Discord Error]', e.message);
});

client.on('warn', (w) => {
  console.warn('[Discord Warn]', w);
});

client.on('disconnect', () => {
  console.warn('[Disconnect] Bot disconnected');
  discordReady = false;
});

client.on('messageCreate', async (msg) => {
  try {
    messageCount++;
    
    if (msg.author.id === client.user.id) {
      console.log('[Message] Own message - ignoring');
      return;
    }
    
    const isPoketwo = msg.author.id === POKETWO_ID;
    const isAssistant = msg.author.username.includes('Poké-Name') || msg.author.username.includes('P2 Assistant') || msg.author.username.toLowerCase().includes('assistant');
    
    let textContent = msg.content || '';
    let imageUrl = null;
    
    if (msg.embeds && msg.embeds.length > 0) {
      const emb = msg.embeds[0];
      textContent += ' ' + (emb.title || '') + ' ' + (emb.description || '');
      imageUrl = emb.image?.url || emb.thumbnail?.url;
    }
    
    if (msg.attachments && msg.attachments.size > 0) {
      imageUrl = imageUrl || msg.attachments.first().url;
    }
    
    console.log(`[Message #${messageCount}] From ${msg.author.username}: ${textContent.substring(0, 50).replace(/\n/g, ' ')}`);
    
    // We removed the auto-hint logic as it causes issues with user limits
    // Relying strictly on assistant bots and Poketwo OCR
    
    // 1. Assistant Hint lists (if an assistant bot posts hints in text)
    if (textContent.includes('Possible pokemons:') || textContent.includes('Possible Pokémon:')) {
      console.log('[Hints] Found hint list');
      let poke = null;
      const m = textContent.match(/(?:\d+\)\s+|Pokémon:\s+|pokemons:\s+)([a-zA-Z0-9\- ]+)/i);
      if (m) {
        poke = extractPokemonName(m[1]);
      } else {
        const hints = textContent.split(/Possible Pok[eé]mons?:/i)[1];
        if (hints) {
          const match = hints.match(/([A-Z][a-z]+)/);
          if (match) {
            poke = extractPokemonName(match[1]);
          }
        }
      }
      
      if (poke) {
        console.log('[CATCH] Hint match:', poke);
        setTimeout(() => {
          msg.channel.send(`<@${POKETWO_ID}> c ${poke.toLowerCase()}`).catch(e => console.error('[Send Error]', e.message));
        }, 500);
      }
    }
    
    // 2. OCR / Direct name (The core logic to read from Assistant/Naming bots)
    if (isPoketwo || isAssistant) {
      let poke = null;
      
      if (textContent.includes('Name of the Pokemon') || textContent.includes('Found')) {
        console.log('[Poké-Name] Trying text extraction');
        const m = textContent.match(/(?:\d+\)\s+|Pokémon:\s+|pokemons:\s+)([a-zA-Z0-9\- ]+)/i);
        if (m) {
          poke = extractPokemonName(m[1]);
          console.log('[Poké-Name] Text extraction result:', poke);
        }
      }
      
      // Look for the Pokemon name in the image from the Assistant Bot
      if (!poke && imageUrl) {
        console.log('[Image] Running OCR pipeline on:', imageUrl.substring(0, 60));
        if (worker) {
          const rawText = await ocrImageUrl(imageUrl);
          poke = extractPokemonName(rawText);
          console.log('[OCR] Final result:', poke || 'none');
        } else {
          console.log('[OCR] Worker not ready yet');
        }
      }
      
      if (poke) {
        console.log('[CATCH] Sending catch for:', poke);
        setTimeout(() => {
          msg.channel.send(`<@${POKETWO_ID}> c ${poke.toLowerCase()}`).catch(e => console.error('[Send Error]', e.message));
        }, 500);
      }
    }
    
    // 3. Captcha detection
    if (isPoketwo) {
      if (textContent.includes('verify') || textContent.includes('captcha') || textContent.includes('human')) {
        console.log('[Captcha] Detected - sending recovery');
        msg.channel.send(`<@${POKETWO_ID}> inc p`).catch(() => {});
        msg.channel.send(`<@${POKETWO_ID}> inc p all -y`).catch(() => {});
      }
    }
  } catch (e) {
    console.error('[Message Error]', e.message, e.stack);
  }
});

process.on('unhandledRejection', (e) => console.error('[Rejection]', e));
process.on('uncaughtException', (e) => console.error('[Exception]', e));

const app = express();

app.get('/', (req, res) => {
  const uptimeSecs = Math.floor(process.uptime());
  const hours = Math.floor(uptimeSecs / 3600);
  const mins = Math.floor((uptimeSecs % 3600) / 60);
  const secs = uptimeSecs % 60;
  res.send(`<!DOCTYPE html><html><head><title>Pokétwo Bot Status</title>
  <style>body{font-family:monospace;background:#1a1a2e;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}
  .card{background:#16213e;border-radius:12px;padding:40px 60px;text-align:center;box-shadow:0 0 30px #0f3460;}
  h1{color:#e94560;margin:0 0 10px;}
  .status{font-size:2em;margin:20px 0;}
  .ok{color:#00ff88;}
  .dim{color:#888;font-size:0.85em;}
  table{margin:20px auto;border-collapse:collapse;}
  td{padding:6px 20px;border-bottom:1px solid #0f3460;}
  td:first-child{color:#888;}
  td:last-child{color:#00ff88;}
  </style></head><body>
  <div class="card">
    <h1>🎮 Pokétwo Self-Bot</h1>
    <div class="status">${discordReady ? '<span class="ok">● ONLINE</span>' : '<span style="color:#ffaa00">● CONNECTING</span>'}</div>
    <table>
      <tr><td>Service</td><td>${IS_WEB_ONLY ? 'Web (Status Page)' : 'Worker (Bot Active)'}</td></tr>
      <tr><td>Uptime</td><td>${hours}h ${mins}m ${secs}s</td></tr>
      <tr><td>Messages Seen</td><td>${messageCount}</td></tr>
      <tr><td>Spam Channel</td><td>${SPAM_CHANNEL_ID}</td></tr>
    </table>
    <div class="dim">Worker is handling catching & spamming</div>
  </div></body></html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('[Server] Running on port', PORT));

const SERVICE_NAME = (process.env.RAILWAY_SERVICE_NAME || '').toLowerCase();
const IS_WEB_ONLY = SERVICE_NAME === 'web' || SERVICE_NAME.includes('web');

if (IS_WEB_ONLY) {
  console.log('[Mode] Running as WEB service (status page only). Discord bot runs on the worker service.');
} else if (TOKEN) {
  console.log('[Login] Connecting to Discord as worker...');
  client.login(TOKEN).catch((e) => {
    console.error('[Login Failed]', e.message);
  });
} else {
  console.log('[Login Skipped] No token provided.');
}

setTimeout(() => {
  if (!discordReady) {
    console.log('[Waiting] Still connecting...');
  }
}, 10000);

const express = require('express');
const { Client } = require('discord.js-selfbot-v13');
const { createWorker } = require('tesseract.js');

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
    console.log('[OCR] Ready');
  } catch (e) {
    console.error('[OCR] Failed:', e.message);
  }
}

function extractPokemonName(text) {
  if (!text || text.length === 0) return null;
  
  const clean = text.replace(/[\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\uFF00-\uFFEF\u4E00-\u9FAF\u3400-\u4DBF]|\uD83C[\uDDE6-\uDDFF]\uD83C[\uDDE6-\uDDFF]/g, '').trim();
  const lines = clean.split('\n').filter(l => l.trim().length > 2);
  
  if (!lines.length) return null;
  
  let name = lines[0].split(/\s{2,}/)[0].split('(')[0].split(',')[0].trim();
  const match = name.match(/^([A-Z][a-z]+(?:\s[A-Z][a-z]+)?(?:\-[A-Z][a-z]+)?)/);
  
  if (!match) return null;
  
  name = match[1].trim();
  if (name.length > 20) name = name.split(/\s+/).slice(0, 2).join(' ');
  
  name = name.replace(/cuscHoo/i, 'Cubchoo').replace(/[^a-zA-Z\s\-]/g, '').trim();
  return (name.length > 3 && name.length <= 20) ? name : null;
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
        console.log('[Image] No text match, trying OCR on:', imageUrl.substring(0, 50));
        try {
          if (worker) {
            const res = await worker.recognize(imageUrl);
            poke = extractPokemonName(res.data.text);
            console.log('[OCR] Extracted:', poke || 'none');
          } else {
            console.log('[OCR] Worker not ready yet');
          }
        } catch (e) {
          console.error('[OCR Error]', e.message);
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
  res.json({ 
    status: discordReady ? 'ready' : 'connecting', 
    uptime: process.uptime(),
    messages_received: messageCount
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('[Server] Running on port', PORT));

console.log('[Login] Connecting to Discord...');

if (TOKEN) {
  client.login(TOKEN).catch((e) => {
    console.error('[Login Failed]', e.message);
    setTimeout(() => process.exit(1), 1000);
  });
} else {
  console.log('[Login Skipped] No token provided, running web server only.');
}

setTimeout(() => {
  if (!discordReady) {
    console.log('[Waiting] Still connecting...');
  }
}, 10000);

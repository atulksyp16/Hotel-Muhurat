'use strict';

// ===================== SETTINGS (edit here) =====================
const SETTINGS = {
  BUSINESS_NAME: 'HOTEL MUHURAT',
  BUSINESS_TYPE: 'Hotel',
  CITY: 'Janjgir',
  CALL_PHONE: '9302592834',
  OPENING_HOURS: '09:00 AM to 11:00 PM',
  BOT_NUMBER: '92XXXXXXXXXX',        // PLACEHOLDER: bot WhatsApp number, digits only, country code first
  OWNER_NUMBER: '',                  // optional, e.g. '92XXXXXXXXXX' (digits only). Empty = no alerts
  CURRENCY: '₹',
  PAYMENT_INFO: 'Payment: please pay when you visit our hotel 🏨',
  ID_PREFIX: 'HM',
  SERVICES: [                        // PLACEHOLDERS: replace names and prices
    { name: 'Standard Room (per night)', price: '₹800' },
    { name: 'Deluxe Room (per night)', price: '₹1300' },
    { name: 'Family Suite (per night)', price: '₹2500' },
    { name: 'Banquet Hall (per event)', price: '₹10,000' },
    { name: 'Restaurant Table Booking', price: 'Free' },
  ],
};
// ================================================================

const fs = require('fs');
const baileys = require('@whiskeysockets/baileys');
const makeWASocket = baileys.default || baileys.makeWASocket;
const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
} = baileys;
const pino = require('pino');
const qrcode = require('qrcode-terminal');

const SESSION_DIR = 'session_bot';
const IDLE_MS = 30 * 60 * 1000;
const logger = pino({ level: 'silent' });

const sessions = new Map(); // jid -> { step, service, when, name, last }
const seen = new Set();     // processed message ids
let starting = false;

process.on('unhandledRejection', (e) => console.log('[warn] unhandledRejection:', e && e.message ? e.message : e));
process.on('uncaughtException', (e) => console.log('[warn] uncaughtException:', e && e.message ? e.message : e));

// ---------------------- Texts ----------------------
function welcomeText() {
  return (
    `👋 Welcome to *${SETTINGS.BUSINESS_NAME}*, ${SETTINGS.CITY}! 🏨\n` +
    `📞 Call us: ${SETTINGS.CALL_PHONE}\n` +
    `🕘 Open: ${SETTINGS.OPENING_HOURS}\n\n` +
    `Reply *1* or *SERVICES* to see the services 📋`
  );
}

function menuText() {
  const lines = SETTINGS.SERVICES.map((s, i) => `${i + 1}. ${s.name} - ${s.price}`);
  return (
    `📋 *${SETTINGS.BUSINESS_NAME} - Menu*\n\n` +
    lines.join('\n') +
    `\n\nReply with the *number* of the service you want to book 👇\n(Send *0* to cancel)`
  );
}

function cancelText() {
  return `❌ Cancelled. No problem!\nSend *Hi* anytime to start again 😊`;
}

function newBookingId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return `${SETTINGS.ID_PREFIX}-${id}`;
}

// ---------------------- Conversation logic ----------------------
function handleStep(jid, text) {
  const t = text.trim().toLowerCase();
  const raw = text.trim();
  const now = Date.now();

  let st = sessions.get(jid);
  if (st && now - st.last > IDLE_MS) {
    sessions.delete(jid);
    st = null;
  }

  // First message (or expired chat): welcome
  if (!st) {
    sessions.set(jid, { step: 'welcome', last: now });
    return { replies: [welcomeText()] };
  }
  st.last = now;

  // Cancel at any step
  if (t === '0' || t === 'cancel') {
    sessions.delete(jid);
    return { replies: [cancelText()] };
  }

  const total = SETTINGS.SERVICES.length;

  switch (st.step) {
    case 'welcome': {
      if (t === '1' || t === 'menu') {
        st.step = 'service';
        return { replies: [menuText()] };
      }
      return { replies: [`🙂 Please reply *1* or *MENU* to see the menu, or *0* to cancel.`] };
    }

    case 'service': {
      if (t === 'menu') return { replies: [menuText()] };
      if (/^\d+$/.test(t)) {
        const n = parseInt(t, 10);
        if (n >= 1 && n <= total) {
          st.service = SETTINGS.SERVICES[n - 1];
          st.step = 'datetime';
          return {
            replies: [
              `✅ You picked: *${st.service.name}* (${st.service.price})\n\n` +
                `📅 Please send your *date and time*\nExample: _25 Dec, 2:00 PM_\n(Send *0* to cancel)`,
            ],
          };
        }
      }
      return { replies: [`🤔 Please reply with a number from *1* to *${total}*, or *MENU* to see the list, or *0* to cancel.`] };
    }

    case 'datetime': {
      if (raw.length >= 3 && t !== 'menu') {
        st.when = raw.slice(0, 100);
        st.step = 'name';
        return { replies: [`👍 Noted: *${st.when}*\n\n👤 Now please send your *full name*.\n(Send *0* to cancel)`] };
      }
      return { replies: [`📅 Please send a date and time, like: _25 Dec, 2:00 PM_\nOr send *0* to cancel.`] };
    }

    case 'name': {
      if (raw.length >= 2 && !/^\d+$/.test(raw)) {
        st.name = raw.slice(0, 60);
        const id = newBookingId();
        const phone = jid.split('@')[0];
        const customerMsg =
          `🎉 *Booking confirmed!*\n\n` +
          `🆔 Booking ID: *${id}*\n` +
          `🛏️ Service: ${st.service.name} (${st.service.price})\n` +
          `📅 Date & time: ${st.when}\n` +
          `👤 Name: ${st.name}\n\n` +
          `💳 ${SETTINGS.PAYMENT_INFO}\n` +
          `📞 Questions? Call ${SETTINGS.CALL_PHONE}\n` +
          `🕘 Open: ${SETTINGS.OPENING_HOURS}\n\n` +
          `Thank you for choosing *${SETTINGS.BUSINESS_NAME}* 🙏`;
        const ownerMsg =
          `🔔 *New booking* - ${SETTINGS.BUSINESS_NAME}\n` +
          `ID: ${id}\nService: ${st.service.name} (${st.service.price})\n` +
          `When: ${st.when}\nName: ${st.name}\nCustomer chat: ${phone}`;
        sessions.delete(jid);
        console.log(`[booking] ${id} ${st.name} ${st.service.name} ${st.when}`);
        return { replies: [customerMsg], owner: ownerMsg };
      }
      return { replies: [`👤 Please send your *full name* (letters, at least 2 characters), or *0* to cancel.`] };
    }

    default: {
      sessions.delete(jid);
      sessions.set(jid, { step: 'welcome', last: now });
      return { replies: [welcomeText()] };
    }
  }
}

// ---------------------- Helpers ----------------------
function unwrap(message) {
  let m = message;
  for (let i = 0; i < 5 && m; i++) {
    const inner =
      (m.ephemeralMessage && m.ephemeralMessage.message) ||
      (m.viewOnceMessage && m.viewOnceMessage.message) ||
      (m.viewOnceMessageV2 && m.viewOnceMessageV2.message) ||
      (m.documentWithCaptionMessage && m.documentWithCaptionMessage.message);
    if (!inner) break;
    m = inner;
  }
  return m;
}

function isRealMessage(content) {
  const keys = Object.keys(content).filter(
    (k) => k !== 'messageContextInfo' && k !== 'senderKeyDistributionMessage'
  );
  if (!keys.length) return false;
  const ignored = ['protocolMessage', 'reactionMessage', 'editedMessage', 'pollUpdateMessage'];
  return !ignored.includes(keys[0]);
}

function getText(content) {
  return (
    content.conversation ||
    (content.extendedTextMessage && content.extendedTextMessage.text) ||
    (content.imageMessage && content.imageMessage.caption) ||
    (content.videoMessage && content.videoMessage.caption) ||
    (content.documentMessage && content.documentMessage.caption) ||
    ''
  );
}

async function send(sock, jid, text) {
  try {
    await sock.sendMessage(jid, { text });
    console.log(`[sent] -> ${jid}`);
    return true;
  } catch (e) {
    console.log(`[send error] ${jid}: ${e && e.message ? e.message : e}`);
    return false;
  }
}

async function handleMessage(sock, msg) {
  const key = msg.key;
  if (!key || key.fromMe || !msg.message) return;

  const rawJid = key.remoteJid || '';
  if (!rawJid) return;
  if (
    rawJid === 'status@broadcast' ||
    rawJid.endsWith('@g.us') ||
    rawJid.endsWith('@newsletter') ||
    rawJid.endsWith('@broadcast')
  ) return;
  if (!(rawJid.endsWith('@s.whatsapp.net') || rawJid.endsWith('@lid'))) return;

  if (key.id) {
    if (seen.has(key.id)) return;
    seen.add(key.id);
    if (seen.size > 5000) seen.clear();
  }

  const content = unwrap(msg.message);
  if (!content || !isRealMessage(content)) return;

  const jid = rawJid.endsWith('@lid') && key.remoteJidAlt ? key.remoteJidAlt : rawJid;
  const text = getText(content) || '';

  let out;
  try {
    out = handleStep(jid, text);
  } catch (e) {
    console.log('[logic error]', e && e.message ? e.message : e);
    out = { replies: [welcomeText()] };
    sessions.set(jid, { step: 'welcome', last: Date.now() });
  }

  for (const r of out.replies) await send(sock, jid, r);

  if (out.owner) {
    const ownerDigits = String(SETTINGS.OWNER_NUMBER || '').replace(/\D/g, '');
    if (ownerDigits.length >= 10) {
      await send(sock, `${ownerDigits}@s.whatsapp.net`, out.owner);
    }
  }
}

// ---------------------- Connection ----------------------
async function startBot() {
  if (starting) return;
  starting = true;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
    });

    let pairingRequested = false;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && !sock.authState.creds.registered && !pairingRequested) {
        pairingRequested = true;
        console.log('QR LINK: https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=' + encodeURIComponent(qr));
        try { qrcode.generate(qr, { small: true }); } catch (e) { /* ignore */ }

        const number = String(SETTINGS.BOT_NUMBER).replace(/\D/g, '');
        if (!/^\d{10,15}$/.test(number)) {
          console.log('[error] BOT_NUMBER is not valid. Edit SETTINGS.BOT_NUMBER (digits only, like 92XXXXXXXXXX).');
          return;
        }
        setTimeout(async () => {
          try {
            const code = await sock.requestPairingCode(number);
            const pretty = String(code).match(/.{1,4}/g).join('-');
            console.log('PAIRING CODE: ' + pretty);
          } catch (e) {
            console.log('[pairing error]', e && e.message ? e.message : e);
            pairingRequested = false;
          }
        }, 1000);
      }

      if (connection === 'open') {
        console.log(`✅ ${SETTINGS.BUSINESS_NAME} bot is LIVE and ready for messages.`);
      }

      if (connection === 'close') {
        const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
          ? lastDisconnect.error.output.statusCode
          : undefined;
        if (code === DisconnectReason.loggedOut) {
          console.log('[info] Logged out. Deleting session and starting fresh pairing...');
          try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
          setTimeout(startBot, 2000);
        } else {
          console.log(`[info] Connection closed (code ${code}). Reconnecting in 4 seconds...`);
          setTimeout(startBot, 4000);
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        try {
          await handleMessage(sock, msg);
        } catch (e) {
          console.log('[handler error]', e && e.message ? e.message : e);
        }
      }
    });
  } catch (e) {
    console.log('[start error]', e && e.message ? e.message : e);
    setTimeout(startBot, 4000);
  } finally {
    starting = false;
  }
}

// Clean up idle chats every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [jid, st] of sessions) if (now - st.last > IDLE_MS) sessions.delete(jid);
}, 10 * 60 * 1000);

startBot();

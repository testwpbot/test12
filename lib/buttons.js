const { sendButtons: giftedSendButtons, sendInteractiveMessage: giftedSendInteractive } = require('gifted-btns');

/**
 * Send interactive buttons using gifted-btns
 * @param {Object} sock Baileys socket connection instance
 * @param {String} jid Target WhatsApp JID
 * @param {Object} data Button configuration object
 * @param {String} [data.title] Optional header title
 * @param {String} [data.text] Main message body
 * @param {String} [data.footer] Optional footer text
 * @param {Object|String} [data.image] Optional header image (URL, { url }, or Buffer)
 * @param {Boolean} [data.aimode] Optional AI mode
 * @param {Array} [data.buttons] Array of button objects [{ id, text }, or native flow objects]
 * @param {Object} [options] Baileys options (e.g., { quoted: mek })
 */
async function sendButtons(sock, jid, data = {}, options = {}) {
  try {
    const payload = {
      title: data.title || '',
      text: data.text || data.caption || '',
      footer: data.footer || '',
      aimode: data.aimode || false,
      buttons: data.buttons || []
    };

    if (data.image) {
      if (typeof data.image === 'string') {
        payload.image = { url: data.image };
      } else {
        payload.image = data.image;
      }
    }

    return await giftedSendButtons(sock, jid, payload, options);
  } catch (error) {
    console.error('❌ Error sending buttons via gifted-btns:', error);
    throw error;
  }
}

/**
 * Send interactive message (quick replies, single select dropdowns, CTA buttons)
 * @param {Object} sock Baileys socket connection instance
 * @param {String} jid Target WhatsApp JID
 * @param {Object} content Interactive content payload
 * @param {Object} [options] Baileys relay options
 */
async function sendInteractive(sock, jid, content = {}, options = {}) {
  try {
    if (content.image && typeof content.image === 'string') {
      content.image = { url: content.image };
    }
    return await giftedSendInteractive(sock, jid, content, options);
  } catch (error) {
    console.error('❌ Error sending interactive message via gifted-btns:', error);
    throw error;
  }
}

/**
 * LEGACY single-select list (listMessage proto). Renders on every WhatsApp
 * version — and when a student taps a row, their client posts a
 * listResponseMessage, the OLD response type that displays as a plain text
 * bubble for other members (native-flow interactiveResponseMessage bubbles
 * show "not supported" on older clients). Payload limits:
 * title ≤ 60, description ≤ 1024, buttonText ≤ 20, section title ≤ 24,
 * row title ≤ 72, row description ≤ 72.
 */
async function sendLegacyList(sock, jid, data = {}, options = {}) {
  const clamp = (s, n) => String(s || '').slice(0, n);
  const sections = (data.sections || []).map((s) => ({
    title: clamp(s.title, 24),
    rows: (s.rows || []).map((r) => ({
      rowId: r.id || r.rowId || '',
      title: clamp(r.title || r.text, 72),
      description: clamp(r.description, 72)
    }))
  }));
  const content = {
    listMessage: {
      title: clamp(data.title, 60),
      description: clamp(data.text, 1024),
      buttonText: clamp(data.listTitle || data.buttonText || 'Select', 20),
      footerText: clamp(data.footer, 60),
      listType: 1, // SINGLE_SELECT
      sections
    }
  };
  const Baileys = require('@whiskeysockets/baileys');
  const opts = { ...(options || {}) };
  const msg = Baileys.generateWAMessageFromContent(jid, content, {
    userJid: sock.user && sock.user.id,
    quoted: opts.quoted,
    ephemeralExpiration: opts.ephemeralExpiration
  });
  // one immediate retry — transient relay failures must not kill the reply
  try {
    await sock.relayMessage(jid, msg.message, { messageId: msg.key.id });
  } catch (e) {
    console.warn('⚠️ buttons: list relay failed, retrying:', e.message || e);
    await new Promise((r) => setTimeout(r, 500));
    await sock.relayMessage(jid, msg.message, { messageId: msg.key.id });
  }
  return msg;
}

/**
 * Native-flow interactive card (the previous format). Kept as the middle
 * fallback for list delivery. Some WhatsApp builds show these as
 * "unsupported" to OTHER members, so it is only used when the legacy list
 * could not be delivered.
 */
async function sendNativeSelect(sock, jid, data = {}, options = {}) {
  return await sendInteractive(sock, jid, {
    title: data.title || '',
    text: data.text || '',
    footer: data.footer || '',
    image: data.image ? (typeof data.image === 'string' ? { url: data.image } : data.image) : undefined,
    interactiveButtons: [
      {
        name: 'single_select',
        buttonParamsJson: JSON.stringify({
          title: data.listTitle || 'Select Option',
          sections: data.sections || []
        })
      }
    ]
  }, options);
}

/**
 * High-level button menu sender helper for plugins
 * @param {Object} sock Baileys socket connection instance
 * @param {String} jid Target WhatsApp JID
 * @param {Object} config Menu configuration object
 * @param {Object} [options] Baileys options
 */
async function sendButtonMenu(sock, jid, config = {}, options = {}) {
  const { title, text, footer, image, buttons, listTitle, sections } = config;

  // Dropdowns go through the LEGACY list format so tap bubbles render as
  // plain text on every client (see sendLegacyList). If that cannot be
  // delivered we fall back to the native-flow card, then let the caller's
  // text fallback handle it — a student always gets SOMETHING.
  if (sections && Array.isArray(sections)) {
    try {
      return await sendLegacyList(sock, jid, { title, text, footer, listTitle, sections }, options);
    } catch (e) {
      console.warn('⚠️ buttons: legacy list failed, trying native card:', e.message || e);
    }
    try {
      return await sendNativeSelect(sock, jid, {
        title, text, footer, image, listTitle, sections
      }, options);
    } catch (e) {
      console.warn('⚠️ buttons: native card failed too:', e.message || e);
      throw e;
    }
  }

  // Otherwise send quick reply buttons
  return await sendButtons(sock, jid, {
    title,
    text,
    footer,
    image,
    buttons
  }, options);
}

module.exports = {
  sendButtons,
  sendInteractive,
  sendButtonMenu,
  sendLegacyList,
  sendNativeSelect
};

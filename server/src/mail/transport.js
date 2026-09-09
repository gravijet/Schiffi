/**
 * Mail transport.
 *
 * With SMTP configured, mail is delivered over a real SMTP session (STARTTLS
 * or implicit TLS, AUTH PLAIN/LOGIN).  Without it, messages are written to
 * data/mail/*.eml as real RFC 5322 documents.  Nothing is ever "pretend
 * sent": either it goes over the wire, or it lands on disk where you can open
 * it - and the return value says which happened.
 */
import { createConnection } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import config from '../config.js';

/** Encode a header value that may contain non-ASCII (RFC 2047). */
function encodeHeader(value) {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Split base64 into 76-character lines as required for MIME bodies. */
function base64Body(text) {
  return Buffer.from(text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
}

export function buildMessage({ from, to, subject, text, html, locale }) {
  const boundary = `----schiffi-${randomBytes(12).toString('hex')}`;
  const messageId = `<${randomBytes(16).toString('hex')}@schiffi>`;
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    `Message-ID: ${messageId}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    locale ? `Content-Language: ${locale}` : null,
    'Auto-Submitted: auto-generated',
  ].filter(Boolean);

  let body;
  if (html) {
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body = [
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      base64Body(text),
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      base64Body(html),
      `--${boundary}--`,
      '',
    ].join('\r\n');
  } else {
    headers.push('Content-Type: text/plain; charset=UTF-8');
    headers.push('Content-Transfer-Encoding: base64');
    body = `${base64Body(text)}\r\n`;
  }

  return { messageId, raw: `${headers.join('\r\n')}\r\n\r\n${body}` };
}

/** Minimal SMTP client: EHLO, optional STARTTLS, optional AUTH, MAIL/RCPT/DATA. */
async function smtpSend({ host, port, secure, user, pass, from, to, raw }) {
  let socket = secure
    ? tlsConnect({ host, port, servername: host })
    : createConnection({ host, port });

  let buffer = '';
  const pending = [];
  const attach = (s) => {
    s.setEncoding('utf8');
    s.on('data', (chunk) => {
      buffer += chunk;
      let index;
      // A reply ends with "NNN " (space, not hyphen) on its last line.
      while ((index = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (/^\d{3} /.test(line) && pending.length) pending.shift()(line);
      }
    });
  };
  attach(socket);

  const expect = (codes) => new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('SMTP timeout')), 20_000);
    pending.push((line) => {
      clearTimeout(timer);
      const code = Number(line.slice(0, 3));
      if (codes.includes(code)) res(line);
      else rej(new Error(`SMTP error: ${line}`));
    });
  });
  const send = (line) => new Promise((res) => socket.write(`${line}\r\n`, res));

  const fromAddress = extractAddress(from);
  try {
    await expect([220]);
    await send(`EHLO ${hostName()}`);
    const greeting = await expect([250]);

    if (!secure && /STARTTLS/i.test(greeting) === false && port === 587) {
      // Some servers only advertise STARTTLS after EHLO; if it is truly absent
      // we refuse rather than leaking credentials in the clear.
      if (user) throw new Error('SMTP server does not offer STARTTLS; refusing to send credentials in plaintext');
    }
    if (!secure) {
      await send('STARTTLS');
      await expect([220]);
      const upgraded = tlsConnect({ socket, servername: host });
      await new Promise((res, rej) => { upgraded.once('secureConnect', res); upgraded.once('error', rej); });
      socket = upgraded;
      buffer = '';
      attach(socket);
      await send(`EHLO ${hostName()}`);
      await expect([250]);
    }

    if (user) {
      await send('AUTH LOGIN');
      await expect([334]);
      await send(Buffer.from(user, 'utf8').toString('base64'));
      await expect([334]);
      await send(Buffer.from(pass, 'utf8').toString('base64'));
      await expect([235]);
    }

    await send(`MAIL FROM:<${fromAddress}>`);
    await expect([250]);
    await send(`RCPT TO:<${extractAddress(to)}>`);
    await expect([250, 251]);
    await send('DATA');
    await expect([354]);
    // Dot-stuffing: a lone "." would end the message early.
    await send(`${raw.replace(/\r\n\./g, '\r\n..')}\r\n.`);
    await expect([250]);
    await send('QUIT');
  } finally {
    socket.end();
  }
}

function extractAddress(value) {
  const match = /<([^>]+)>/.exec(value);
  return (match ? match[1] : value).trim();
}

function hostName() {
  try { return new URL(config.publicUrl).hostname || 'localhost'; } catch { return 'localhost'; }
}

/**
 * Send a message.
 * @returns {Promise<{delivered: 'smtp'|'spool', messageId: string, path?: string}>}
 */
export async function sendMail({ to, subject, text, html, locale }) {
  const from = config.mail.from;
  const { raw, messageId } = buildMessage({ from, to, subject, text, html, locale });

  if (config.mail.host) {
    await smtpSend({
      host: config.mail.host, port: config.mail.port, secure: config.mail.secure,
      user: config.mail.user, pass: config.mail.pass, from, to, raw,
    });
    return { delivered: 'smtp', messageId };
  }

  await mkdir(config.mail.spoolDir, { recursive: true });
  const safe = to.replace(/[^a-zA-Z0-9._@-]/g, '_');
  const path = resolve(config.mail.spoolDir, `${Date.now()}-${safe}.eml`);
  await writeFile(path, raw, 'utf8');
  console.log(`[mail] SMTP not configured - spooled to ${path}`);
  return { delivered: 'spool', messageId, path };
}

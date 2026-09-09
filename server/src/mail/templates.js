/**
 * Localised transactional e-mail.
 *
 * The subject and body live in the same nine language variants as the UI, so
 * a player who set Tirolerisch also gets their password reset in Tirolerisch.
 * Templates are plain functions rather than locale keys because the bodies are
 * multi-paragraph and read better written out.
 */
import { Translator } from '@schiffi/shared/i18n/index.js';
import { catalogues } from '@schiffi/shared/i18n/locales/index.js';
import config from '../config.js';

/** Additional e-mail-only strings, in the six source languages. */
const MAIL_STRINGS = {
  de: {
    greeting: 'Ahoi {name},',
    verifySubject: 'Bestätige deine E-Mail-Adresse für Schiffi',
    verifyBody: 'schön, dass du an Bord kommst. Bestätige deine E-Mail-Adresse mit diesem Link:',
    resetSubject: 'Passwort zurücksetzen bei Schiffi',
    resetBody: 'für dein Konto wurde ein Passwortreset angefordert. Dieser Link ist {hours} Stunden gültig:',
    resetIgnore: 'Wenn du das nicht warst, kannst du diese E-Mail ignorieren. Dein Passwort bleibt unverändert.',
    resetByAdmin: 'Ein Mitglied des Support-Teams hat diesen Reset für dich ausgelöst. Niemand kann dein bisheriges Passwort einsehen.',
    changedSubject: 'Dein Schiffi-Passwort wurde geändert',
    changedBody: 'dein Passwort wurde soeben geändert. Alle anderen Sitzungen wurden abgemeldet.',
    changedWarn: 'Warst du das nicht, setze dein Passwort sofort zurück und melde dich beim Support.',
    linkFallback: 'Falls der Link nicht funktioniert, kopiere ihn in die Adresszeile deines Browsers:',
    signature: 'Fair Wind,\ndie Schiffi-Crew',
    footer: 'Diese Nachricht wurde automatisch versandt. Bitte antworte nicht darauf.',
  },
  en: {
    greeting: 'Ahoy {name},',
    verifySubject: 'Confirm your email address for Schiffi',
    verifyBody: 'welcome aboard. Confirm your email address with this link:',
    resetSubject: 'Reset your Schiffi password',
    resetBody: 'a password reset was requested for your account. This link is valid for {hours} hours:',
    resetIgnore: 'If this was not you, you can ignore this email. Your password stays unchanged.',
    resetByAdmin: 'A member of the support team triggered this reset for you. Nobody can read your previous password.',
    changedSubject: 'Your Schiffi password was changed',
    changedBody: 'your password has just been changed. All other sessions were signed out.',
    changedWarn: 'If this was not you, reset your password immediately and contact support.',
    linkFallback: 'If the link does not work, copy it into your browser address bar:',
    signature: 'Fair winds,\nthe Schiffi crew',
    footer: 'This message was sent automatically. Please do not reply.',
  },
  it: {
    greeting: 'Ahoy {name},',
    verifySubject: 'Conferma il tuo indirizzo email per Schiffi',
    verifyBody: 'benvenuto a bordo. Conferma il tuo indirizzo email con questo link:',
    resetSubject: 'Reimposta la tua password di Schiffi',
    resetBody: 'è stata richiesta una reimpostazione della password per il tuo account. Il link è valido per {hours} ore:',
    resetIgnore: 'Se non sei stato tu, puoi ignorare questa email. La tua password resta invariata.',
    resetByAdmin: 'Un membro dell\'assistenza ha avviato questa reimpostazione per te. Nessuno può leggere la tua password precedente.',
    changedSubject: 'La tua password di Schiffi è stata cambiata',
    changedBody: 'la tua password è appena stata cambiata. Tutte le altre sessioni sono state disconnesse.',
    changedWarn: 'Se non sei stato tu, reimposta subito la password e contatta l\'assistenza.',
    linkFallback: 'Se il link non funziona, copialo nella barra degli indirizzi del browser:',
    signature: 'Buon vento,\nl\'equipaggio di Schiffi',
    footer: 'Questo messaggio è stato inviato automaticamente. Non rispondere.',
  },
  fr: {
    greeting: 'Ohé {name},',
    verifySubject: 'Confirmez votre adresse e-mail pour Schiffi',
    verifyBody: 'bienvenue à bord. Confirmez votre adresse e-mail avec ce lien :',
    resetSubject: 'Réinitialisez votre mot de passe Schiffi',
    resetBody: 'une réinitialisation du mot de passe a été demandée pour votre compte. Ce lien est valable {hours} heures :',
    resetIgnore: 'Si ce n\'était pas vous, ignorez cet e-mail. Votre mot de passe reste inchangé.',
    resetByAdmin: 'Un membre de l\'assistance a déclenché cette réinitialisation pour vous. Personne ne peut lire votre ancien mot de passe.',
    changedSubject: 'Votre mot de passe Schiffi a été modifié',
    changedBody: 'votre mot de passe vient d\'être modifié. Toutes les autres sessions ont été déconnectées.',
    changedWarn: 'Si ce n\'était pas vous, réinitialisez immédiatement votre mot de passe et contactez l\'assistance.',
    linkFallback: 'Si le lien ne fonctionne pas, copiez-le dans la barre d\'adresse de votre navigateur :',
    signature: 'Bon vent,\nl\'équipage de Schiffi',
    footer: 'Ce message a été envoyé automatiquement. Merci de ne pas y répondre.',
  },
  zh: {
    greeting: '{name}，你好，',
    verifySubject: '确认你的 Schiffi 邮箱地址',
    verifyBody: '欢迎登船。请通过此链接确认你的邮箱地址：',
    resetSubject: '重置你的 Schiffi 密码',
    resetBody: '有人为你的账号申请了密码重置。此链接在 {hours} 小时内有效：',
    resetIgnore: '如果这不是你本人操作，可以忽略本邮件，你的密码不会变更。',
    resetByAdmin: '客服团队成员为你触发了本次重置。任何人都无法读取你此前的密码。',
    changedSubject: '你的 Schiffi 密码已更改',
    changedBody: '你的密码刚刚被更改，其他所有会话均已退出登录。',
    changedWarn: '如果这不是你本人操作，请立即重置密码并联系客服。',
    linkFallback: '如果链接无法点击，请将其复制到浏览器地址栏：',
    signature: '一路顺风，\nSchiffi 船员组',
    footer: '本邮件为系统自动发送，请勿回复。',
  },
  ru: {
    greeting: 'Приветствую, {name}!',
    verifySubject: 'Подтвердите адрес электронной почты для Schiffi',
    verifyBody: 'добро пожаловать на борт. Подтвердите адрес почты по этой ссылке:',
    resetSubject: 'Сброс пароля в Schiffi',
    resetBody: 'для вашей учётной записи запрошен сброс пароля. Ссылка действительна в течение {hours} ч.:',
    resetIgnore: 'Если это были не вы, просто проигнорируйте письмо. Пароль останется прежним.',
    resetByAdmin: 'Сотрудник поддержки инициировал этот сброс для вас. Прочитать ваш прежний пароль никто не может.',
    changedSubject: 'Ваш пароль в Schiffi изменён',
    changedBody: 'ваш пароль только что изменён. Все остальные сессии завершены.',
    changedWarn: 'Если это были не вы, немедленно сбросьте пароль и обратитесь в поддержку.',
    linkFallback: 'Если ссылка не работает, скопируйте её в адресную строку браузера:',
    signature: 'Попутного ветра,\nкоманда Schiffi',
    footer: 'Это письмо отправлено автоматически. Пожалуйста, не отвечайте на него.',
  },
};

/**
 * Partial overrides for the stylised German variants.  Anything not listed
 * here is derived from the German text by the stylisers, so a new mail string
 * is never left untranslated.
 */
const MAIL_OVERRIDES = {
  pirate: {
    greeting: 'Arrr, {name}!',
    verifySubject: 'Beglaubige deine Flaschenpost-Adresse bei Schiffi',
    verifyBody: 'willkommen an Bord, Seebär. Beglaubige deine Flaschenpost-Adresse über diesen Link:',
    resetSubject: 'Neues Losungswort für Schiffi',
    resetBody: 'jemand hat ein neues Losungswort für deinen Kahn verlangt. Dieser Link hält {hours} Stunden:',
    resetIgnore: 'Warst du das nicht, dann lass die Flaschenpost treiben. Dein Losungswort bleibt, wie es war.',
    changedSubject: 'Arrr! Dein Losungswort wurde geändert',
    changedBody: 'dein Losungswort wurde soeben geändert. Alle anderen Mannschaften wurden von Bord geschickt.',
    signature: 'Immer eine Handbreit Wasser unterm Kiel,\ndie Schiffi-Mannschaft',
  },
  'de-alt': {
    greeting: 'Seyd gegrüßet, {name},',
    signature: 'Mit günstigem Winde,\ndie Schiffi-Mannschafft',
  },
  'de-tirol': {
    greeting: 'Servus {name},',
    signature: 'Pfiat di und guate Fahrt,\ndei Schiffi-Mannschaft',
  },
};

function mailTranslator(locale) {
  const base = catalogues();
  const merged = {};
  for (const [code, flat] of Object.entries(base)) {
    merged[code] = { ...flat };
    for (const [key, value] of Object.entries(MAIL_STRINGS[code] ?? {})) {
      merged[code][`mail.${key}`] = value;
    }
  }
  for (const [code, strings] of Object.entries(MAIL_OVERRIDES)) {
    merged[code] = merged[code] ?? {};
    for (const [key, value] of Object.entries(strings)) merged[code][`mail.${key}`] = value;
  }
  return new Translator(merged, locale);
}

function wrap(t, name, paragraphs, link) {
  const lines = [t.t('mail.greeting', { name }), ''];
  for (const p of paragraphs) lines.push(p, '');
  if (link) {
    lines.push(link, '', t.t('mail.linkFallback'), link, '');
  }
  lines.push(t.t('mail.signature'), '', '--', t.t('mail.footer'));
  const text = lines.join('\n');

  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.55;color:#1b2430">
<p>${escapeHtml(t.t('mail.greeting', { name }))}</p>
${paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n')}
${link ? `<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;background:#1b6f8c;color:#fff;border-radius:6px;text-decoration:none">${escapeHtml(link)}</a></p>` : ''}
<p style="white-space:pre-line">${escapeHtml(t.t('mail.signature'))}</p>
<hr style="border:none;border-top:1px solid #d7dee5">
<p style="font-size:12px;color:#65727f">${escapeHtml(t.t('mail.footer'))}</p>
</body></html>`;

  return { text, html };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function verifyEmailTemplate({ locale, name, token }) {
  const t = mailTranslator(locale);
  const link = `${config.publicUrl}/verify?token=${encodeURIComponent(token)}`;
  const { text, html } = wrap(t, name, [t.t('mail.verifyBody')], link);
  return { subject: t.t('mail.verifySubject'), text, html, locale };
}

export function passwordResetTemplate({ locale, name, token, hours = 2, byAdmin = false }) {
  const t = mailTranslator(locale);
  const link = `${config.publicUrl}/reset?token=${encodeURIComponent(token)}`;
  const paragraphs = [t.t('mail.resetBody', { hours })];
  paragraphs.push(byAdmin ? t.t('mail.resetByAdmin') : t.t('mail.resetIgnore'));
  const { text, html } = wrap(t, name, paragraphs, link);
  return { subject: t.t('mail.resetSubject'), text, html, locale };
}

export function passwordChangedTemplate({ locale, name }) {
  const t = mailTranslator(locale);
  const { text, html } = wrap(t, name, [t.t('mail.changedBody'), t.t('mail.changedWarn')], null);
  return { subject: t.t('mail.changedSubject'), text, html, locale };
}

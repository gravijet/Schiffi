/**
 * Avatar picking.
 *
 * The browser does the work: the picked file is drawn into a canvas at the
 * size it will actually be shown, then encoded as WebP. That keeps the upload
 * to a few kilobytes instead of a phone camera's several megabytes, and means
 * the server needs no image library at all - it only has to verify that what
 * arrived really is a WebP and store it.
 *
 * A browser that cannot encode WebP is told so rather than quietly sending a
 * PNG the server would refuse.
 */
import { h, add, clear, toast } from './dom.js';
import { t } from '../state/i18n.js';
import { api } from '../net/api.js';

/** The size an avatar is stored at. Square, because every place shows it square. */
export const AVATAR_SIZE = 256;

/** Draw a file into a square canvas, cropping to the centre, and encode WebP. */
export async function encodeAvatar(file) {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error('profile.avatarFormat');

  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';

  // Centre crop: scale so the shorter side fills, then centre the longer one.
  const scale = Math.max(AVATAR_SIZE / bitmap.width, AVATAR_SIZE / bitmap.height);
  const w = bitmap.width * scale;
  const hgt = bitmap.height * scale;
  ctx.drawImage(bitmap, (AVATAR_SIZE - w) / 2, (AVATAR_SIZE - hgt) / 2, w, hgt);
  bitmap.close?.();

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.85));
  if (!blob || blob.type !== 'image/webp') throw new Error('profile.avatarUnsupported');
  return blob;
}

/** The avatar card for the profile screen. */
export function avatarCard(session, onChange) {
  const root = h('div.card');
  const preview = h('img.avatar', {
    alt: t('profile.avatar'),
    width: 96, height: 96,
    src: session.user.avatar ?? placeholder(session.user.username),
  });
  const input = h('input', { type: 'file', accept: 'image/*', hidden: true });

  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const blob = await encodeAvatar(file);
      const { avatar } = await api.uploadAvatar(blob);
      preview.src = avatar;
      toast(t('profile.avatarSaved'), 'good');
      onChange?.(avatar);
    } catch (error) {
      toast(t(error.code ?? error.message ?? 'error.generic'), 'bad');
    }
  });

  add(root,
    h('div.card__title', null, t('profile.avatar')),
    h('div.row', null,
      preview,
      h('div.stack', null,
        h('button', { onClick: () => input.click() }, t('profile.uploadAvatar')),
        session.user.avatar
          ? h('button.ghost', {
            onClick: async () => {
              try {
                await api.removeAvatar();
                preview.src = placeholder(session.user.username);
                onChange?.(null);
              } catch (error) { toast(t(error.code ?? 'error.generic'), 'bad'); }
            },
          }, t('common.delete'))
          : null,
        h('p.small.muted', null, t('profile.avatarHint')))),
    input);
  return root;
}

/**
 * A stand-in drawn from the name, so a player without a picture still has a
 * distinct mark rather than an empty box.
 */
export function placeholder(name = '?') {
  const letter = [...String(name)][0]?.toUpperCase() ?? '?';
  let hash = 0;
  for (const char of String(name)) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  const hue = hash % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">`
    + `<rect width="96" height="96" fill="hsl(${hue} 32% 28%)"/>`
    + `<text x="48" y="63" font-size="46" text-anchor="middle"`
    + ` font-family="system-ui,sans-serif" fill="hsl(${hue} 45% 82%)">${escapeXml(letter)}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const escapeXml = (text) => text.replace(/[<>&"']/g, (char) =>
  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[char]));

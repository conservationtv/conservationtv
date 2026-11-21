import type { PresetPicture } from '@/queries/cameras';

// A preset's thumbnail, taken from the canvas the camera's video is drawn into: scaled down, and encoded as WebP
// where the browser can (JPEG where it can't), small enough for the studio to keep.

/** How wide a thumbnail is, in pixels; a narrower video is kept as it is. */
const THUMBNAIL_WIDTH = 480;
/** The most the studio keeps for a thumbnail, once decoded. */
const THUMBNAIL_LIMIT_BYTES = 256 * 1024;
/** The qualities tried, best first, until one fits. The first nearly always does. */
const QUALITIES = [0.8, 0.6, 0.4];

const WEBP_PREFIX = 'data:image/webp;base64,';
const JPEG_PREFIX = 'data:image/jpeg;base64,';

/** A canvas as one type at one quality. A browser that can't encode WebP answers with a PNG, so JPEG is asked for. */
function encoded(canvas: HTMLCanvasElement, quality: number): PresetPicture {
  const webp = canvas.toDataURL('image/webp', quality);
  if (webp.startsWith(WEBP_PREFIX)) return { contentType: 'image/webp', data: webp.slice(WEBP_PREFIX.length) };
  const jpeg = canvas.toDataURL('image/jpeg', quality);
  if (!jpeg.startsWith(JPEG_PREFIX)) throw new Error('This browser can’t encode the picture.');
  return { contentType: 'image/jpeg', data: jpeg.slice(JPEG_PREFIX.length) };
}

/**
 * A thumbnail of what a video's canvas shows now, or null while it has shown nothing: a canvas is 300 by 150 until
 * the player sizes it to the video's first frame. Throws if the canvas can't be read, or its picture can't be made
 * to fit.
 */
export function thumbnailOf(canvas: HTMLCanvasElement): PresetPicture | null {
  if (canvas.width === 0 || canvas.height === 0) return null;
  if (canvas.width === 300 && canvas.height === 150) return null;
  const scale = Math.min(1, THUMBNAIL_WIDTH / canvas.width);
  const small = document.createElement('canvas');
  small.width = Math.round(canvas.width * scale);
  small.height = Math.round(canvas.height * scale);
  const context = small.getContext('2d');
  if (!context) throw new Error('This browser can’t draw the picture.');
  context.drawImage(canvas, 0, 0, small.width, small.height);
  for (const quality of QUALITIES) {
    const picture = encoded(small, quality);
    // Base64 spends four characters on every three bytes.
    if (picture.data.length * 0.75 <= THUMBNAIL_LIMIT_BYTES) return picture;
  }
  throw new Error('The picture is too large to keep.');
}

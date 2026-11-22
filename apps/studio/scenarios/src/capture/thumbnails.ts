import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Browser, Page } from 'playwright';

// Thumbnails for the report's cards: the top of each screenshot (its first screen, not the whole of a page that may
// run to thousands of pixels), small and as WebP, so a report of hundreds of shots opens without loading the full
// images; those load only when a shot is opened. The browser the capture already runs encodes them, on a canvas, so
// this needs no image library.

/** How wide a thumbnail is: enough for a card on a high-density screen. */
export const THUMBNAIL_WIDTH = 480;
/** Height over width: a landscape screen's first view. */
export const THUMBNAIL_ASPECT = 0.625;
const QUALITY = 0.8;

/** Where a full image's thumbnail goes: beside it under thumbs/, as WebP. */
export function thumbnailPath(file: string): string {
  return join('thumbs', file.replace(/\.png$/u, '.webp'));
}

export class Thumbnailer {
  private constructor(private readonly page: Page) {}

  /** A tab to make thumbnails in, from a blank page so nothing else runs there. */
  static async open(browser: Browser): Promise<Thumbnailer> {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><title>thumbnails</title>');
    return new Thumbnailer(page);
  }

  /** The thumbnail of `file` (a PNG under `outDir`), written beside it under thumbs/; returns its relative path. */
  async make(outDir: string, file: string): Promise<string> {
    const png = readFileSync(join(outDir, file)).toString('base64');
    const webp = await this.page.evaluate(
      async ({ png, width, aspect, quality }) => {
        const image = new Image();
        image.src = `data:image/png;base64,${png}`;
        await image.decode();
        const scale = width / image.naturalWidth;
        // The top of the page, at most a screen's worth.
        const sourceHeight = Math.min(image.naturalHeight, image.naturalWidth * aspect);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = Math.round(sourceHeight * scale);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('No 2D canvas to draw thumbnails on');
        context.imageSmoothingQuality = 'high';
        context.drawImage(image, 0, 0, image.naturalWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/webp', quality).replace(/^data:image\/webp;base64,/u, '');
      },
      { png, width: THUMBNAIL_WIDTH, aspect: THUMBNAIL_ASPECT, quality: QUALITY }
    );
    const thumbnail = thumbnailPath(file);
    mkdirSync(dirname(join(outDir, thumbnail)), { recursive: true });
    writeFileSync(join(outDir, thumbnail), Buffer.from(webp, 'base64'));
    return thumbnail;
  }

  async close() {
    await this.page.close();
  }
}

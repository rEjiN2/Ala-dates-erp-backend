import pdfmake from 'pdfmake';
import type { TDocumentDefinitions } from 'pdfmake/interfaces.js';

/**
 * The 14 standard PDF fonts are built into every PDF reader, so documents
 * need no font files: nothing to bundle, nothing read from disk at runtime
 * (which also keeps serverless deploys simple). Latin text only.
 */
export const PDF_FONT = 'Helvetica';
const STANDARD_FONT_FILES = new Set(['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique']);

pdfmake.setFonts({
  [PDF_FONT]: {
    normal: 'Helvetica',
    bold: 'Helvetica-Bold',
    italics: 'Helvetica-Oblique',
    bolditalics: 'Helvetica-BoldOblique',
  },
});
// Document definitions may contain user-entered text and images; never let
// one make the server fetch a URL or read a file. Images are passed in as
// data URLs, which these policies don't apply to.
pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy((path) => STANDARD_FONT_FILES.has(path));

/** Renders a pdfmake document definition to PDF bytes. */
export async function renderPdf(definition: TDocumentDefinitions): Promise<Buffer> {
  return pdfmake.createPdf({ ...definition, defaultStyle: { font: PDF_FONT, ...definition.defaultStyle } }).getBuffer();
}

declare module 'pdf-parse' {
  interface PdfData {
    text?: string;
    numpages?: number;
  }
  export default function pdfParse(data: Buffer): Promise<PdfData>;
}

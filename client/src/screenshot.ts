// screenshot.ts — best-effort element screenshot via html2canvas.
import html2canvas from "html2canvas";

/** One capture attempt: the PNG data URL, or why there is none. */
export interface ElementCapture {
  dataUrl?: string;
  /** Why the capture failed, when it did. Never thrown. */
  error?: string;
}

/**
 * Captures one element. A failure is reported, not swallowed: the order that
 * carries this report says a screenshot is missing rather than silently
 * omitting it, and the console names the reason once per attempt.
 */
export async function captureElement(el: Element): Promise<ElementCapture> {
  try {
    const canvas = await html2canvas(el as HTMLElement, {
      logging: false,
      scale: Math.min(window.devicePixelRatio || 1, 2),
      backgroundColor: null,
    });
    return { dataUrl: canvas.toDataURL("image/png") };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const message = `[emergent.feedback] element screenshot failed: ${reason}`;
    console.warn(message);
    return { error: reason };
  }
}

/** Shared parsing helpers for HTTP boundaries: rupees in, paisa out. */

export const toPaisa = (rupees: number): number => Math.round(rupees * 100);
export const toMilli = (qty: number): number => Math.round(qty * 1000);
export const fromPaisa = (paisa: number): number => paisa / 100;
export const fromMilli = (milli: number): number => milli / 1000;

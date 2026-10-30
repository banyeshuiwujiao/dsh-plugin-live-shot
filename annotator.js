/**
 * Browser-side annotation engine.
 *
 * The upstream plugin drew its annotations inside an Electron overlay process
 * driven over IPC. This module keeps the same drawing model — an ordered list
 * of primitive operations replayed over a base bitmap — but runs it in the
 * page, so the DSH web profile needs no desktop runtime at all.
 *
 * Every operation is stored in *image pixel* coordinates, not screen
 * coordinates, so an annotation survives zooming and re-rendering.
 */

/** Drawing tools this engine supports. */
export const TOOLS = ['rect', 'ellipse', 'arrow', 'pen', 'mosaic', 'text'];

/** Default stroke color. */
const DEFAULT_COLOR = '#ff3b30';

/** Smallest stroke weight in image pixels. */
const MIN_WEIGHT = 1;

/**
 * Clamp a number into an inclusive range.
 * @param value - the number to clamp.
 * @param min - lower bound.
 * @param max - upper bound.
 * @returns the clamped number.
 */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Build the axis-aligned box that covers two points.
 * @param a - first point.
 * @param b - second point.
 * @returns the covering box.
 */
export function boxOf(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y)
  };
}

/**
 * Create one annotation operation.
 * @param tool - the drawing tool.
 * @param points - the operation's points in image pixels.
 * @param color - stroke and fill color.
 * @param width - stroke weight in image pixels.
 * @returns the operation.
 */
export function createOp(tool, points, color = DEFAULT_COLOR, width = 3) {
  return { tool, points, color, width };
}

/**
 * Draw one operation onto a 2D context.
 *
 * Mosaic reads the pixels already on the canvas, so it must run after the base
 * bitmap is painted — which the renderer guarantees.
 * @param {CanvasRenderingContext2D} context - the target context.
 * @param {object} op - the operation to paint.
 * @param {number} width - canvas width in pixels.
 * @param {number} height - canvas height in pixels.
 */
export function paintOp(context, op, width, height) {
  const points = op.points;
  if (!Array.isArray(points) || points.length === 0) return;
  const first = points[0];
  const last = points[points.length - 1];
  const rect = boxOf(first, last);

  context.save();
  context.strokeStyle = op.color;
  context.fillStyle = op.color;
  context.lineWidth = op.width;
  context.lineCap = 'round';
  context.lineJoin = 'round';

  if (op.tool === 'rect') {
    context.strokeRect(rect.x, rect.y, rect.width, rect.height);
  } else if (op.tool === 'ellipse') {
    context.beginPath();
    context.ellipse(
      rect.x + rect.width / 2,
      rect.y + rect.height / 2,
      Math.max(0.1, rect.width / 2),
      Math.max(0.1, rect.height / 2),
      0,
      0,
      Math.PI * 2
    );
    context.stroke();
  } else if (op.tool === 'arrow') {
    const angle = Math.atan2(last.y - first.y, last.x - first.x);
    const head = Math.max(12, op.width * 4);
    context.beginPath();
    context.moveTo(first.x, first.y);
    context.lineTo(last.x, last.y);
    context.stroke();
    context.beginPath();
    context.moveTo(last.x, last.y);
    context.lineTo(last.x - head * Math.cos(angle - 0.45), last.y - head * Math.sin(angle - 0.45));
    context.lineTo(last.x - head * Math.cos(angle + 0.45), last.y - head * Math.sin(angle + 0.45));
    context.closePath();
    context.fill();
  } else if (op.tool === 'pen') {
    context.beginPath();
    context.moveTo(first.x, first.y);
    for (const point of points) context.lineTo(point.x, point.y);
    context.stroke();
  } else if (op.tool === 'text') {
    context.font = `${Math.round(op.width * 4 + 14)}px "Segoe UI", system-ui, sans-serif`;
    context.textBaseline = 'top';
    if (op.text) context.fillText(op.text, first.x, first.y);
  } else if (op.tool === 'mosaic') {
    paintMosaic(context, rect, op.width);
  }

  context.restore();
}

/**
 * Blur one region by averaging it into blocks.
 * @param {CanvasRenderingContext2D} context - the target context.
 * @param {object} rect - the region in image pixels.
 * @param {number} weight - the mosaic block size in image pixels.
 */
function paintMosaic(context, rect, weight) {
  const canvas = context.canvas;
  const x = Math.max(0, Math.floor(rect.x));
  const y = Math.max(0, Math.floor(rect.y));
  const w = Math.min(canvas.width, Math.ceil(rect.x + rect.width)) - x;
  const h = Math.min(canvas.height, Math.ceil(rect.y + rect.height)) - y;
  if (w <= 0 || h <= 0) return;
  const pixels = context.getImageData(x, y, w, h);
  const step = Math.max(8, Math.round(weight * 4));
  for (let by = 0; by < pixels.height; by += step) {
    for (let bx = 0; bx < pixels.width; bx += step) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let count = 0;
      const bw = Math.min(step, pixels.width - bx);
      const bh = Math.min(step, pixels.height - by);
      for (let dy = 0; dy < bh; dy += 1) {
        for (let dx = 0; dx < bw; dx += 1) {
          const i = ((by + dy) * pixels.width + bx + dx) * 4;
          red += pixels.data[i];
          green += pixels.data[i + 1];
          blue += pixels.data[i + 2];
          count += 1;
        }
      }
      context.fillStyle = `rgb(${Math.round(red / count)},${Math.round(green / count)},${Math.round(blue / count)})`;
      context.fillRect(x + bx, y + by, bw, bh);
    }
  }
}

/**
 * Replay every operation over a base bitmap.
 *
 * The base is drawn first, then the committed operations, then the in-flight
 * draft — so the user sees the stroke they are drawing right now.
 * @param {CanvasRenderingContext2D} context - the target context.
 * @param {CanvasImageSource} base - the base bitmap.
 * @param {readonly object[]} ops - the committed operations.
 * @param {object|null} draft - the operation currently being drawn.
 */
export function renderOps(context, base, ops, draft) {
  context.clearRect(0, 0, context.canvas.width, context.canvas.height);
  if (base) context.drawImage(base, 0, 0);
  for (const op of ops) paintOp(context, op, context.canvas.width, context.canvas.height);
  if (draft) paintOp(context, draft, context.canvas.width, context.canvas.height);
}

/**
 * Scale every operation when the base bitmap changes size.
 *
 * Used when an annotation is reopened on a differently sized copy of the same
 * image, so the marks land in the same relative place.
 * @param {readonly object[]} ops - the operations to scale.
 * @param {number} fromWidth - the width the operations were authored against.
 * @param {number} fromHeight - the height the operations were authored against.
 * @param {number} toWidth - the new width.
 * @param {number} toHeight - the new height.
 * @returns the scaled operations.
 */
export function scaleOps(ops, fromWidth, fromHeight, toWidth, toHeight) {
  if (fromWidth <= 0 || fromHeight <= 0) return ops.map((op) => ({ ...op }));
  const scaleX = toWidth / fromWidth;
  const scaleY = toHeight / fromHeight;
  return ops.map((op) => ({
    ...op,
    width: op.width * Math.min(scaleX, scaleY),
    points: op.points.map((point) => ({ x: point.x * scaleX, y: point.y * scaleY }))
  }));
}

/**
 * Encode a canvas as a PNG blob.
 * @param {HTMLCanvasElement} canvas - the canvas to encode.
 * @returns the PNG bytes.
 */
export function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) {
        reject(new Error('Canvas encoding failed'));
        return;
      }
      resolve(blob);
    }, 'image/png');
  });
}

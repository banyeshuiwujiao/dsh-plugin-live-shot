/**
 * Unit tests for the annotation engine.
 *
 * The engine is pure geometry plus canvas calls, so the interesting parts are
 * the coordinate mapping, the operation model, and the mosaic block size.
 * The canvas is stubbed with just enough surface for the engine to paint into.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { boxOf, clamp, createOp, paintOp, renderOps, scaleOps } from '../annotator.js';

/** A canvas stub that records the calls the engine makes. */
function createContextStub(width = 100, height = 100) {
  const calls = [];
  return {
    calls,
    canvas: { width, height },
    save() { calls.push(['save']); },
    restore() { calls.push(['restore']); },
    clearRect() { calls.push(['clearRect']); },
    drawImage() { calls.push(['drawImage']); },
    beginPath() { calls.push(['beginPath']); },
    moveTo(x, y) { calls.push(['moveTo', x, y]); },
    lineTo(x, y) { calls.push(['lineTo', x, y]); },
    closePath() { calls.push(['closePath']); },
    stroke() { calls.push(['stroke']); },
    fill() { calls.push(['fill']); },
    fillRect() { calls.push(['fillRect']); },
    fillText(text) { calls.push(['fillText', text]); },
    ellipse() { calls.push(['ellipse']); },
    strokeRect() { calls.push(['strokeRect']); },
    getImageData() {
      return { width: 10, height: 10, data: new Uint8ClampedArray(10 * 10 * 4) };
    },
    set strokeStyle(value) { calls.push(['strokeStyle', value]); },
    set fillStyle(value) { calls.push(['fillStyle', value]); },
    set lineWidth(value) { calls.push(['lineWidth', value]); },
    set lineCap(value) { calls.push(['lineCap', value]); },
    set lineJoin(value) { calls.push(['lineJoin', value]); },
    set font(value) { calls.push(['font', value]); },
    set textBaseline(value) { calls.push(['textBaseline', value]); }
  };
}

test('boxOf covers two points in any order', () => {
  assert.deepEqual(boxOf({ x: 10, y: 20 }, { x: 4, y: 6 }), { x: 4, y: 6, width: 6, height: 14 });
  assert.deepEqual(boxOf({ x: 4, y: 6 }, { x: 10, y: 20 }), { x: 4, y: 6, width: 6, height: 14 });
});

test('clamp bounds a value', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(11, 0, 10), 10);
});

test('createOp records the tool, points, color, and width', () => {
  const op = createOp('rect', [{ x: 1, y: 2 }], '#00ff00', 5);
  assert.equal(op.tool, 'rect');
  assert.deepEqual(op.points, [{ x: 1, y: 2 }]);
  assert.equal(op.color, '#00ff00');
  assert.equal(op.width, 5);
});

test('a rectangle paints a stroked rect and restores the context', () => {
  const context = createContextStub();
  paintOp(context, createOp('rect', [{ x: 1, y: 2 }, { x: 8, y: 9 }], '#ff0000', 2));
  assert.ok(context.calls.some(([name]) => name === 'save'));
  assert.ok(context.calls.some(([name]) => name === 'restore'));
  assert.ok(context.calls.some(([name]) => name === 'strokeRect'));
  assert.deepEqual(
    context.calls.find(([name]) => name === 'strokeRect'),
    ['strokeRect']
  );
});

test('an arrow paints a shaft and a filled head', () => {
  const context = createContextStub();
  paintOp(context, createOp('arrow', [{ x: 0, y: 0 }, { x: 20, y: 0 }]));
  assert.ok(context.calls.some(([name]) => name === 'moveTo'));
  assert.ok(context.calls.some(([name]) => name === 'lineTo'));
  assert.ok(context.calls.some(([name]) => name === 'closePath'));
  assert.ok(context.calls.some(([name]) => name === 'fill'));
});

test('a pen stroke chains every point', () => {
  const context = createContextStub();
  paintOp(context, createOp('pen', [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 9, y: 1 }]));
  const lines = context.calls.filter(([name]) => name === 'lineTo');
  assert.equal(lines.length, 3);
});

test('a text operation paints its body only when it has one', () => {
  const withText = createContextStub();
  paintOp(withText, { ...createOp('text', [{ x: 3, y: 4 }]), text: 'hello' });
  assert.ok(withText.calls.some(([name]) => name === 'fillText'));

  const withoutText = createContextStub();
  paintOp(withoutText, { ...createOp('text', [{ x: 3, y: 4 }]), text: '' });
  assert.ok(!withoutText.calls.some(([name]) => name === 'fillText'));
});

test('a mosaic reads the pixels and paints blocks', () => {
  const context = createContextStub();
  paintOp(context, createOp('mosaic', [{ x: 0, y: 0 }, { x: 20, y: 20 }], '#000000', 3));
  assert.ok(context.calls.some(([name]) => name === 'fillRect'));
});

test('an operation with no points paints nothing', () => {
  const context = createContextStub();
  paintOp(context, createOp('rect', []));
  assert.ok(!context.calls.some(([name]) => name === 'strokeRect'));
});

test('renderOps clears, draws the base, then replays the operations', () => {
  const context = createContextStub();
  const base = { width: 100, height: 100 };
  renderOps(context, base, [createOp('rect', [{ x: 1, y: 1 }, { x: 2, y: 2 }])], null);
  const names = context.calls.map(([name]) => name);
  assert.equal(names[0], 'clearRect');
  assert.ok(names.includes('drawImage'));
  assert.ok(names.indexOf('drawImage') < names.indexOf('strokeRect'));
});

test('renderOps paints the draft after the committed operations', () => {
  const context = createContextStub();
  renderOps(
    context,
    null,
    [createOp('rect', [{ x: 1, y: 1 }, { x: 2, y: 2 }])],
    createOp('rect', [{ x: 5, y: 5 }, { x: 6, y: 6 }])
  );
  const rects = context.calls.filter(([name]) => name === 'strokeRect');
  assert.equal(rects.length, 2, 'the committed operation and the draft both paint');
});

test('scaleOps scales points and the stroke width proportionally', () => {
  const ops = [createOp('rect', [{ x: 10, y: 20 }, { x: 30, y: 40 }], '#fff', 4)];
  const scaled = scaleOps(ops, 100, 100, 200, 400);
  assert.deepEqual(scaled[0].points, [{ x: 20, y: 80 }, { x: 60, y: 160 }]);
  assert.equal(scaled[0].width, 8, 'the width follows the smaller scale');
});

test('scaleOps leaves the operations alone when the source size is unknown', () => {
  const ops = [createOp('rect', [{ x: 10, y: 20 }])];
  const scaled = scaleOps(ops, 0, 0, 200, 200);
  assert.deepEqual(scaled[0].points, [{ x: 10, y: 20 }]);
});

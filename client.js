/**
 * Browser client for the DSH image annotator.
 *
 * Upstream `dsh-plugin-live-shot` captured the live Windows desktop through an
 * Electron helper and drew its annotation overlay inside that helper's window.
 * This build drops the desktop runtime entirely: the DSH web profile is plain
 * Node, so the annotation surface is a page overlay driven by a plain canvas.
 *
 * What it does:
 *   - lists the image drafts already sitting in the composer, lets the user
 *     pick one, and opens it in the annotator;
 *   - lets the user capture the screen (getDisplayMedia), paste an image, or
 *     pick a file, and annotate that;
 *   - on save, either replaces the composer draft in place or adds the
 *     annotated image as a new draft.
 *
 * The drawing engine is inlined here on purpose: a plugin's `client.js` is
 * served as one bare script, so a second file would need the package's chunk
 * route (`client.<name>.js`), which only a bundler produces. The same engine
 * lives in `annotator.js` as a plain ES module for unit tests.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-live-shot',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    /** This package's copy namespace. */
    const NS = 'dsh-shot';
    /** The plugin's identity in the client module registry. */
    const PLUGIN_ID = 'dsh-plugin-live-shot';

    /** The file extension each media type is submitted under. */
    const IMAGE_EXTENSIONS = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'image/bmp': 'bmp',
      'image/avif': 'avif',
      'image/svg+xml': 'svg'
    };

    /** Longest edge a captured or picked image is normalized down to. */
    const MAX_EDGE = 2560;

    /** The default stroke color. */
    const DEFAULT_COLOR = '#ff3b30';

    // ------------------------------------------------------------ the engine

    /**
     * Build the axis-aligned box that covers two points.
     * @param a - first point.
     * @param b - second point.
     * @returns the covering box.
     */
    function boxOf(a, b) {
      return {
        x: Math.min(a.x, b.x),
        y: Math.min(a.y, b.y),
        width: Math.abs(a.x - b.x),
        height: Math.abs(a.y - b.y)
      };
    }

    /**
     * Draw one annotation operation onto a 2D context.
     * @param {CanvasRenderingContext2D} context - the target context.
     * @param {object} op - the operation to paint.
     */
    function paintOp(context, op) {
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
     * @param {CanvasRenderingContext2D} context - the target context.
     * @param {CanvasImageSource} base - the base bitmap.
     * @param {readonly object[]} ops - the committed operations.
     * @param {object|null} draft - the operation currently being drawn.
     */
    function renderOps(context, base, ops, draft) {
      context.clearRect(0, 0, context.canvas.width, context.canvas.height);
      if (base) context.drawImage(base, 0, 0);
      for (const op of ops) paintOp(context, op);
      if (draft) paintOp(context, draft);
    }

    /**
     * Encode a canvas as a PNG blob.
     * @param {HTMLCanvasElement} canvas - the canvas to encode.
     * @returns the PNG bytes.
     */
    function canvasToBlob(canvas) {
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

    // ---------------------------------------------------------------- copy

    /** Simplified Chinese dictionary. */
    const zh = {
      'button.label': '标注截图',
      'button.title': '标注截图：给输入框里的图片加记号，或新建一张',
      'panel.title': '图片标注',
      'panel.composer': '输入框里的图片',
      'panel.composer.empty': '输入框里还没有图片。',
      'action.capture': '截屏',
      'action.paste': '粘贴',
      'action.file': '选择文件',
      'action.replace': '替换原图',
      'action.add': '加入输入框',
      'action.cancel': '取消',
      'action.copy': '复制',
      'action.undo': '撤销',
      'action.clear': '清空标记',
      'tool.rect': '矩形',
      'tool.ellipse': '椭圆',
      'tool.arrow': '箭头',
      'tool.pen': '画笔',
      'tool.mosaic': '马赛克',
      'tool.text': '文字',
      'field.color': '颜色',
      'field.weight': '粗细',
      'field.text': '文字内容',
      'error.noIntake': '当前界面没有可接收附件的输入框，请打开一个会话再试。',
      'error.locked': '输入框正在提交，稍后再试一次。',
      'error.noImage': '这张图已经不在输入框里了。',
      'error.capture': '截屏失败：{message}',
      'error.paste': '没有可用的图片。',
      'error.file': '这个文件不是图片。',
      'error.encode': '保存失败：{message}',
      'notice.replaced': '已替换输入框里的第 {index} 张图。',
      'notice.added': '已把标注后的图片放进输入框。',
      'notice.copied': '已复制到剪贴板。'
    };

    /** English dictionary, checked against the Chinese key set. */
    const en = {
      'button.label': 'Annotate',
      'button.title': 'Annotate images: mark up a composer image, or start a new one',
      'panel.title': 'Image annotator',
      'panel.composer': 'Images in the composer',
      'panel.composer.empty': 'There are no images in the composer yet.',
      'action.capture': 'Capture',
      'action.paste': 'Paste',
      'action.file': 'Choose file',
      'action.replace': 'Replace original',
      'action.add': 'Add to composer',
      'action.cancel': 'Cancel',
      'action.copy': 'Copy',
      'action.undo': 'Undo',
      'action.clear': 'Clear marks',
      'tool.rect': 'Rectangle',
      'tool.ellipse': 'Ellipse',
      'tool.arrow': 'Arrow',
      'tool.pen': 'Pen',
      'tool.mosaic': 'Mosaic',
      'tool.text': 'Text',
      'field.color': 'Color',
      'field.weight': 'Weight',
      'field.text': 'Text',
      'error.noIntake': 'There is no composer here that accepts attachments; open a conversation first.',
      'error.locked': 'The composer is submitting; try again in a moment.',
      'error.noImage': 'That image is no longer in the composer.',
      'error.capture': 'Screen capture failed: {message}',
      'error.paste': 'No usable image was found.',
      'error.file': 'That file is not an image.',
      'error.encode': 'Could not save: {message}',
      'notice.replaced': 'Replaced image {index} in the composer.',
      'notice.added': 'Added the annotated image to the composer.',
      'notice.copied': 'Copied to the clipboard.'
    };

    /** The style block this package owns, installed once per page. */
    const STYLE_ID = 'dsh-plugin-live-shot/annotator.css';
    const CSS = [
      '.dsa-root{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;background:var(--dsw-specific-sidebar-fill,transparent)}',
      '.dsa-bar{display:flex;align-items:center;gap:6px;flex:none;flex-wrap:wrap;padding:10px 12px;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.dsa-title{font-weight:600;font-size:13px;white-space:nowrap}',
      '.dsa-spacer{flex:1 1 auto;min-width:0}',
      '.dsa-btn{display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 8px;border-radius:var(--dsw-radius-sm,6px);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}',
      '.dsa-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dsa-btn:disabled{opacity:.45;cursor:default}',
      '.dsa-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;background:rgba(0,0,0,.74);font-family:system-ui}',
      '.dsa-overlayBar{display:flex;align-items:center;gap:8px;flex:none;flex-wrap:wrap;padding:8px 12px;background:#1b1b1f;color:#fff;border-bottom:.5px solid rgba(255,255,255,.12)}',
      '.dsa-overlayBar .dsa-btn{background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.2);color:#fff}',
      '.dsa-overlayBar .dsa-btn:hover:not(:disabled){background:rgba(255,255,255,.18);color:#fff}',
      '.dsa-overlayBar .dsa-btn[data-variant="primary"]{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}',
      '.dsa-tools{display:flex;align-items:center;gap:4px}',
      '.dsa-tool{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border:1px solid rgba(255,255,255,.2);border-radius:var(--dsw-radius-sm,6px);background:rgba(255,255,255,.06);color:#fff;cursor:pointer}',
      '.dsa-tool:hover{background:rgba(255,255,255,.16)}',
      '.dsa-tool[data-active="true"]{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}',
      '.dsa-tool svg{width:16px;height:16px}',
      '.dsa-color{width:30px;height:30px;padding:2px;border:1px solid rgba(255,255,255,.25);border-radius:var(--dsw-radius-sm,6px);background:transparent;cursor:pointer}',
      '.dsa-weight{width:82px;accent-color:var(--dsw-alias-brand-primary)}',
      '.dsa-stage{flex:1 1 auto;min-height:0;display:flex;align-items:center;justify-content:center;padding:16px;overflow:auto}',
      '.dsa-canvasBox{position:relative;box-shadow:0 8px 32px rgba(0,0,0,.5);line-height:0}',
      '.dsa-canvas{display:block;max-width:min(1100px,92vw);max-height:76vh;background:#fff;cursor:crosshair;touch-action:none}',
      '.dsa-textBox{position:fixed;z-index:2147483100;padding:4px 6px;font-size:14px;color:#111;background:#fff;border:1px solid var(--dsw-alias-brand-primary);border-radius:4px;outline:none;box-shadow:0 2px 10px rgba(0,0,0,.3)}',
      '.dsa-error{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483200;padding:9px 16px;border-radius:8px;background:#b3261e;color:#fff;font:13px system-ui;box-shadow:0 4px 20px rgba(0,0,0,.4)}',
      '.dsa-toast{position:fixed;left:50%;bottom:85px;transform:translateX(-50%);z-index:2147483200;padding:9px 16px;border-radius:8px;background:#222;color:#fff;font:13px system-ui;pointer-events:none}',
      '.dsa-meta{font-size:11px;color:rgba(255,255,255,.6)}',
      '.dsa-panel{position:absolute;inset:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-overlay,#1b1b1f)}',
      '.dsa-panelBody{flex:1 1 auto;min-height:0;overflow:auto}',
      '.dsa-source{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 12px;border-bottom:.5px solid var(--dsw-alias-border-l1)}',
      '.dsa-label{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dsa-grid{display:flex;flex-wrap:wrap;gap:8px;padding:12px}',
      '.dsa-empty{padding:28px 12px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.dsa-thumb{display:flex;flex-direction:column;gap:4px;width:132px;padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-2);overflow:hidden;cursor:pointer}',
      '.dsa-thumb:hover{border-color:var(--dsw-alias-brand-primary)}',
      '.dsa-thumb img{display:block;width:100%;height:84px;object-fit:cover;background:var(--dsw-alias-bg-layer-1)}',
      '.dsa-thumbName{padding:4px 6px;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left}',
      '.dsa-close{display:inline-flex;align-items:center;justify-content:center;flex:none;width:26px;height:26px;padding:0;border:0;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground);cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.35)}',
      '.dsa-close:hover{filter:brightness(1.08)}',
      '.dsa-close:focus-visible{outline:2px solid var(--dsw-alias-state-error-primary);outline-offset:2px}'
    ].join('');

    /** Install this package's stylesheet once, and remove it when the plugin unloads. */
    function installStyles() {
      const existing = document.querySelector('style[data-plugin-css=' + JSON.stringify(STYLE_ID) + ']');
      if (existing !== null) return () => {};
      const tag = document.createElement('style');
      tag.dataset.plugin = PLUGIN_ID;
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return () => {
        tag.remove();
      };
    }

    // ---------------------------------------------------------------- helpers

    /** Whether one browser file is an image this plugin can annotate. */
    function isImageFile(file) {
      if (typeof file?.type === 'string' && file.type.startsWith('image/')) return true;
      if (typeof file?.name === 'string') return /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(file.name);
      return false;
    }

    /** Clamp a number into a range. */
    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value));
    }

    /** Show a short toast at the bottom of the page. */
    function toast(message) {
      let element = document.getElementById('dsa-toast');
      if (!element) {
        element = document.createElement('div');
        element.id = 'dsa-toast';
        element.className = 'dsa-toast';
        document.body.appendChild(element);
      }
      element.textContent = message;
      element.hidden = false;
      clearTimeout(toast.timer);
      toast.timer = setTimeout(() => {
        element.hidden = true;
      }, 3200);
    }

    /** Show an error banner over the page. */
    function showError(message) {
      let element = document.getElementById('dsa-error');
      if (!element) {
        element = document.createElement('div');
        element.id = 'dsa-error';
        element.className = 'dsa-error';
        document.body.appendChild(element);
      }
      element.textContent = message;
      element.hidden = false;
      clearTimeout(showError.timer);
      showError.timer = setTimeout(() => {
        element.hidden = true;
      }, 5200);
    }

    /** Remove the transient error banner. */
    function clearError() {
      const element = document.getElementById('dsa-error');
      if (element) element.hidden = true;
    }

    /** Shrink an oversized image so the canvas stays responsive. */
    async function normalizeImage(blob) {
      if (blob.size < 1024 * 1024) return blob;
      let bitmap;
      try {
        bitmap = await createImageBitmap(blob);
      } catch {
        return blob;
      }
      const longest = Math.max(bitmap.width, bitmap.height);
      if (longest <= MAX_EDGE) {
        bitmap.close();
        return blob;
      }
      const scale = MAX_EDGE / longest;
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d');
      if (context === null) {
        bitmap.close();
        return blob;
      }
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      const encoded = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (encoded === null) return blob;
      return encoded.size < blob.size ? encoded : blob;
    }

    /** Turn one blob into a browser File with a sensible name. */
    function toFile(blob, name) {
      const type = blob.type || 'image/png';
      const extension = IMAGE_EXTENSIONS[type] ?? 'png';
      const base = (name || 'annotated').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
      return new File([blob], `${base}.${extension}`, { type });
    }

    /** Capture one screen region through the browser's display API. */
    async function captureScreen() {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getDisplayMedia) {
        throw new Error('此浏览器不支持屏幕捕获');
      }
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'browser' },
        audio: false
      });
      try {
        const track = stream.getVideoTracks()[0];
        const video = document.createElement('video');
        video.srcObject = stream;
        video.muted = true;
        await video.play();
        const width = video.videoWidth || 1920;
        const height = video.videoHeight || 1080;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (context === null) throw new Error('无法创建画布');
        context.drawImage(video, 0, 0, width, height);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
        if (blob === null) throw new Error('截屏编码失败');
        return blob;
      } finally {
        for (const track of stream.getTracks()) track.stop();
      }
    }

    /** Read one image out of the clipboard. */
    async function readClipboardImage() {
      if (typeof navigator === 'undefined' || !navigator.clipboard?.read) {
        throw new Error('此浏览器不支持读取剪贴板');
      }
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find((entry) => entry.startsWith('image/'));
        if (type === undefined) continue;
        const blob = await item.getType(type);
        if (blob instanceof Blob && blob.size > 0) return blob;
      }
      throw new Error('剪贴板里没有图片');
    }

    // ------------------------------------------------------------ the editor

    /**
     * The annotation editor: one canvas, a tool row, and the save actions.
     *
     * The component owns the drawing state; the parent owns *which* image is
     * open and what happens to the result.
     */
    function Annotator(props) {
      const { t, source, onCancel, onSave } = props;
      const canvasRef = useRef(null);
      const imageRef = useRef(null);
      const textRef = useRef(null);
      const [tool, setTool] = useState('rect');
      const [color, setColor] = useState(DEFAULT_COLOR);
      const [weight, setWeight] = useState(3);
      const [ops, setOps] = useState([]);
      const [draft, setDraft] = useState(null);
      const [ready, setReady] = useState(false);
      const [meta, setMeta] = useState('');

      const opsRef = useRef(ops);
      const draftRef = useRef(draft);
      opsRef.current = ops;
      draftRef.current = draft;

      /** Repaint the canvas from the current operations. */
      const repaint = useCallback(() => {
        const canvas = canvasRef.current;
        const context = canvas?.getContext('2d');
        if (canvas === null || context === null || context === undefined) return;
        renderOps(context, imageRef.current, opsRef.current, draftRef.current);
      }, []);

      /** Load the source bitmap into the canvas. */
      useEffect(() => {
        let cancelled = false;
        const canvas = canvasRef.current;
        if (canvas === null) return undefined;
        const image = new Image();
        image.onload = () => {
          if (cancelled) return;
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          imageRef.current = image;
          setReady(true);
          setMeta(`${image.naturalWidth} × ${image.naturalHeight}`);
          repaint();
        };
        image.onerror = () => {
          if (!cancelled) showError(t('error.file'));
        };
        image.src = source.url;
        return () => {
          cancelled = true;
        };
      }, [source.url, repaint, t]);

      /** Repaint whenever the operation list or the draft changes. */
      useEffect(() => {
        if (ready) repaint();
      }, [ops, draft, ready, repaint]);

      /** Map a pointer event into image pixel coordinates. */
      const imagePoint = useCallback((event) => {
        const canvas = canvasRef.current;
        if (canvas === null) return { x: 0, y: 0 };
        const box = canvas.getBoundingClientRect();
        return {
          x: clamp(((event.clientX - box.left) * canvas.width) / box.width, 0, canvas.width),
          y: clamp(((event.clientY - box.top) * canvas.height) / box.height, 0, canvas.height)
        };
      }, []);

      /** Commit the text operation once the field is confirmed. */
      const commitText = useCallback(() => {
        const field = textRef.current;
        if (field === null || field.hidden) return;
        const value = field.value.trim();
        const current = draftRef.current;
        field.hidden = true;
        if (current === null) return;
        if (value !== '') {
          setOps((existing) => [...existing, { ...current, text: value }]);
        }
        setDraft(null);
      }, []);

      /** Begin a stroke or a text placement. */
      const onPointerDown = useCallback(
        (event) => {
          if (!ready || event.button !== 0) return;
          const canvas = canvasRef.current;
          if (canvas === null) return;
          event.preventDefault();
          // Pointer capture keeps the stroke going when the pointer leaves the
          // canvas. It throws when the id is no longer active (a synthetic
          // event, or a pointer already released), and that exception would
          // abort the handler before the operation is recorded — so it is
          // swallowed deliberately.
          try { canvas.setPointerCapture(event.pointerId); } catch { /* no capture, the stroke still tracks */ }
          const point = imagePoint(event);
          const box = canvas.getBoundingClientRect();
          const scale = box.width > 0 ? canvas.width / box.width : 1;
          const operation = {
            tool,
            points: [point],
            color,
            width: Math.max(1, weight * scale)
          };
          setDraft(operation);
          if (tool === 'text') {
            const field = textRef.current;
            if (field !== null) {
              field.value = '';
              field.style.left = `${clamp(event.clientX, 8, window.innerWidth - 240)}px`;
              field.style.top = `${clamp(event.clientY, 8, window.innerHeight - 48)}px`;
              field.hidden = false;
              field.focus();
            }
          }
        },
        [ready, tool, color, weight, imagePoint]
      );

      /** Extend the in-flight stroke. */
      const onPointerMove = useCallback(
        (event) => {
          const current = draftRef.current;
          if (current === null || current.tool === 'text') return;
          const point = imagePoint(event);
          if (current.tool === 'pen') {
            setDraft({ ...current, points: [...current.points, point] });
          } else {
            setDraft({ ...current, points: [current.points[0], point] });
          }
        },
        [imagePoint]
      );

      /** Finish the in-flight stroke. */
      const onPointerUp = useCallback(() => {
        const current = draftRef.current;
        if (current === null) return;
        setDraft(null);
        if (current.tool === 'text') return;
        setOps((existing) => [...existing, current]);
      }, []);

      /** Encode the annotated canvas and hand it to the parent. */
      const encode = useCallback(async () => {
        const canvas = canvasRef.current;
        if (canvas === null) return undefined;
        return canvasToBlob(canvas);
      }, []);

      const toolButtons = [
        { id: 'rect', label: t('tool.rect'), icon: 'M3 4h10v8H3z' },
        { id: 'ellipse', label: t('tool.ellipse'), icon: 'M8 3.5c3 0 5 2 5 4.5s-2 4.5-5 4.5-5-2-5-4.5 2-4.5 5-4.5z' },
        { id: 'arrow', label: t('tool.arrow'), icon: 'M3 13L12 4M12 4H8M12 4v4' },
        { id: 'pen', label: t('tool.pen'), icon: 'M3 13l1-3 7-7 2 2-7 7-3 1z' },
        { id: 'mosaic', label: t('tool.mosaic'), icon: 'M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3zM9 9h4v4H9z' },
        { id: 'text', label: t('tool.text'), icon: 'M4 3h8M8 3v10' }
      ];

      return h(
        'div',
        { className: 'dsa-overlay', role: 'dialog', 'aria-label': t('panel.title') },
        h(
          'div',
          { className: 'dsa-overlayBar' },
          h(
            'div',
            { className: 'dsa-tools' },
            toolButtons.map((entry) =>
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsa-tool',
                  key: entry.id,
                  title: entry.label,
                  'aria-label': entry.label,
                  'data-active': String(tool === entry.id),
                  onClick: () => {
                    commitText();
                    setTool(entry.id);
                  }
                },
                h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
                  h('path', { d: entry.icon, stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }))
              )
            )
          ),
          h('input', {
            type: 'color',
            className: 'dsa-color',
            title: t('field.color'),
            'aria-label': t('field.color'),
            value: color,
            onChange: (event) => setColor(event.target.value)
          }),
          h('input', {
            type: 'range',
            className: 'dsa-weight',
            min: 1,
            max: 10,
            value: weight,
            title: t('field.weight'),
            'aria-label': t('field.weight'),
            onChange: (event) => setWeight(Number(event.target.value))
          }),
          h('button', { type: 'button', className: 'dsa-btn', title: t('action.undo'), onClick: () => setOps((existing) => existing.slice(0, -1)) }, t('action.undo')),
          h('button', { type: 'button', className: 'dsa-btn', title: t('action.clear'), onClick: () => setOps([]) }, t('action.clear')),
          h('span', { className: 'dsa-spacer' }),
          h('span', { className: 'dsa-meta' }, meta),
          h('button', {
            type: 'button',
            className: 'dsa-btn',
            title: t('action.copy'),
            onClick: () => {
              void encode().then((blob) => {
                if (blob === undefined) return;
                const item = new ClipboardItem({ 'image/png': blob });
                void navigator.clipboard?.write([item]).then(
                  () => toast(t('notice.copied')),
                  () => showError(t('error.encode', { message: 'clipboard' }))
                );
              });
            }
          }, t('action.copy')),
          h('button', {
            type: 'button',
            className: 'dsa-btn',
            title: t('action.cancel'),
            onClick: () => {
              commitText();
              onCancel();
            }
          }, t('action.cancel')),
          props.replaceMode
            ? h('button', {
                type: 'button',
                className: 'dsa-btn',
                'data-variant': 'primary',
                title: t('action.replace'),
                onClick: () => {
                  void encode().then((blob) => {
                    if (blob === undefined) return;
                    onSave(blob, 'replace');
                  });
                }
              }, t('action.replace'))
            : h('button', {
                type: 'button',
                className: 'dsa-btn',
                'data-variant': 'primary',
                title: t('action.add'),
                onClick: () => {
                  void encode().then((blob) => {
                    if (blob === undefined) return;
                    onSave(blob, 'add');
                  });
                }
              }, t('action.add'))
        ),
        h(
          'div',
          { className: 'dsa-stage' },
          h(
            'div',
            { className: 'dsa-canvasBox' },
            h('canvas', {
              ref: canvasRef,
              className: 'dsa-canvas',
              onPointerDown: onPointerDown,
              onPointerMove: onPointerMove,
              onPointerUp: onPointerUp,
              onPointerCancel: onPointerUp
            })
          )
        ),
        h('input', {
          ref: textRef,
          type: 'text',
          className: 'dsa-textBox',
          placeholder: t('field.text'),
          'aria-label': t('field.text'),
          hidden: true,
          onKeyDown: (event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commitText();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              if (textRef.current !== null) textRef.current.hidden = true;
              setDraft(null);
            }
          },
          onBlur: commitText
        })
      );
    }

    // ----------------------------------------------------------- the panel

    /** The plugin's panel: pick a composer image, or start a new one. */
    function AnnotatorPanel(props) {
      const { t, sessionId, inputActions, getConversation, attachments, onClose } = props;
      const [source, setSource] = useState(null);
      const fileRef = useRef(null);

      /** Stage one blob as the image to annotate. */
      const openBlob = useCallback(async (blob, name, replaceTarget) => {
        const normalized = await normalizeImage(blob);
        const url = URL.createObjectURL(normalized);
        setSource({ url, blob: normalized, name: name ?? '', replaceTarget: replaceTarget ?? null });
      }, []);

      /**
       * Replace one composer draft with an annotated image.
       *
       * The new draft is appended and the original is then removed, so the
       * annotated copy takes the original's place without leaving a duplicate.
       */
      const replaceDraft = useCallback(
        async (blob, targetId, index) => {
          const conversation = typeof getConversation === 'function' ? getConversation() : undefined;
          if (conversation === undefined || typeof conversation.createDrafts !== 'function') {
            showError(t('error.noIntake'));
            return;
          }
          if (inputActions === undefined || typeof inputActions.addAttachments !== 'function') {
            showError(t('error.noIntake'));
            return;
          }
          const file = toFile(blob, 'annotated');
          const drafts = conversation.createDrafts(sessionId, [file], true);
          if (!inputActions.addAttachments(drafts.map((draft) => draft.id))) {
            conversation.releaseDraftAttachments?.(drafts);
            showError(t('error.locked'));
            return;
          }
          inputActions.removeAttachment?.(targetId);
          toast(t('notice.replaced', { index }));
        },
        [getConversation, inputActions, sessionId, t]
      );

      /** Add the annotated image as a new composer draft. */
      const addDraft = useCallback(
        async (blob) => {
          const conversation = typeof getConversation === 'function' ? getConversation() : undefined;
          if (conversation === undefined || typeof conversation.createDrafts !== 'function') {
            showError(t('error.noIntake'));
            return;
          }
          if (inputActions === undefined || typeof inputActions.addAttachments !== 'function') {
            showError(t('error.noIntake'));
            return;
          }
          const file = toFile(blob, 'annotated');
          const drafts = conversation.createDrafts(sessionId, [file], true);
          if (!inputActions.addAttachments(drafts.map((draft) => draft.id))) {
            conversation.releaseDraftAttachments?.(drafts);
            showError(t('error.locked'));
            return;
          }
          toast(t('notice.added'));
        },
        [getConversation, inputActions, sessionId, t]
      );

      /** Handle the editor's save action. */
      const onSave = useCallback(
        (blob, mode) => {
          const target = source?.replaceTarget ?? null;
          if (mode === 'replace' && target !== null) {
            void replaceDraft(blob, target.id, target.index);
          } else {
            void addDraft(blob);
          }
          if (source?.url !== undefined) URL.revokeObjectURL(source.url);
          setSource(null);
        },
        [source, replaceDraft, addDraft]
      );

      /** Capture the screen and open it in the editor. */
      const onCapture = useCallback(async () => {
        clearError();
        try {
          const blob = await captureScreen();
          await openBlob(blob, 'capture');
        } catch (error) {
          showError(t('error.capture', { message: error instanceof Error ? error.message : String(error) }));
        }
      }, [openBlob, t]);

      /** Paste an image from the clipboard. */
      const onPaste = useCallback(async () => {
        clearError();
        try {
          const blob = await readClipboardImage();
          await openBlob(blob, 'pasted');
        } catch (error) {
          showError(t('error.paste', { message: error instanceof Error ? error.message : String(error) }));
        }
      }, [openBlob, t]);

      /** Annotate one composer draft in place. */
      const onAnnotateDraft = useCallback(
        (attachment, index) => {
          clearError();
          void openBlob(attachment.file, attachment.file.name, { id: attachment.id, index: index + 1 });
        },
        [openBlob]
      );

      if (source !== null) {
        return h(Annotator, {
          t,
          source,
          replaceMode: source.replaceTarget !== null,
          onCancel: () => {
            if (source.url !== undefined) URL.revokeObjectURL(source.url);
            setSource(null);
          },
          onSave
        });
      }

      return h(
        'div',
        { className: 'dsa-root' },
        h(
          'div',
          { className: 'dsa-bar' },
          h('span', { className: 'dsa-title' }, t('panel.title')),
          h('span', { className: 'dsa-spacer' }),
          h('button', { type: 'button', className: 'dsa-btn', onClick: () => { void onCapture(); } }, t('action.capture')),
          h('button', { type: 'button', className: 'dsa-btn', onClick: () => { void onPaste(); } }, t('action.paste')),
          h('button', { type: 'button', className: 'dsa-btn', onClick: () => fileRef.current?.click() }, t('action.file')),
          h('input', {
            ref: fileRef,
            type: 'file',
            accept: 'image/*',
            hidden: true,
            onChange: (event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file === undefined) return;
              if (!isImageFile(file)) {
                showError(t('error.file'));
                return;
              }
              void openBlob(file, file.name);
            }
          }),
          // The close control lives in the toolbar's own flow, not floating over
          // it: an absolutely positioned button landed on the last toolbar
          // action and made it unclickable.
          h(
            'button',
            {
              type: 'button',
              className: 'dsa-close',
              'aria-label': t('action.cancel'),
              title: t('action.cancel'),
              onClick: onClose
            },
            h('svg', { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
              h('path', { d: 'M4 4l8 8M12 4l-8 8', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }))
          )
        ),
        h(
          'div',
          { className: 'dsa-panelBody' },
          h('div', { className: 'dsa-source' }, h('span', { className: 'dsa-label' }, t('panel.composer'))),
          attachments.length === 0
            ? h('div', { className: 'dsa-empty' }, t('panel.composer.empty'))
            : h(
                'div',
                { className: 'dsa-grid' },
                attachments.map((attachment, index) =>
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsa-thumb',
                      key: attachment.id,
                      title: t('action.replace'),
                      onClick: () => { onAnnotateDraft(attachment, index); }
                    },
                    h('img', { src: attachment.previewUrl, alt: attachment.file.name || '' }),
                    h('span', { className: 'dsa-thumbName' }, attachment.file.name || `#${index + 1}`)
                  )
                )
              )
        )
      );
    }

    // --------------------------------------------------------- the composer button

    /** The composer's camera button, which opens the annotator. */
    function ShotButton(props) {
      const { t, useInput, inputActions, sessionId, getConversation } = props;
      const [open, setOpen] = useState(false);
      const attachmentIds = useInput((state) => state.attachmentIds);

      /**
       * The composer's live image drafts, resolved through the conversation
       * service. Resolving on every render keeps the list in step with the
       * composer as the user adds or removes images.
       */
      const attachments = useMemo(() => {
        if (open === false) return [];
        const conversation = typeof getConversation === 'function' ? getConversation() : undefined;
        if (conversation === undefined || typeof conversation.resolveDraftAttachments !== 'function') return [];
        return conversation.resolveDraftAttachments(attachmentIds).filter((attachment) => attachment.kind === 'image');
      }, [open, attachmentIds, getConversation]);

      return h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', gap: 3 } },
        h(
          'button',
          {
            type: 'button',
            title: t('button.title'),
            'aria-label': t('button.label'),
            onClick: () => {
              clearError();
              setOpen((current) => !current);
            },
            style: { border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', width: 28, height: 28 }
          },
          h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7 },
            h('path', { d: 'M3 7h4l2-3h6l2 3h4v13H3z' }),
            h('circle', { cx: 12, cy: 13, r: 4 }),
            h('path', { d: 'M15.5 12.2l2.6 1.9-2.6 1.9z', fill: 'currentColor', stroke: 'none' }))
        ),
        open
          ? h(
              'div',
              {
                style: {
                  position: 'fixed',
                  inset: 0,
                  zIndex: 2147483000,
                  background: 'rgba(0,0,0,.62)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }
              },
              h(
                'div',
                {
                  style: {
                    position: 'relative',
                    width: 'min(920px,94vw)',
                    height: 'min(640px,88vh)',
                    display: 'flex',
                    flexDirection: 'column',
                    borderRadius: '12px',
                    background: 'var(--dsw-alias-bg-overlay,#1b1b1f)',
                    overflow: 'hidden'
                  }
                },
                h(AnnotatorPanel, {
                  t,
                  sessionId,
                  inputActions,
                  getConversation,
                  attachments,
                  onClose: () => setOpen(false)
                })
              )
            )
          : null
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS);
        ctx.effect(() => installStyles(), 'dsh-shot: styles');
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-shot: dictionaries');
        ctx.effect(() =>
          ctx.slots.inject('conversation.input.left', () =>
            ctx.slots.register(
              {
                name: 'conversation.input.left',
                id: 'dsh-shot',
                order: 20,
                locale: NS,
                inject: () => ({ getConversation: () => ctx.get('conversation') })
              },
              ShotButton
            )
          ), 'dsh-shot: composer button');
        ctx.effect(() => () => {
          document.getElementById('dsa-toast')?.remove();
          document.getElementById('dsa-error')?.remove();
        }, 'dsh-shot: transient nodes');
      }
    };
  }
});

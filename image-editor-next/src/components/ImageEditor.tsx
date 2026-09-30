"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import type { Canvas as FabricCanvas, FabricObject } from "fabric";

type OCRWord = {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
  direction: "ltr" | "rtl";
};

type EditableWord = OCRWord & {
  edited?: boolean;
  fontFamily: string;
  fontSize: number;
  fontWeight: "normal" | "bold";
  color: string;
  patchColor: string;
  align: "left" | "center" | "right";
  patchWidth?: number;
};

type ImageInfo = { width: number; height: number; scale: number };
type OCRResponse = { words?: OCRWord[]; error?: string; warnings?: string[]; languages?: string[] };

const FONT_CHOICES = [
  "Arial",
  "Georgia",
  "Times New Roman",
  "Noto Sans Arabic",
  "Noto Sans Ethiopic",
  "sans-serif",
];

export default function ImageEditor() {
  const canvasElement = useRef<HTMLCanvasElement | null>(null);
  const fabricCanvas = useRef<FabricCanvas | null>(null);
  const backgroundRef = useRef<FabricObject | null>(null);
  const guideToWord = useRef(new Map<FabricObject, string>());
  const inputRef = useRef<HTMLInputElement | null>(null);
  const measureCanvas = useRef<HTMLCanvasElement | null>(null);
  const sourcePixelsRef = useRef<ImageData | null>(null);
  const [words, setWords] = useState<EditableWord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [imageInfo, setImageInfo] = useState<ImageInfo | null>(null);
  const [imageUrl, setImageUrl] = useState("/v.jpg");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Loading the sample image…");

  const selected = useMemo(() => words.find(word => word.id === selectedId) ?? null, [words, selectedId]);

  const getPatchWidth = useCallback((word: EditableWord, current: EditableWord[]) => {
    const measure = measureCanvas.current ?? document.createElement("canvas");
    measureCanvas.current = measure;
    const context = measure.getContext("2d");
    if (!context) return word.width;
    context.font = `${word.fontWeight} ${word.fontSize}px "${word.fontFamily}"`;
    const padding = Math.max(3, word.fontSize * 0.12);
    const measured = context.measureText(word.text.replace(/[\r\n]+/g, " ")).width + padding * 2;
    const sameLineNext = current
      .filter(other => other.id !== word.id && other.x > word.x && Math.abs((other.y + other.height / 2) - (word.y + word.height / 2)) < Math.max(word.height, other.height) * 0.65)
      .reduce((nearest, other) => Math.min(nearest, other.x), imageInfo?.width ?? word.x + word.width);
    const available = Math.max(word.width, sameLineNext - word.x - Math.max(2, word.width * 0.08));
    return Math.max(word.width, Math.min(measured, available));
  }, [imageInfo]);

  useEffect(() => {
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;

    async function initialize() {
      if (!canvasElement.current) return;
      const { Canvas, FabricImage } = await import("fabric");
      if (disposed || !canvasElement.current) return;
      const canvas = new Canvas(canvasElement.current, {
        selection: false,
        preserveObjectStacking: true,
        stopContextMenu: true,
        renderOnAddRemove: false,
      });
      fabricCanvas.current = canvas;

      const imageElement = new Image();
      imageElement.onload = () => {
        if (disposed) return;
        const width = imageElement.naturalWidth;
        const height = imageElement.naturalHeight;
        const pixelCanvas = document.createElement("canvas");
        pixelCanvas.width = width;
        pixelCanvas.height = height;
        const pixelContext = pixelCanvas.getContext("2d", { willReadFrequently: true });
        pixelContext?.drawImage(imageElement, 0, 0);
        sourcePixelsRef.current = pixelContext?.getImageData(0, 0, width, height) ?? null;
        const stage = canvasElement.current?.parentElement;
        const availableWidth = Math.max(240, stage?.clientWidth ?? width);
        const availableHeight = Math.max(320, Math.min(window.innerHeight * 0.78, 900));
        const scale = Math.min(availableWidth / width, availableHeight / height, 1);
        canvas.setDimensions({ width: width * scale, height: height * scale });
        const background = new FabricImage(imageElement, {
          left: 0,
          top: 0,
          scaleX: scale,
          scaleY: scale,
          selectable: false,
          evented: false,
          objectCaching: false,
        });
        backgroundRef.current = background;
        canvas.add(background);
        canvas.sendObjectToBack(background);
        canvas.requestRenderAll();
        setImageInfo({ width, height, scale });
        setStatus("Image ready. Detect English words and numbers; other scripts stay part of the image.");
      };
      imageElement.onerror = () => setStatus("Could not load the sample image. Choose an image file to begin.");
      imageElement.src = imageUrl;

      canvas.on("mouse:down", event => {
        const target = event.target;
        const wordId = target ? guideToWord.current.get(target) : undefined;
        if (wordId) setSelectedId(wordId);
        else if (target === backgroundRef.current) setSelectedId(null);
      });

      const stage = canvasElement.current.parentElement;
      if (stage) {
        resizeObserver = new ResizeObserver(() => {
          if (!imageElement.complete || !imageElement.naturalWidth) return;
          const fit = Math.min(stage.clientWidth / imageElement.naturalWidth, Math.min(window.innerHeight * 0.78, 900) / imageElement.naturalHeight, 1);
          canvas.setDimensions({ width: imageElement.naturalWidth * fit, height: imageElement.naturalHeight * fit });
          backgroundRef.current?.set({ scaleX: fit, scaleY: fit });
          setImageInfo({ width: imageElement.naturalWidth, height: imageElement.naturalHeight, scale: fit });
          canvas.requestRenderAll();
        });
        resizeObserver.observe(stage);
      }
    }

    void initialize();
    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      guideToWord.current.clear();
      void fabricCanvas.current?.dispose();
      fabricCanvas.current = null;
      backgroundRef.current = null;
    };
  }, [imageUrl]);

  useEffect(() => {
    const canvas = fabricCanvas.current;
    if (!canvas || !imageInfo || !backgroundRef.current) return;
    let cancelled = false;

    async function redraw() {
      const { Rect, IText } = await import("fabric");
      await document.fonts.ready;
      if (cancelled || !fabricCanvas.current || !imageInfo) return;
      const currentCanvas = fabricCanvas.current;
      currentCanvas.clear();
      currentCanvas.add(backgroundRef.current!);
      guideToWord.current.clear();

      words.forEach(word => {
        const edited = Boolean(word.edited);
        const scale = imageInfo.scale;
        if (edited) {
          const patchWidth = getPatchWidth(word, words);
          const patch = new Rect({
            left: word.x * scale,
            top: word.y * scale,
            width: patchWidth * scale,
            height: Math.max(word.height, word.fontSize * 1.22) * scale,
            fill: word.patchColor,
            selectable: false,
            evented: false,
            objectCaching: false,
          });
          const textObject = new IText(word.text, {
            left: (word.align === "right" ? word.x + patchWidth : word.x) * scale,
            top: word.y * scale,
            originX: word.align === "right" ? "right" : "left",
            fontFamily: word.fontFamily,
            fontWeight: word.fontWeight,
            fontSize: word.fontSize * scale,
            fill: word.color,
            textAlign: word.align,
            direction: word.direction,
            selectable: false,
            evented: false,
            editable: false,
            objectCaching: false,
          });
          currentCanvas.add(patch, textObject);
        }

        const guide = new Rect({
          left: word.x * scale,
          top: word.y * scale,
          width: Math.max(2, word.width * scale),
          height: Math.max(2, word.height * scale),
          fill: "rgba(91, 219, 190, 0.015)",
          stroke: word.id === selectedId ? "#46aaff" : "rgba(103, 226, 199, 0.72)",
          strokeWidth: word.id === selectedId ? Math.max(1.5, scale * 2) : Math.max(1, scale),
          strokeDashArray: word.id === selectedId ? [5, 3] : undefined,
          selectable: false,
          evented: true,
          hoverCursor: "text",
          objectCaching: false,
          excludeFromExport: true,
        });
        guideToWord.current.set(guide, word.id);
        currentCanvas.add(guide);
      });

      currentCanvas.sendObjectToBack(backgroundRef.current!);
      currentCanvas.requestRenderAll();
    }

    void redraw();
    return () => { cancelled = true; };
  }, [words, selectedId, imageInfo, getPatchWidth]);

  const replaceImage = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setWords([]);
    setSelectedId(null);
    setImageInfo(null);
    setImageUrl(URL.createObjectURL(file));
    setStatus(`Loaded ${file.name}. Detect text to edit individual words.`);
  };

  const detectText = async () => {
    const file = inputRef.current?.files?.[0];
    setBusy(true);
    setStatus("Sending image to the local OCR service…");
    try {
      const form = new FormData();
      if (file) form.append("image", file);
      else {
        const response = await fetch(imageUrl);
        if (!response.ok) throw new Error("Could not read the selected image.");
        form.append("image", await response.blob(), "sample-image.jpg");
      }
      form.append("language", "en");
      const response = await fetch("/api/ocr", { method: "POST", body: form });
      const payload = (await response.json()) as OCRResponse;
      if (!response.ok) throw new Error(payload.error || "The OCR service returned an error.");
      const recognized = (payload.words ?? []).filter(word => /^(?:[A-Za-z]+(?:['’][A-Za-z]+)*|[0-9]+(?:[.,:/-][0-9]+)*)$/.test(word.text.trim()));
      const fitted = recognized.map(word => ({
        ...word,
        fontFamily: word.direction === "rtl" ? "Noto Sans Arabic" : /[\u1200-\u137f]/u.test(word.text) ? "Noto Sans Ethiopic" : "Arial",
        fontSize: Math.max(6, word.height),
        fontWeight: "bold" as const,
        color: "#202938",
        patchColor: estimatePatch(word, sourcePixelsRef.current, imageInfo),
        align: word.direction === "rtl" ? "right" as const : "left" as const,
        patchWidth: word.width,
      }));
      setWords(fitted);
      setSelectedId(null);
      const languageNote = payload.warnings?.length ? ` Some language models were unavailable: ${payload.warnings.join("; ")}` : "";
      setStatus(`Detected ${fitted.length} English word/number boxes. Other scripts remain part of the image.${languageNote}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "OCR failed. Start the Python service and retry.");
    } finally {
      setBusy(false);
    }
  };

  const updateSelected = (patch: Partial<EditableWord>) => {
    if (!selected) return;
    setWords(current => current.map(word => word.id === selected.id ? { ...word, ...patch, edited: true } : word));
  };

  const adjustSize = (delta: number) => {
    if (!selected) return;
    updateSelected({ fontSize: Math.min(180, Math.max(6, selected.fontSize + delta)) });
  };

  const fitSelectedWord = () => {
    if (!selected) return;
    const measure = measureCanvas.current ?? document.createElement("canvas");
    measureCanvas.current = measure;
    const context = measure.getContext("2d");
    if (!context) return;
    const patchWidth = getPatchWidth(selected, words);
    const padding = Math.max(4, selected.fontSize * 0.16);
    context.font = `${selected.fontWeight} ${selected.fontSize}px "${selected.fontFamily}"`;
    const textWidth = context.measureText(selected.text.replace(/[\r\n]+/g, " ")).width;
    const factor = textWidth > 0 ? Math.min(1, (patchWidth - padding) / textWidth) : 1;
    updateSelected({ fontSize: Math.max(6, Math.floor(selected.fontSize * factor)) });
  };

  const addText = () => {
    if (!imageInfo) return;
    const box: EditableWord = {
      id: crypto.randomUUID(), text: "Your text", x: imageInfo.width * 0.12, y: imageInfo.height * 0.12,
      width: imageInfo.width * 0.24, height: 46, confidence: 100, direction: "ltr", edited: true,
      fontFamily: "Arial", fontSize: Math.max(18, imageInfo.width * 0.025), color: "#202938",
      fontWeight: "bold",
      patchColor: "#ffffff", align: "left", patchWidth: imageInfo.width * 0.24,
    };
    setWords(current => [...current, box]);
    setSelectedId(box.id);
  };

  const exportImage = (format: "png" | "jpeg") => {
    const canvas = fabricCanvas.current;
    if (!canvas || !imageInfo) return;
    const scale = imageInfo.scale;
    const guideObjects = [...guideToWord.current.keys()];
    guideObjects.forEach(object => object.set({ visible: false }));
    canvas.renderAll();
    const url = canvas.toDataURL({ format, multiplier: 1 / scale, quality: 0.96 });
    guideObjects.forEach(object => object.set({ visible: true }));
    canvas.renderAll();
    const link = document.createElement("a");
    link.download = `edited-image.${format === "jpeg" ? "jpg" : "png"}`;
    link.href = url;
    link.click();
  };

  return (
    <main className="editor-app">
      <header className="app-header">
        <div className="brand-mark">T</div>
        <div className="brand-title"><h1>TypeStudio</h1><p>Image text editing · processed locally</p></div>
        <span className="local-pill"><i /> Local OCR</span>
      </header>

      <section className="toolbar" aria-label="Editor actions">
        <div className="tool-description"><span className="tool-icon">Aa</span><span><strong>Word-level editing</strong><small>Click a detected word · live preview</small></span></div>
        <div className="toolbar-actions">
          <label className="language-field">OCR language
            <select value="en" disabled={busy}>
              <option value="en">English letters and numbers</option>
            </select>
          </label>
          <input ref={inputRef} className="visually-hidden" type="file" accept="image/*" onChange={replaceImage} />
          <button className="btn btn-quiet" onClick={() => inputRef.current?.click()}>Choose image</button>
          <button className="btn btn-quiet" onClick={detectText} disabled={busy || !imageInfo}>{busy ? "Detecting…" : "Detect words"}</button>
          <button className="btn btn-quiet" onClick={addText} disabled={!imageInfo}>＋ Text</button>
          <details className="export-menu"><summary className="btn btn-primary">Save image</summary><div className="export-options"><button onClick={() => void exportImage("png")}>Download PNG</button><button onClick={() => void exportImage("jpeg")}>Download JPEG</button></div></details>
        </div>
      </section>

      <section className="image-stage" aria-label="Full image editing canvas">
        <div className="canvas-shell"><canvas ref={canvasElement} /></div>
        <div className="status-line" role="status">{status}</div>
      </section>

      <section className="properties" aria-label="Selected word properties">
        <div className="properties-head"><span className="status-dot" /><h2>{selected ? "Selected word" : "Word editor"}</h2><p>Changes appear directly over the image preview.</p></div>
        {selected ? <div className="properties-grid">
          <label className="editor-field text-field">Text
            <textarea value={selected.text} onChange={event => updateSelected({ text: event.target.value })} rows={2} dir={selected.direction} />
          </label>
          <label className="editor-field">Font
            <select value={selected.fontFamily} onChange={event => updateSelected({ fontFamily: event.target.value })}>{FONT_CHOICES.map(font => <option key={font}>{font}</option>)}</select>
          </label>
          <label className="editor-field">Weight
            <select value={selected.fontWeight} onChange={event => updateSelected({ fontWeight: event.target.value as EditableWord["fontWeight"] })}><option value="bold">Bold</option><option value="normal">Regular</option></select>
          </label>
          <label className="editor-field">Font size
            <span className="size-stepper"><button aria-label="Decrease font size" onClick={() => adjustSize(-1)}>−</button><input type="number" min={6} max={180} value={Math.round(selected.fontSize)} onChange={event => updateSelected({ fontSize: Math.min(180, Math.max(6, Number(event.target.value) || 6)) })} /><button aria-label="Increase font size" onClick={() => adjustSize(1)}>+</button><button className="fit-size-button" title="Shrink text to fit the available word area" onClick={fitSelectedWord}>Fit</button></span>
          </label>
          <label className="editor-field">Text color<input type="color" value={selected.color} onChange={event => updateSelected({ color: event.target.value })} /></label>
          <label className="editor-field">Patch color<input type="color" value={selected.patchColor} onChange={event => updateSelected({ patchColor: event.target.value })} /></label>
          <label className="editor-field">Alignment<select value={selected.align} onChange={event => updateSelected({ align: event.target.value as EditableWord["align"] })}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></label>
          <div className="confidence-field"><span>OCR confidence</span><strong>{Math.round(selected.confidence)}%</strong><small>{selected.confidence < 50 ? "Low confidence — check the detected text." : "Review the word before exporting."}</small></div>
        </div> : <p className="empty-properties">Detect text, then click a word outline. Unedited words remain exactly as they are in the source image.</p>}
      </section>

      <footer className="app-footer">OCR runs in the local Python service. The source image is never overwritten; exports are separate copies.</footer>
    </main>
  );
}

function estimatePatch(word: OCRWord, imageData: ImageData | null, info: ImageInfo | null) {
  if (!imageData || !info) return "#ffffff";
  const data = imageData.data;
  const samples: number[][] = [[], [], []];
  const sample = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= imageData.width || y >= imageData.height) return;
    const offset = (y * imageData.width + x) * 4;
    for (let channel = 0; channel < 3; channel++) samples[channel].push(data[offset + channel]);
  };
  const x0 = Math.max(0, Math.floor(word.x - 3));
  const y0 = Math.max(0, Math.floor(word.y - 3));
  const x1 = Math.min(imageData.width - 1, Math.ceil(word.x + word.width + 3));
  const y1 = Math.min(imageData.height - 1, Math.ceil(word.y + word.height + 3));
  for (let x = x0; x <= x1; x += 3) { sample(x, y0); sample(x, y1); }
  for (let y = y0; y <= y1; y += 3) { sample(x0, y); sample(x1, y); }
  const channels = samples.map(values => { values.sort((a, b) => a - b); return values[Math.floor(values.length / 2)] ?? 255; });
  return `#${channels.map(value => value.toString(16).padStart(2, "0")).join("")}`;
}

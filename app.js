const $ = id => document.getElementById(id);
const canvas = $("canvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });
const image = new Image();
let sourcePixels = null;
let textBoxes = [];
let selected = null;
let drag = null;
let ocrBusy = false;

function setStatus(message) {
  $("status").textContent = message;
}

function updateActions() {
  const ready = Boolean(image.naturalWidth);
  $("ocrBtn").disabled = !ready || ocrBusy;
  $("ocrLanguage").disabled = !ready || ocrBusy;
  $("addTextBtn").disabled = !ready;
  $("downloadBtn").disabled = !ready || !textBoxes.some(box => box.edited);
}

function fitCanvas() {
  if (!image.naturalWidth) return;
  const frame = document.querySelector(".canvas-frame");
  const scale = Math.min(frame.clientWidth / canvas.width, frame.clientHeight / canvas.height, 1);
  canvas.style.width = `${Math.floor(canvas.width * scale)}px`;
  canvas.style.height = `${Math.floor(canvas.height * scale)}px`;
}

function imagePoint(event) {
  const bounds = canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(canvas.width, (event.clientX - bounds.left) * canvas.width / bounds.width)),
    y: Math.max(0, Math.min(canvas.height, (event.clientY - bounds.top) * canvas.height / bounds.height))
  };
}

function samplePatchColor(box) {
  if (!sourcePixels) return "#ffffff";
  const { data, width, height } = sourcePixels;
  const samples = [[], [], []];
  const sample = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const offset = (y * width + x) * 4;
    for (let channel = 0; channel < 3; channel++) samples[channel].push(data[offset + channel]);
  };
  const x0 = Math.max(0, Math.floor(box.x - 4));
  const y0 = Math.max(0, Math.floor(box.y - 4));
  const x1 = Math.min(width - 1, Math.ceil(box.x + box.w + 4));
  const y1 = Math.min(height - 1, Math.ceil(box.y + box.h + 4));
  for (let x = x0; x <= x1; x += 2) {
    for (let y = y0; y <= Math.min(y1, y0 + 3); y++) sample(x, y);
    for (let y = Math.max(y0, y1 - 3); y <= y1; y++) sample(x, y);
  }
  for (let y = y0 + 3; y < y1 - 2; y += 2) {
    for (let x = x0; x <= Math.min(x1, x0 + 3); x++) sample(x, y);
    for (let x = Math.max(x0, x1 - 3); x <= x1; x++) sample(x, y);
  }
  const median = values => {
    values.sort((a, b) => a - b);
    return values.length ? values[Math.floor(values.length / 2)] : 255;
  };
  return `#${samples.map(values => median(values).toString(16).padStart(2, "0")).join("")}`;
}

function drawTextBoxes(context, showGuides = false) {
  textBoxes.forEach(box => {
    if (!box.edited) {
      if (showGuides) {
        context.save();
        context.strokeStyle = box === selected ? "#61a5ff" : "#7ce4d0";
        context.lineWidth = Math.max(2, canvas.width / 700);
        if (box === selected) context.setLineDash([9, 6]);
        context.strokeRect(box.x, box.y, box.w, box.h);
        context.restore();
      }
      return;
    }

    context.save();
    context.font = `${box.fontWeight || "bold"} ${box.fontSize}px "${box.fontFamily}"`;
    context.textBaseline = "top";
    context.direction = box.direction || "ltr";
    const pad = Math.max(2, box.fontSize * 0.08);
    const drawHeight = Math.max(box.h, box.fontSize + pad * 2);
    const patchWidth = Math.max(box.w, box.patchWidth || box.w);
    if (box.bgEnabled) {
      context.fillStyle = box.bgColor;
      context.fillRect(box.x - 1, box.y - 1, patchWidth + 2, drawHeight + 2);
    }
    context.fillStyle = box.color;
    context.textAlign = box.align;
    const textX = box.align === "left" ? box.x + pad : box.align === "center" ? box.x + patchWidth / 2 : box.x + patchWidth - pad;
    context.fillText(box.text.replace(/[\r\n]+/g, " "), textX, box.y + pad, patchWidth - pad * 2);
    if (showGuides && box === selected) {
      context.strokeStyle = "#61a5ff";
      context.lineWidth = Math.max(2, canvas.width / 700);
      context.setLineDash([9, 6]);
      context.strokeRect(box.x - 2, box.y - 2, patchWidth + 4, drawHeight + 4);
    }
    context.restore();
  });
}

function render() {
  if (!image.naturalWidth) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0);
  drawTextBoxes(ctx, true);
}

function syncControls() {
  const ids = ["textValue", "fontFamily", "fontWeight", "fontSize", "textColor", "bgColor", "bgEnabled", "textAlign", "deleteBtn", "sizeDown", "sizeUp"];
  ids.forEach(id => { $(id).disabled = !selected; });
  $("selectionHint").textContent = selected
    ? "Live preview is on. Change text or size and see it on the image immediately."
    : "Select a detected word. Unchanged OCR guesses remain part of the original image.";
  if (!selected) {
    $("textValue").value = "";
    return;
  }
  $("textValue").value = selected.text;
  $("fontFamily").value = selected.fontFamily;
  $("fontWeight").value = selected.fontWeight || "bold";
  $("fontSize").value = Math.round(selected.fontSize);
  $("textColor").value = selected.color;
  $("bgColor").value = selected.bgColor;
  $("bgEnabled").checked = selected.bgEnabled;
  $("textAlign").value = selected.align;
}

image.onload = () => {
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  ctx.drawImage(image, 0, 0);
  sourcePixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  $("loading").hidden = true;
  fitCanvas();
  updateActions();
  setStatus("Image loaded. Detect English words and numbers; other scripts stay part of the image.");
};
image.onerror = () => {
  $("loading").textContent = "Could not load v.jpg. Keep it beside index.html and reload.";
};
image.src = "v.jpg";

function overlapRatio(first, second) {
  const width = Math.max(0, Math.min(first.bbox.x1, second.bbox.x1) - Math.max(first.bbox.x0, second.bbox.x0));
  const height = Math.max(0, Math.min(first.bbox.y1, second.bbox.y1) - Math.max(first.bbox.y0, second.bbox.y0));
  const overlap = width * height;
  const areaA = Math.max(1, (first.bbox.x1 - first.bbox.x0) * (first.bbox.y1 - first.bbox.y0));
  const areaB = Math.max(1, (second.bbox.x1 - second.bbox.x0) * (second.bbox.y1 - second.bbox.y0));
  return overlap / Math.min(areaA, areaB);
}

function mergeOcrPasses(...passes) {
  const words = [];
  passes.flat().filter(word => word.text?.trim() && word.bbox).forEach(word => {
    const match = words.findIndex(existing => overlapRatio(existing, word) > 0.55);
    if (match < 0) words.push(word);
    else if ((word.confidence || 0) > (words[match].confidence || 0)) words[match] = word;
  });
  return words.sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
}

function splitCombinedTokens(word) {
  const tokens = word.text.match(/[A-Za-z]+(?:['’][A-Za-z]+)*|[0-9]+(?:[.,:/-][0-9]+)*/g) || [];
  if (!tokens.length) return [];
  if (tokens.length === 1) return [{ ...word, text: tokens[0] }];
  const { x0, x1, y0, y1 } = word.bbox;
  const fullWidth = x1 - x0;
  const tokenLengths = tokens.map(token => Math.max(1, token.replace(/[^A-Za-z0-9]/g, "").length));
  const totalChars = tokenLengths.reduce((total, length) => total + length, 0);
  const gap = Math.min(fullWidth * 0.04, Math.max(1, fullWidth / totalChars * 0.4));
  const tokenSpace = Math.max(1, fullWidth - gap * (tokens.length - 1));
  let x = x0;
  return tokens.map((token, index) => {
    const tokenWidth = tokenSpace * tokenLengths[index] / totalChars;
    const split = { ...word, text: token, bbox: { x0: x, y0, x1: x + tokenWidth, y1 } };
    x += tokenWidth + gap;
    return split;
  });
}

$("ocrBtn").addEventListener("click", async () => {
  if (!image.naturalWidth || ocrBusy || !window.Tesseract) {
    if (!window.Tesseract) setStatus("OCR library did not load. Check the internet connection and reload.");
    return;
  }
  ocrBusy = true;
  updateActions();
  const language = $("ocrLanguage").value;
  setStatus("Loading OCR language data…");
  let worker;
  let stage = "Loading OCR language data…";
  let completion = "";
  let pass = 1;
  try {
    worker = await Tesseract.createWorker(language, 1, {
      logger: progress => {
        if (progress.status === "recognizing text") stage = `Detecting words (pass ${pass}/2)… ${Math.round((progress.progress || 0) * 100)}%`;
        else if (progress.status === "loading language traineddata") stage = `Loading ${language} language data… ${Math.round((progress.progress || 0) * 100)}%`;
        setStatus(stage);
      }
    });
    const regular = await worker.recognize(image);
    let sparse = { data: { words: [] } };
    try {
      pass = 2;
      await worker.setParameters({ tessedit_pageseg_mode: "11", preserve_interword_spaces: "1" });
      sparse = await worker.recognize(image);
    } catch (error) {
      console.warn("Sparse OCR pass failed; keeping standard OCR results.", error);
    }
    const words = mergeOcrPasses(regular.data.words || [], sparse.data.words || [])
      .flatMap(splitCombinedTokens)
      .filter(word => /^(?:[A-Za-z]+(?:['’][A-Za-z]+)*|[0-9]+(?:[.,:/-][0-9]+)*)$/.test(word.text.trim()));
    textBoxes = words.map(word => {
      const box = { x: word.bbox.x0, y: word.bbox.y0, w: word.bbox.x1 - word.bbox.x0, h: word.bbox.y1 - word.bbox.y0 };
      return {
        ...box, text: word.text.trim(), fontSize: Math.max(6, box.h), fontFamily: "Arial", fontWeight: "bold",
        color: "#222222", bgColor: samplePatchColor(box), bgEnabled: true, align: "left",
        direction: "ltr", edited: false, detected: true, patchWidth: box.w,
        sourceX: box.x, sourceY: box.y, confidence: word.confidence || 0
      };
    });
    selected = null;
    syncControls();
    render();
    completion = `Detected ${textBoxes.length} English word/number boxes. Other scripts remain part of the image.`;
  } catch (error) {
    console.error(error);
    completion = `Detection failed while ${stage.toLowerCase()} Check the connection and selected language.`;
  } finally {
    if (worker) await worker.terminate();
    ocrBusy = false;
    updateActions();
    if (completion) setStatus(completion);
  }
});

function selectBox(box) {
  selected = box;
  syncControls();
  render();
}

$("addTextBtn").addEventListener("click", () => {
  const box = {
    x: canvas.width * 0.1, y: canvas.height * 0.1, w: canvas.width * 0.28, h: 48, patchWidth: canvas.width * 0.28,
    text: "Your text", fontSize: Math.max(18, canvas.width * 0.025), fontFamily: "Arial", fontWeight: "bold",
    color: "#222222", bgColor: "#ffffff", bgEnabled: true, align: "left", direction: "ltr", edited: true, detected: false
  };
  textBoxes.push(box);
  selectBox(box);
  updateActions();
  setStatus("New text is previewed on the image. Edit it below and save when ready.");
});

$("deleteBtn").addEventListener("click", () => {
  if (!selected) return;
  textBoxes = textBoxes.filter(box => box !== selected);
  selected = null;
  syncControls();
  updateActions();
  render();
});

function updateSelectedFromControls() {
  if (!selected) return;
  selected.text = $("textValue").value;
  selected.fontFamily = $("fontFamily").value;
  selected.fontWeight = $("fontWeight").value;
  selected.fontSize = Math.min(180, Math.max(6, Number($("fontSize").value) || 6));
  selected.color = $("textColor").value;
  selected.bgColor = $("bgColor").value;
  selected.bgEnabled = $("bgEnabled").checked;
  selected.align = $("textAlign").value;
  selected.edited = true;
  const pad = Math.max(2, selected.fontSize * 0.08);
  ctx.save();
  ctx.font = `${selected.fontWeight || "bold"} ${selected.fontSize}px "${selected.fontFamily}"`;
  const wantedWidth = Math.ceil(ctx.measureText(selected.text.replace(/[\r\n]+/g, " ")).width + pad * 2);
  ctx.restore();
  const nextBox = textBoxes
    .filter(box => box !== selected && Math.abs((box.y + box.h / 2) - (selected.y + selected.h / 2)) < Math.max(box.h, selected.h) * 0.7 && box.x > selected.x)
    .reduce((nearest, box) => Math.min(nearest, box.x), canvas.width);
  selected.patchWidth = Math.max(selected.w, Math.min(wantedWidth, Math.max(selected.w, nextBox - selected.x - 2)));
  render();
  updateActions();
  setStatus("Live preview updated on the image. The original file is untouched until you save a copy.");
}

["textValue", "fontFamily", "fontWeight", "fontSize", "textColor", "bgColor", "bgEnabled", "textAlign"].forEach(id => {
  $(id).addEventListener("input", updateSelectedFromControls);
});

$("sizeDown").addEventListener("click", () => {
  if (!selected) return;
  $("fontSize").value = Math.max(6, Number($("fontSize").value) - 1);
  updateSelectedFromControls();
});
$("sizeUp").addEventListener("click", () => {
  if (!selected) return;
  $("fontSize").value = Math.min(180, Number($("fontSize").value) + 1);
  updateSelectedFromControls();
});

canvas.addEventListener("pointerdown", event => {
  if (!image.naturalWidth) return;
  const point = imagePoint(event);
  const hits = textBoxes.filter(box => {
    const width = box.edited ? Math.max(box.w, box.patchWidth || box.w) : box.w;
    const height = box.edited ? Math.max(box.h, box.fontSize * 1.2) : box.h;
    return point.x >= box.x && point.x <= box.x + width && point.y >= box.y && point.y <= box.y + height;
  });
  hits.sort((a, b) => {
    const areaA = a.w * a.h;
    const areaB = b.w * b.h;
    return areaA - areaB || (a.confidence || 0) - (b.confidence || 0);
  });
  const hit = hits[0] || null;
  selectBox(hit);
  if (hit) {
    const pointX = hit.direction === "rtl" ? hit.x + hit.w : hit.x;
    drag = { box: hit, dx: point.x - pointX, dy: point.y - hit.y, moved: false };
    canvas.setPointerCapture(event.pointerId);
  }
});

canvas.addEventListener("pointermove", event => {
  if (!drag) return;
  const point = imagePoint(event);
  const nextX = Math.max(0, Math.min(canvas.width - drag.box.w, point.x - drag.dx));
  const nextY = Math.max(0, Math.min(canvas.height - drag.box.h, point.y - drag.dy));
  if (Math.abs(nextX - drag.box.x) > 1 || Math.abs(nextY - drag.box.y) > 1) drag.moved = true;
  drag.box.x = nextX;
  drag.box.y = nextY;
  if (drag.moved) drag.box.edited = true;
  render();
});
canvas.addEventListener("pointerup", () => { drag = null; updateActions(); });
canvas.addEventListener("pointercancel", () => { drag = null; updateActions(); });

$("downloadBtn").addEventListener("click", () => {
  if (!image.naturalWidth || !textBoxes.some(box => box.edited)) return;
  const output = document.createElement("canvas");
  output.width = image.naturalWidth;
  output.height = image.naturalHeight;
  const outputContext = output.getContext("2d");
  outputContext.drawImage(image, 0, 0);
  drawTextBoxes(outputContext, false);
  const link = document.createElement("a");
  link.download = "edited-image.png";
  link.href = output.toDataURL("image/png");
  link.click();
});

window.addEventListener("resize", fitCanvas);
updateActions();
syncControls();

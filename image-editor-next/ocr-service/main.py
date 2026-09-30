from __future__ import annotations

import re
import uuid
from functools import lru_cache
from typing import Any

import cv2
import numpy as np
import pytesseract
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from paddleocr import PaddleOCR
from pytesseract import Output

app = FastAPI(title="TypeStudio OCR", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=False,
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

MAX_IMAGE_BYTES = 18 * 1024 * 1024


@lru_cache(maxsize=3)
def get_ocr(language: str) -> PaddleOCR:
    """Keep CPU PaddleOCR engines warm between requests."""
    return PaddleOCR(use_angle_cls=True, lang=language, show_log=False)


def preprocess(image: np.ndarray) -> list[tuple[np.ndarray, float]]:
    """Return original and contrast-normalized images with scale back to source pixels."""
    height, width = image.shape[:2]
    scale = min(2.0, max(1.0, 1800 / max(height, width)))
    if scale > 1:
        enlarged = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    else:
        enlarged = image

    gray = cv2.cvtColor(enlarged, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    contrast = clahe.apply(gray)
    enhanced = cv2.cvtColor(contrast, cv2.COLOR_GRAY2BGR)
    return [(enlarged, scale), (enhanced, scale)]


def parse_legacy_result(result: Any) -> list[dict[str, Any]]:
    parsed: list[dict[str, Any]] = []
    if not result:
        return parsed
    pages = result if isinstance(result, list) else [result]
    for page in pages:
        if not isinstance(page, list):
            continue
        for row in page:
            if not isinstance(row, (list, tuple)) or len(row) < 2:
                continue
            polygon, recognition = row[0], row[1]
            if not isinstance(recognition, (list, tuple)) or len(recognition) < 2:
                continue
            points = np.asarray(polygon, dtype=np.float32).reshape(-1, 2)
            parsed.append({
                "text": str(recognition[0]).strip(),
                "confidence": float(recognition[1]) * 100,
                "x0": float(points[:, 0].min()), "y0": float(points[:, 1].min()),
                "x1": float(points[:, 0].max()), "y1": float(points[:, 1].max()),
            })
    return parsed


def split_to_word_boxes(item: dict[str, Any], inverse_scale: float) -> list[dict[str, Any]]:
    """Paddle returns text-line polygons in many configs; apportion line bounds into token boxes."""
    tokens = re.findall(r"[A-Za-z]+(?:['’][A-Za-z]+)*|[0-9]+(?:[.,:/-][0-9]+)*", item["text"])
    if not tokens:
        return []

    x0, x1 = item["x0"], item["x1"]
    y0, y1 = item["y0"], item["y1"]
    line_width = max(1.0, x1 - x0)
    lengths = [max(1, len(token)) for token in tokens]
    total = sum(lengths)
    gap = min(line_width * 0.04, max(1.0, line_width * 0.012)) if len(tokens) > 1 else 0.0
    available_width = max(1.0, line_width - gap * (len(tokens) - 1))
    rtl = False
    results: list[dict[str, Any]] = []
    offset = 0.0
    for token, length in zip(tokens, lengths):
        token_width = available_width * length / total
        left = x1 - offset - token_width if rtl else x0 + offset
        right = left + token_width
        results.append({
            "id": str(uuid.uuid4()), "text": token,
            "x": round(left * inverse_scale, 2), "y": round(y0 * inverse_scale, 2),
            "width": max(1.0, round(token_width * inverse_scale, 2)),
            "height": max(1.0, round((y1 - y0) * inverse_scale, 2)),
            "confidence": round(float(item["confidence"]), 1), "box_quality": 1,
            "direction": "rtl" if rtl else "ltr",
        })
        offset += token_width + gap
    return results


def parse_new_result(result: Any) -> list[dict[str, Any]]:
    parsed: list[dict[str, Any]] = []
    data = getattr(result, "json", result)
    if isinstance(data, dict) and isinstance(data.get("res"), dict):
        data = data["res"]
    if not isinstance(data, dict):
        return parsed
    texts = data.get("rec_texts", [])
    scores = data.get("rec_scores", [])
    polygons = data.get("dt_polys", data.get("rec_polys", []))
    for text, score, polygon in zip(texts, scores, polygons):
        points = np.asarray(polygon, dtype=np.float32).reshape(-1, 2)
        parsed.append({
            "text": str(text).strip(), "confidence": float(score) * 100,
            "x0": float(points[:, 0].min()), "y0": float(points[:, 1].min()),
            "x1": float(points[:, 0].max()), "y1": float(points[:, 1].max()),
        })
    return parsed


def run_engine(engine: PaddleOCR, image: np.ndarray) -> list[dict[str, Any]]:
    result = engine.ocr(image, cls=True)
    legacy = parse_legacy_result(result)
    if legacy:
        return legacy
    return [item for page in (result or []) for item in parse_new_result(page)]


def run_tesseract_words(image: np.ndarray, inverse_scale: float) -> list[dict[str, Any]]:
    result = pytesseract.image_to_data(
        image,
        lang="eng",
        config="--oem 1 --psm 11 -c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
        output_type=Output.DICT,
    )
    words: list[dict[str, Any]] = []
    for index, raw_text in enumerate(result.get("text", [])):
        text = str(raw_text).strip()
        try:
            confidence = float(result["conf"][index])
        except (ValueError, TypeError, IndexError):
            continue
        if not text or confidence < 0:
            continue
        x0, y0 = int(result["left"][index]), int(result["top"][index])
        width, height = int(result["width"][index]), int(result["height"][index])
        tokens = re.findall(r"[A-Za-z]+(?:['’][A-Za-z]+)*|[0-9]+(?:[.,:/-][0-9]+)*", text)
        if not tokens:
            continue
        token_lengths = [max(1, len(token)) for token in tokens]
        total_length = sum(token_lengths)
        offset = 0.0
        for token, token_length in zip(tokens, token_lengths):
            token_width = width * token_length / total_length
            token_left = x0 + offset
            words.append({
                "id": str(uuid.uuid4()), "text": token,
                "x": round(token_left * inverse_scale, 2), "y": round(y0 * inverse_scale, 2),
                "width": max(1.0, round(token_width * inverse_scale, 2)),
                "height": max(1.0, round(height * inverse_scale, 2)),
                "confidence": round(confidence, 1), "direction": "ltr", "box_quality": 2,
            })
            offset += token_width
    return words


def deduplicate_words(words: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep the higher-confidence recognition when two OCR engines cover the same token."""
    unique: list[dict[str, Any]] = []
    for word in words:
        duplicate = None
        for existing in unique:
            overlap_w = max(0.0, min(word["x"] + word["width"], existing["x"] + existing["width"]) - max(word["x"], existing["x"]))
            overlap_h = max(0.0, min(word["y"] + word["height"], existing["y"] + existing["height"]) - max(word["y"], existing["y"]))
            intersection = overlap_w * overlap_h
            smaller_area = min(word["width"] * word["height"], existing["width"] * existing["height"])
            if smaller_area > 0 and intersection / smaller_area >= 0.55:
                duplicate = existing
                break
        if duplicate is None:
            unique.append(word)
        elif (word.get("box_quality", 0), word["confidence"]) > (duplicate.get("box_quality", 0), duplicate["confidence"]):
            unique[unique.index(duplicate)] = word
    return sorted(unique, key=lambda item: (item["y"], item["x"]))


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "engine": "PaddleOCR + OpenCV"}


@app.post("/ocr")
async def recognize(image: UploadFile = File(...), language: str = Form("en")) -> dict[str, Any]:
    if not image.content_type or not image.content_type.startswith("image/"):
        raise HTTPException(status_code=415, detail="Upload a supported image file.")
    contents = await image.read(MAX_IMAGE_BYTES + 1)
    if len(contents) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Image is too large. Limit is 18 MB.")

    buffer = np.frombuffer(contents, dtype=np.uint8)
    decoded = cv2.imdecode(buffer, cv2.IMREAD_COLOR)
    if decoded is None:
        raise HTTPException(status_code=400, detail="Could not decode this image.")

    requested = [part.strip().lower() for part in language.split("+") if part.strip()]
    languages = list(dict.fromkeys(requested))
    if languages != ["en"]:
        raise HTTPException(status_code=400, detail="Only English letters and numbers are supported for OCR.")

    candidates: list[dict[str, Any]] = []
    errors: list[str] = []
    primary_image, primary_scale = preprocess(decoded)[0]
    try:
        candidates.extend(run_tesseract_words(primary_image, 1 / primary_scale))
    except Exception as exc:
        errors.append(f"Tesseract word pass: {exc}")

    for lang in languages:
        try:
            engine = get_ocr(lang)
            for prepared, scale in preprocess(decoded):
                for item in run_engine(engine, prepared):
                    candidates.extend(split_to_word_boxes(item, 1 / scale))
        except Exception as exc:  # model files download on first run; unsupported model names surface as service errors
            errors.append(f"{lang}: {exc}")

    return {"words": deduplicate_words(candidates), "languages": languages, "warnings": errors}

# TypeStudio OCR API

Local FastAPI service used by the Next.js editor. It applies OpenCV resizing/contrast normalization, then runs PaddleOCR and emits word-level selection boxes with confidence values.

## Setup

Use Python 3.10 or 3.11 and install Tesseract OCR with English (`eng`) traineddata. The supplied Dockerfile includes this system package. OCR recognizes English letters and ASCII digits only; Arabic and other scripts are ignored and remain untouched in the source image. For a local Windows install, install Tesseract and add its `tesseract.exe` to PATH, then install the packages in `requirements.txt` inside a virtual environment and run:

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn main:app --host 127.0.0.1 --port 8001
```

PaddleOCR downloads its English model weights the first time it is used; allow an internet connection for initial startup. CPU inference is used by default. Tesseract and PaddleOCR results are filtered to ASCII letters and digits before they are returned.

PaddleOCR detector polygons can cover a text line rather than true glyph contours; when no Tesseract word box overlaps, multi-word lines are divided into approximate word boxes. Review OCR boxes on difficult scans.

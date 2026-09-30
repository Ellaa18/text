# TypeStudio

Next.js App Router + TypeScript + Fabric.js editor with a separate Python FastAPI OCR service (PaddleOCR + OpenCV).

## Local setup

1. Install Node.js 20.9+ and Python 3.10 or 3.11.
2. Run `npm install` in this folder.
3. Keep the supplied `v.jpg` in `public/v.jpg` (already copied for this project).
4. Start the API using the steps in `ocr-service/README.md` on port 8001.
5. Run `npm run dev` and open `http://localhost:3000`.

The Next.js `/api/ocr` route forwards image uploads to `http://127.0.0.1:8001/ocr`. For deployment, publish the Python service separately and set `OCR_SERVICE_URL` to its HTTPS base URL in the Next.js hosting settings. `ocr-service/Dockerfile` is provided for container hosting; Vercel hosts the Next.js frontend, not the full PaddleOCR/OpenCV model runtime.

## Docker setup

With Docker Desktop installed, run `docker compose up --build` from this folder, then open `http://localhost:3000`. The OCR container downloads model weights on the first OCR request, so allow time and internet access for its first use.

## Editor behavior

OCR recognizes English words and numbers only, placing each detected token in its own editable box. Arabic and other scripts are not selectable or edited by OCR and remain part of the original image. Replacements are bold by default, with a regular-weight option. Changes appear on the Fabric canvas while typing; use the size `−`/`+` buttons or Fit action when a replacement does not fit. Save a copy as PNG or JPEG. The source image is never overwritten.

OCR model and word-box quality depend on image quality. Validate every edit before exporting.

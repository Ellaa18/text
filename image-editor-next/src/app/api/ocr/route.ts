import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const incoming = await request.formData();
    const image = incoming.get("image");
    if (!(image instanceof File)) {
      return NextResponse.json({ error: "Choose an image file before running OCR." }, { status: 400 });
    }

    const forwarded = new FormData();
    forwarded.append("image", image, image.name || "upload-image");
    forwarded.append("language", "en");
    const endpoint = `${process.env.OCR_SERVICE_URL ?? "http://127.0.0.1:8001"}/ocr`;
    const response = await fetch(endpoint, { method: "POST", body: forwarded, cache: "no-store", signal: AbortSignal.timeout(240_000) });
    const body = await response.json().catch(() => ({ error: "The OCR service returned an invalid response." }));
    return NextResponse.json(body, { status: response.status });
  } catch (error) {
    const message = error instanceof Error && error.name === "TimeoutError"
      ? "OCR timed out. Try a smaller or clearer image."
      : "Cannot reach the Python OCR service. Start it on port 8001 and retry.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}

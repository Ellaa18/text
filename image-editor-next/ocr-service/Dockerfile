FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PADDLE_HOME=/opt/paddle

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgomp1 libgl1 libglib2.0-0 tesseract-ocr \
    tesseract-ocr-eng && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY main.py .
EXPOSE 8001
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001"]
